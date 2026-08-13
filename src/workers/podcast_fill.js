// ============================================================================
// LẤP NỀN HÌNH CHO DỰ ÁN PODCAST
//
//   node src/workers/podcast_fill.js --postId 727 --mode random [--maxClip 20]
//   node src/workers/podcast_fill.js --postId 727 --mode single --name <file trong kho>
//
// Podcast chỉ có tiếng, không cào được hình, nên hình lấy từ KHO dùng chung
// (MEDIA_DIR/_podcast_videos). Hai kiểu lấp:
//
//   random : bốc ngẫu nhiên clip trong kho, nối nhau cho hết lời đọc. Clip dài hơn
//            --maxClip (mặc định 20s) thì chỉ phát bấy nhiêu giây, ngắn hơn giữ nguyên.
//   single : một ảnh/video được chỉ định, xuất hiện XUYÊN SUỐT. Ảnh thì mỗi cảnh 1 tấm
//            trải hết cảnh; video ngắn hơn cảnh thì lặp lại cho kín (không đứng hình).
//
// KHÔNG chép file: mỗi lần dùng tạo một HARDLINK trong thư mục dự án. Kho toàn clip 4K,
// một podcast 33 phút cần cả trăm clip — chép thật là mất vài GB mỗi dự án. Hardlink dùng
// chung đúng khối dữ liệu đó, mà xoá bên dự án cũng không đụng tới file gốc trong kho.
// Máy nào không hardlink được (khác phân vùng) thì tự chép lại.
//
// Ghi thẳng vào Asset (selected/order/duration) như mọi thể loại khác -> export CapCut
// không phải sửa gì.
// ============================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import pLimit from 'p-limit';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const execFile = promisify(execFileCb);
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const LIB_DIR = path.join(MEDIA_DIR, '_podcast_videos');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
// Tiền tố file do worker này tạo — chạy lại thì dọn đúng những cái nó tự sinh, chừa media
// người dùng tự bỏ vào cảnh.
const PREFIX = 'podcast_bg_';
const MIN_SLOT = 1.5;                                   // đừng để clip chớp nhoáng dưới ngần này
const EST_CHARS_PER_SEC = Number(process.env.AUTOSEL_CHARS_PER_SEC || 14);

const r1 = v => Math.round(v * 10) / 10;
const sum = a => a.reduce((s, x) => s + x, 0);

function parseArgs() {
    const a = process.argv.slice(2);
    const get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
    return {
        postId: get('--postId'),
        mode: get('--mode') || 'random',
        name: get('--name'),
        maxClip: Number(get('--maxClip') || 20),
        force: a.includes('--force'),
    };
}

function ffprobeDuration(file) {
    try {
        const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8', timeout: 30000 });
        const d = parseFloat(out.trim());
        return Number.isFinite(d) && d > 0 ? d : 0;
    } catch (_) { return 0; }
}

// Đo mp3 giọng đọc (link ttsmin) — tải về tạm rồi ffprobe, giống capcut_export.
async function remoteAudioDuration(url) {
    if (!url) return 0;
    const base = process.env.BUNNYCDN_BASE_URL || '', key = process.env.BUNNYCDN_ACCESS_KEY || '';
    const full = url.startsWith('http') ? url : `${base}/${url}`;
    const tmp = path.join(os.tmpdir(), `podfill_${process.pid}_${Math.random().toString(36).slice(2)}.mp3`);
    try {
        await execFile('curl', ['-sL', '--retry', '2', '--max-time', '30', '-H', `AccessKey: ${key}`, full, '-o', tmp],
            { timeout: 45000 });
        if (!(fs.existsSync(tmp) && fs.statSync(tmp).size > 1000)) return 0;
        return ffprobeDuration(tmp);
    } catch (_) { return 0; }
    finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// Mốc SRT gốc: cảnh -> [đầu, cuối]
function readSrtSpans(projectId) {
    const file = path.join(MEDIA_DIR, projectId, 'srt_timing.json');
    if (!fs.existsSync(file)) return null;
    try {
        const spans = new Map();
        for (const c of (JSON.parse(fs.readFileSync(file, 'utf8')).cues || [])) {
            const scene = Number(c.scene ?? c.order), s = Number(c.start), e = Number(c.end);
            if (!Number.isFinite(scene) || !Number.isFinite(s) || !Number.isFinite(e)) continue;
            const cur = spans.get(scene);
            spans.set(scene, cur ? [Math.min(cur[0], s), Math.max(cur[1], e)] : [s, e]);
        }
        return spans.size ? spans : null;
    } catch (_) { return null; }
}

// Số giây mỗi cảnh cần lấp. GIỌNG ĐỌC THẬT được ưu tiên hơn mốc SRT: export CapCut dựng
// timeline theo độ dài mp3, đọc nhanh/chậm khác bản SRT gốc là hình lệch ngay.
async function sceneNeeds(db, post, paras) {
    const isVi = (post.voice_content_type || 'content_vi') === 'content_vi';
    const af = isVi ? 'content_vi_audio' : 'content_audio', afAlt = isVi ? 'content_audio' : 'content_vi_audio';
    const tx = isVi ? 'content_vi' : 'content', txAlt = isVi ? 'content' : 'content_vi';
    const spans = readSrtSpans(post.project_id) || readSrtSpans(post.project_id.replace(/_[a-z]{2}$/, ''));

    const rows = new Map();
    const urls = new Map();
    for (const p of paras) {
        const det = await db.all(
            `SELECT ${af} AS audio, ${afAlt} AS audioAlt, ${tx} AS text, ${txAlt} AS textAlt
             FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"`, [p.id]);
        rows.set(p.id, det);
        for (const d of det) { const u = d.audio || d.audioAlt; if (u) urls.set(u, 0); }
    }
    if (urls.size) {
        console.log(`[podcast_fill] đo ${urls.size} file giọng đọc...`);
        const limit = pLimit(8);
        await Promise.all([...urls.keys()].map(u => limit(async () => urls.set(u, await remoteAudioDuration(u)))));
    }
    const needs = new Map();
    for (const p of paras) {
        const det = rows.get(p.id) || [];
        const total = sum(det.map(d => urls.get(d.audio || d.audioAlt) || 0));
        if (total > 0) { needs.set(p.id, total); continue; }
        const span = spans?.get(Number(p.order));
        if (span) { needs.set(p.id, Math.max(0, span[1] - span[0])); continue; }
        const chars = sum(det.map(d => String(d.text || d.textAlt || '').length));
        needs.set(p.id, chars ? chars / EST_CHARS_PER_SEC : 0);
    }
    return needs;
}

function libraryItems() {
    if (!fs.existsSync(LIB_DIR)) return [];
    return fs.readdirSync(LIB_DIR, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => ({ name: e.name, ext: path.extname(e.name).toLowerCase() }))
        .filter(x => VIDEO_EXTS.has(x.ext) || IMAGE_EXTS.has(x.ext))
        .map(x => ({ ...x, type: VIDEO_EXTS.has(x.ext) ? 'video' : 'image', abs: path.join(LIB_DIR, x.name) }));
}

// Hardlink cho nhẹ đĩa; khác phân vùng thì chép. Trả đường dẫn TƯƠNG ĐỐI so với MEDIA_DIR.
function linkIntoProject(srcAbs, projectId, gid, type, index) {
    const sub = type === 'video' ? '_raw_videos' : '_raw_images';
    const dir = path.join(MEDIA_DIR, projectId, 'assets', sub, String(gid));
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${PREFIX}${gid}_${index}${path.extname(srcAbs).toLowerCase()}`);
    try { fs.unlinkSync(dest); } catch (_) {}
    try { fs.linkSync(srcAbs, dest); }
    catch (_) { fs.copyFileSync(srcAbs, dest); }
    return path.relative(MEDIA_DIR, dest);
}

// Xoá sạch nền của lần chạy trước (cả bản ghi lẫn file hardlink), chừa media người dùng tự thêm.
async function clearPrevious(db, post) {
    const rows = await db.all(
        `SELECT id, file_path FROM Asset
         WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?) AND file_path LIKE ?`,
        [post.id, `%/${PREFIX}%`]);
    for (const r of rows) {
        try { fs.unlinkSync(path.join(MEDIA_DIR, r.file_path)); } catch (_) {}
        await db.run('DELETE FROM Asset WHERE id = ?', [r.id]);
    }
    return rows.length;
}

// Trộn danh sách rồi phát lần lượt; hết một vòng mới trộn lại -> không lặp clip khi kho còn dư.
function shuffledQueue(items) {
    let bag = [];
    const refill = () => {
        bag = items.slice();
        for (let i = bag.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [bag[i], bag[j]] = [bag[j], bag[i]];
        }
    };
    return () => { if (!bag.length) refill(); return bag.pop(); };
}

async function main() {
    const args = parseArgs();
    const db = await getDb();
    const post = await db.get('SELECT id, project_id, genre, voice_content_type FROM Post WHERE id = ?', [args.postId]);
    if (!post) { console.error('[podcast_fill] không tìm thấy post'); process.exit(1); }

    const lib = libraryItems();
    if (!lib.length) { console.error(`[podcast_fill] kho trống (${LIB_DIR})`); process.exit(1); }

    let chosen = null;
    if (args.mode === 'single') {
        chosen = lib.find(x => x.name === args.name);
        if (!chosen) { console.error(`[podcast_fill] không thấy '${args.name}' trong kho`); process.exit(1); }
    }
    const videos = lib.filter(x => x.type === 'video');
    if (args.mode === 'random' && !videos.length) { console.error('[podcast_fill] kho chưa có video nào'); process.exit(1); }

    console.log(`[podcast_fill] post ${post.id} (${post.project_id}) — mode=${args.mode}`
        + (chosen ? ` "${chosen.name}" (${chosen.type})` : ` | kho ${videos.length} video, mỗi clip tối đa ${args.maxClip}s`));

    const paras = await db.all('SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY "order", id', [post.id]);
    if (!paras.length) { console.error('[podcast_fill] dự án chưa có cảnh nào'); process.exit(1); }

    const cleared = await clearPrevious(db, post);
    if (cleared) console.log(`[podcast_fill] dọn ${cleared} clip nền của lần chạy trước`);

    const needs = await sceneNeeds(db, post, paras);
    const durCache = new Map();
    const durOf = (item) => {
        if (item.type === 'image') return 0;
        if (!durCache.has(item.name)) durCache.set(item.name, ffprobeDuration(item.abs));
        return durCache.get(item.name);
    };
    const nextRandom = shuffledQueue(videos);

    let totalClips = 0, skipped = 0;
    for (const para of paras) {
        const gid = String(para.order);
        const need = needs.get(para.id) || 0;

        // Cảnh người dùng đã tự chọn media -> để yên (trừ khi --force), khỏi chồng hình lên nhau.
        const manual = await db.get(
            'SELECT COUNT(*) c FROM Asset WHERE paragraph_id = ? AND selected = 1 AND file_path NOT LIKE ?',
            [para.id, `%/${PREFIX}%`]);
        if (manual.c && !args.force) { skipped++; continue; }

        const picks = [];
        if (chosen?.type === 'image') {
            picks.push({ item: chosen, slot: need > 0 ? need : 5 });
        } else {
            let remain = need > 0 ? need : 0;
            let guard = 0;
            do {
                const item = chosen || nextRandom();
                const dur = durOf(item) || args.maxClip;
                // random: cắt còn tối đa maxClip. single: dùng trọn clip rồi lặp lại cho kín cảnh.
                const cap = args.mode === 'random' ? Math.min(dur, args.maxClip) : dur;
                const slot = remain > 0 ? Math.min(cap, remain) : cap;
                if (slot < MIN_SLOT && picks.length) break;      // mẩu thừa quá ngắn -> thôi
                picks.push({ item, slot: Math.max(slot, MIN_SLOT) });
                remain -= slot;
            } while (remain > 0.05 && ++guard < 500);
        }

        for (const [i, p] of picks.entries()) {
            const rel = linkIntoProject(p.item.abs, post.project_id, gid, p.item.type, i + 1);
            await db.run(
                `INSERT INTO Asset (paragraph_id, sentence_id, type, file_path, selected, auto, "order", duration)
                 VALUES (?, NULL, ?, ?, 1, 1, ?, ?)`,
                [para.id, p.item.type, rel, i + 1, r1(p.slot)]);
        }
        totalClips += picks.length;
        console.log(`[podcast_fill]   cảnh ${gid}: cần ${r1(need)}s → ${picks.length} clip (${r1(sum(picks.map(p => p.slot)))}s)`);
    }

    if (skipped) console.log(`[podcast_fill] bỏ qua ${skipped} cảnh đã có media chọn tay (dùng --force để ghi đè)`);
    console.log(`[podcast_fill] ✅ lấp ${totalClips} clip cho ${paras.length - skipped} cảnh`);
    await db.close();
}

main().catch(e => { console.error('[podcast_fill] lỗi:', e.message); process.exit(1); });
