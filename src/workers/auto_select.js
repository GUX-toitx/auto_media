// ============================================================================
// TỰ CHỌN ẢNH/VIDEO CHO TỪNG CẢNH
//
//   node src/workers/auto_select.js --postId 720 [--scope all|missing] [--force] [--dry]
//
// Thay cho việc ngồi lướt 40-250 thumbnail mỗi cảnh: lọc rác -> chấm điểm hợp cảnh bằng
// CLIP/SigLIP chạy tại chỗ trên GPU (src/workers/media_score.py, không tốn API) -> chọn đủ
// lấp thời lượng lời đọc -> ghi selected/order/duration đúng schema cũ, export CapCut không đổi.
//
// Đánh dấu auto=1 cho asset do máy chọn:
//   • chạy lại chỉ ghi đè lựa chọn của MÁY, không đụng cái người đã chọn tay (trừ khi --force)
//   • UI gắn nhãn "AI chọn" để người duyệt lại cho nhanh thay vì chọn từ đầu
//
// Ba nguồn "cảnh cần bao nhiêu giây", theo thứ tự tin cậy:
//   1. srt_timing.json  — thể loại dựng từ SRT (sport/podcast/naze), mốc chính xác tuyệt đối
//   2. ffprobe audio    — cộng độ dài mp3 thật của từng câu (geo/drama), cache ra file vì link
//                         ttsmin hết hạn nhanh, chạy lại vài hôm sau là tải không được nữa
//   3. ước lượng theo số ký tự — chỉ khi hai cách trên đều không có; có log cảnh báo
// ============================================================================
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import pLimit from 'p-limit';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'url';

const execFile = promisify(execFileCb);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY = process.env.MEDIA_SCORE_PYTHON || path.join(ROOT, '.venv-whisperx', 'bin', 'python');
const SCORER = path.join(ROOT, 'src', 'workers', 'media_score.py');
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

const num = (k, d) => Number(process.env[k] ?? d);
// --- Nhịp dựng: bao lâu thì đổi hình, video được cắt trong khoảng nào ---
const IMG_SEC = num('AUTOSEL_IMG_SEC', 4);          // thời lượng mục tiêu cho 1 ảnh
const IMG_MIN = num('AUTOSEL_IMG_MIN', 2.5);        // ngắn hơn nữa thì nháy hình, chóng mặt
const IMG_MAX = num('AUTOSEL_IMG_MAX', 6);          // dài hơn nữa thì ảnh tĩnh nằm ì, xem chán
const CLIP_MIN = num('AUTOSEL_CLIP_MIN', 3);
const CLIP_MAX = num('AUTOSEL_CLIP_MAX', 8);        // cắt video dài về tối đa bấy nhiêu giây
const HARD_MAX_ITEMS = num('AUTOSEL_MAX_ITEMS', 40);   // chốt chặn an toàn, không phải nhịp mong muốn
// --- Lọc cứng: cái gì không lấp nổi khung 16:9 thì loại trước khi chấm điểm ---
const MIN_W = num('AUTOSEL_MIN_W', 1000);           // ảnh hẹp hơn -> phóng lên là vỡ
const MIN_RATIO = num('AUTOSEL_MIN_RATIO', 1.2);    // ảnh dọc/vuông -> loại (khung ngang)
const VID_MIN_SEC = num('AUTOSEL_VID_MIN_SEC', 2);
const VID_MIN_W = num('AUTOSEL_VID_MIN_W', 640);
// --- Trọng số cộng thêm, tính TRÊN điểm đã chuẩn hoá về [0,1] trong từng cảnh ---
const W_VIDEO = num('AUTOSEL_W_VIDEO', 0.08);       // video có chuyển động -> nhỉnh hơn ảnh tĩnh
const W_SOURCE = num('AUTOSEL_W_SOURCE', 0.05);     // ảnh từ bài báo/X (có source_url) > ảnh stock
const W_RES = num('AUTOSEL_W_RES', 0.03);           // ảnh >= full HD
const EST_CHARS_PER_SEC = num('AUTOSEL_CHARS_PER_SEC', 14);   // chỉ dùng cho ước lượng chống cháy

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sum = a => a.reduce((s, x) => s + x, 0);
const r1 = v => Math.round(v * 10) / 10;

// Text mô tả 1 cảnh để đối chiếu với ảnh. KEYWORD là tín hiệu mạnh nhất (ngắn, đúng thứ cần thấy trên
// hình), còn lời thoại chỉ lấy vài câu đầu và cắt ngắn: bộ mã hoá text chỉ nhìn 64 token, nhồi cả đoạn
// narration vào chỉ làm loãng, mà phần lớn câu chữ ("theo tôi thì...") vốn không tả được thành hình.
function sceneTexts(title, keywords, units) {
    return [
        title,
        ...(keywords || []).slice(0, 8),
        ...(units || []).slice(0, 4).map(u => String(u.text || u.textAlt || '').slice(0, 300)),
    ].map(t => String(t || '').trim()).filter(Boolean);
}

function parseArgs() {
    const a = process.argv.slice(2);
    const get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
    return {
        postId: get('--postId'),
        projectId: get('--projectId'),
        scope: get('--scope') || 'missing',      // missing = bỏ qua cảnh người đã tự chọn
        force: a.includes('--force'),            // ghi đè cả lựa chọn TAY
        dry: a.includes('--dry'),
    };
}

// ---------------------------------------------------------------------------
// Thời lượng
// ---------------------------------------------------------------------------
function ffprobeDuration(file) {
    try {
        const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8', timeout: 30000 });
        const d = parseFloat(out.trim());
        return Number.isFinite(d) && d > 0 ? d : 0;
    } catch (_) { return 0; }
}

// Tải audio ttsmin về tạm rồi đo (đúng cách capcut_export làm) — đo thẳng qua URL hay đứt giữa chừng.
// Bất đồng bộ để còn đo song song: bài drama có tới 140 cảnh, đo tuần tự là ngồi chờ vài phút.
async function remoteAudioDuration(url) {
    if (!url) return 0;
    const base = process.env.BUNNYCDN_BASE_URL || '', key = process.env.BUNNYCDN_ACCESS_KEY || '';
    const full = url.startsWith('http') ? url : `${base}/${url}`;
    const tmp = path.join(os.tmpdir(), `autosel_${process.pid}_${Math.random().toString(36).slice(2)}.mp3`);
    try {
        await execFile('curl', ['-sL', '--retry', '2', '--retry-delay', '1', '--max-time', '30',
            '-H', `AccessKey: ${key}`, full, '-o', tmp], { timeout: 45000 });
        if (!(fs.existsSync(tmp) && fs.statSync(tmp).size > 1000)) return 0;
        return ffprobeDuration(tmp);
    } catch (_) { return 0; }
    finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

// Điền số giây lời đọc cho mọi cảnh.
// Thứ tự tin cậy: ĐO MP3 THẬT > mốc SRT gốc > ước lượng theo số ký tự.
// Giọng đọc đứng trước mốc SRT vì export CapCut dựng timeline theo độ dài mp3: TTS đọc nhanh/chậm
// khác bản SRT gốc là hình lấp theo SRT sẽ hụt hoặc thừa so với tiếng.
// CHỈ CACHE giá trị đo từ mp3 — link ttsmin hết hạn nhanh nên phải nhớ; còn mốc SRT/ước lượng thì
// tính lại tức thì, mà nhớ chúng lại hoá dở: lấp trước khi có voice là kẹt luôn số cũ về sau.
async function fillNeeds(scenes, spans, cache) {
    const toProbe = new Map();
    for (const s of scenes) {
        if (cache[s.key] > 0) { s.need = cache[s.key]; continue; }
        for (const u of s.units) { const url = u.audio || u.audioAlt; if (url) toProbe.set(url, 0); }
    }
    if (toProbe.size) {
        console.log(`[auto_select] đo ${toProbe.size} file audio để biết mỗi cảnh dài bao nhiêu...`);
        const limit = pLimit(8);
        await Promise.all([...toProbe.keys()].map(url =>
            limit(async () => toProbe.set(url, await remoteAudioDuration(url)))));
    }
    for (const s of scenes) {
        if (s.need != null) continue;
        let total = 0, probed = 0;
        for (const u of s.units) {
            const d = toProbe.get(u.audio || u.audioAlt) || 0;
            if (d > 0) { total += d; probed++; }
        }
        if (probed) { s.need = cache[s.key] = total; continue; }
        if (spans && s.srtScene != null && spans.has(s.srtScene)) {
            const [a, b] = spans.get(s.srtScene);
            s.need = Math.max(0, b - a);
            continue;
        }
        // Chưa tạo voice / link mp3 hết hạn: ước lượng thô theo số ký tự, chỉ để có cái mà chia nhịp.
        const chars = sum(s.units.map(u => String(u.text || u.textAlt || '').length));
        s.need = chars ? chars / EST_CHARS_PER_SEC : 0;
    }
}

// Mốc thời gian từ srt_timing.json: cảnh -> [đầu, cuối] (khớp cách /api/srt-timing đọc file này).
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

// ---------------------------------------------------------------------------
// Dựng danh sách CẢNH — cùng thứ tự và cùng cách gom media như capcut_export.js
//   • section hook/summary/conclusion : pool riêng theo post_id + section
//   • mỗi luận điểm                   : pool DÙNG CHUNG cho luận điểm và mọi luận cứ con của nó
//                                       (crawl gắn media vào paragraph, người chọn mới tách xuống câu)
// ---------------------------------------------------------------------------
async function buildGroups(db, post, narrCache) {
    const isVi = (post.voice_content_type || 'content_vi') === 'content_vi';
    const af = isVi ? 'content_vi_audio' : 'content_audio', afAlt = isVi ? 'content_audio' : 'content_vi_audio';
    const tf = isVi ? 'title_vi_audio' : 'title_audio', tfAlt = isVi ? 'title_audio' : 'title_vi_audio';
    const tx = isVi ? 'content_vi' : 'content', txAlt = isVi ? 'content' : 'content_vi';
    const spans = readSrtSpans((post.project_id || '').replace(/_[a-z]{2}$/, '')) || readSrtSpans(post.project_id);

    const groups = [];

    // --- Các section (mở bài / tóm tắt / kết bài) ---
    for (const [table, section] of [['HookDetail', 'hook'], ['SummaryDetail', 'summary'], ['ConclusionDetail', 'conclusion']]) {
        const rows = await db.all(
            `SELECT ${tx} AS text, ${txAlt} AS textAlt, ${af} AS audio, ${afAlt} AS audioAlt FROM ${table} WHERE post_id = ? ORDER BY "order"`,
            [post.id]);
        const units = rows.filter(r => r.audio || r.audioAlt || r.text);
        if (!units.length) continue;
        const kws = await db.all('SELECT content FROM Keyword WHERE post_id = ? AND section = ?', [post.id, section]);
        // KHÔNG bỏ cảnh chỉ vì pool riêng rỗng: drama không có media cấp cảnh nào cả, mọi thứ nằm
        // ở rổ chung section='x' và được điều sang ở lượt 2.
        const pool = await db.all(
            'SELECT id, type, file_path, duration, source_url, selected, auto FROM Asset WHERE post_id = ? AND section = ? ORDER BY id',
            [post.id, section]);
        groups.push({
            label: section,
            pool,
            reset: {
                set: 'selected = 0, "order" = 0, auto = 0',
                where: 'post_id = ? AND section = ?',
                args: [post.id, section],
            },
            scenes: [{
                key: `section:${section}`,
                label: section,
                texts: sceneTexts(null, kws.map(k => k.content), units),
                units, srtScene: null,
                owner: { kind: 'section', section },
            }],
        });
    }

    // --- Từng luận điểm: 1 pool, nhiều cảnh con (bản thân luận điểm + từng luận cứ) ---
    const paras = await db.all(
        `SELECT id, "order", title, title_vi, ${tf} AS titleAudio, ${tfAlt} AS titleAudioAlt FROM Paragraph WHERE post_id = ? ORDER BY id`,
        [post.id]);
    for (const [pi, para] of paras.entries()) {
        const pool = await db.all(
            `SELECT id, type, file_path, duration, source_url, selected, auto FROM Asset
             WHERE paragraph_id = ? OR sentence_id IN (SELECT id FROM Sentence WHERE paragraph_id = ?) ORDER BY id`,
            [para.id, para.id]);
        const kws = (await db.all('SELECT content FROM Keyword WHERE paragraph_id = ?', [para.id])).map(k => k.content);
        const scenes = [];

        const pd = await db.all(
            `SELECT ${tx} AS text, ${txAlt} AS textAlt, ${af} AS audio, ${afAlt} AS audioAlt FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"`,
            [para.id]);
        const ownUnits = [];
        if (para.titleAudio || para.titleAudioAlt || para.title || para.title_vi)
            ownUnits.push({ text: para.title_vi || para.title, audio: para.titleAudio, audioAlt: para.titleAudioAlt });
        ownUnits.push(...pd);
        if (ownUnits.length) scenes.push({
            key: `para:${para.id}`,
            label: `#${pi + 1}`,
            texts: sceneTexts(para.title || para.title_vi, kws, pd),
            units: ownUnits,
            // srt_timing đánh số cảnh theo Paragraph."order" (đúng cách /api/srt-timing tra cứu)
            srtScene: Number(para.order),
            owner: { kind: 'para', paragraphId: para.id },
        });

        const sents = await db.all('SELECT id, title, title_vi FROM Sentence WHERE paragraph_id = ? ORDER BY "order"', [para.id]);
        for (const [si, s] of sents.entries()) {
            const sd = await db.all(
                `SELECT ${tx} AS text, ${txAlt} AS textAlt, ${af} AS audio, ${afAlt} AS audioAlt FROM SentenceDetail WHERE sentence_id = ? ORDER BY "order"`,
                [s.id]);
            if (!sd.length && !s.title && !s.title_vi) continue;
            const sKws = (await db.all('SELECT content FROM Keyword WHERE sentence_id = ?', [s.id]).catch(() => [])).map(k => k.content);
            scenes.push({
                key: `sent:${s.id}`,
                label: `#${pi + 1}.${si + 1}`,
                texts: sceneTexts(s.title || s.title_vi, sKws.length ? sKws : kws, sd),
                units: sd, srtScene: null,
                owner: { kind: 'sent', sentenceId: s.id, paragraphId: para.id },
            });
        }
        if (!scenes.length) continue;
        groups.push({
            label: `luận điểm #${pi + 1}`,
            pool,
            // Bỏ chọn = trả asset về pool của luận điểm (giống hệt /api/toggle khi unselect)
            reset: {
                set: 'selected = 0, "order" = 0, auto = 0, sentence_id = NULL, paragraph_id = ?',
                where: 'paragraph_id = ? OR sentence_id IN (SELECT id FROM Sentence WHERE paragraph_id = ?)',
                args: [para.id, para.id, para.id],
            },
            scenes,
        });
    }

    // Rổ CHUNG của cả dự án: drama cào X về section='x' rồi người dùng tự điều sang từng cảnh
    // (export không dựng cảnh nào từ section này). Mọi cảnh đều được lấy ở đây.
    const xPool = await db.all(
        `SELECT id, type, file_path, duration, source_url, selected, auto, section FROM Asset
         WHERE post_id = ? AND section = 'x' ORDER BY id`, [post.id]);

    await fillNeeds(groups.flatMap(g => g.scenes), spans, narrCache);
    return { groups, xPool };
}

// ---------------------------------------------------------------------------
// Chấm điểm: cắt frame cho video rồi đẩy cả mẻ sang media_score.py
// ---------------------------------------------------------------------------
function videoFrames(absPath, dur, tmpDir) {
    const out = [];
    for (const [i, frac] of [0.15, 0.5, 0.85].entries()) {
        const dest = path.join(tmpDir, `f_${path.basename(absPath).replace(/\W/g, '')}_${i}.jpg`);
        try {
            execFileSync('ffmpeg', ['-v', 'error', '-ss', String(r1((dur || 4) * frac)), '-i', absPath,
                '-frames:v', '1', '-q:v', '4', '-y', dest], { timeout: 30000 });
            if (fs.existsSync(dest) && fs.statSync(dest).size > 500) out.push(dest);
        } catch (_) { /* frame hỏng thì bỏ, còn frame khác */ }
    }
    return out;
}

function runScorer(job) {
    return new Promise((resolve, reject) => {
        const proc = spawn(PY, [SCORER], { cwd: ROOT });
        let out = '', err = '';
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', d => { err += d; process.stderr.write(`[media_score] ${d}`); });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) return reject(new Error(`media_score.py exit ${code}: ${err.slice(-500)}`));
            try { resolve(JSON.parse(out)); }
            catch (e) { reject(new Error(`đọc kết quả chấm điểm lỗi: ${e.message} | ${out.slice(0, 200)}`)); }
        });
        proc.stdin.write(JSON.stringify(job));
        proc.stdin.end();
    });
}

// ---------------------------------------------------------------------------
// Chọn cho 1 cảnh
// ---------------------------------------------------------------------------
// Hạng chất lượng: 0 = lấp đầy khung 16:9 ngon lành, số càng lớn càng phải chống chế.
// KHÔNG loại thẳng ảnh xấu — dự án ít media (drama chỉ có mấy chục ảnh X cho vài chục cảnh) mà loại
// cứng là cảnh trắng hình. Xếp xuống hạng dưới thì ảnh tốt vẫn luôn được lấy trước.
function qualityTier(c) {
    if (c.type === 'video') return (c.realDur >= VID_MIN_SEC && (c.w || 0) >= VID_MIN_W) ? 0 : 2;
    const ratio = (c.w > 0 && c.h > 0) ? c.w / c.h : 0;
    if ((c.w || 0) >= MIN_W && ratio >= MIN_RATIO) return 0;
    if ((c.w || 0) >= MIN_W) return 1;                   // đủ nét nhưng dọc/vuông -> phải crop nhiều
    return 2;                                            // nhỏ, phóng lên là vỡ
}

function rank(cands) {
    const scores = cands.map(c => c.score);
    const lo = Math.min(...scores), hi = Math.max(...scores);
    // Chuẩn hoá về [0,1] TRONG TỪNG CẢNH rồi mới cộng thưởng: cosine của CLIP và SigLIP lệch thang
    // nhau khá xa, cộng thẳng hằng số vào là trọng số mất hết ý nghĩa khi đổi model.
    // Hạng chất lượng nhân 2 nên luôn lấn át phần điểm nội dung: hết ảnh hạng 0 mới xuống hạng 1.
    const span = hi - lo || 1;
    return cands.map(c => ({
        ...c,
        rankScore: (2 - qualityTier(c)) * 2
            + (c.score - lo) / span
            + (c.type === 'video' ? W_VIDEO : 0)
            + (c.source_url ? W_SOURCE : 0)
            + ((c.w || 0) >= 1920 ? W_RES : 0),
    })).sort((a, b) => b.rankScore - a.rankScore);
}

// Rải thời lượng cho khớp ĐÚNG số giây lời đọc: video giữ nhịp thật, ảnh co giãn bù phần lệch.
function allocate(items, need) {
    const dur = items.map(it => it.type === 'video' ? clamp(it.realDur || CLIP_MIN, CLIP_MIN, CLIP_MAX) : IMG_SEC);
    const isImg = items.map(it => it.type === 'image');
    if (!(need > 0)) return dur.map(r1);          // chưa biết cảnh dài bao nhiêu -> để nhịp mặc định
    for (let guard = 0; guard < 40 && Math.abs(need - sum(dur)) > 0.05; guard++) {
        const delta = need - sum(dur);
        const idx = dur.map((_, i) => i).filter(i => isImg[i] &&
            (delta > 0 ? dur[i] < IMG_MAX - 1e-6 : dur[i] > IMG_MIN + 1e-6));
        if (!idx.length) break;
        const step = delta / idx.length;
        for (const i of idx) dur[i] = clamp(dur[i] + step, IMG_MIN, IMG_MAX);
    }
    // Hết ảnh để co giãn mà vẫn thiếu (pool cạn) -> CHIA ĐỀU phần dư cho mọi clip. Dồn hết vào clip
    // cuối thì cảnh 90s hay ra 13 ảnh 6s + 1 ảnh 12s: đúng tổng số giây nhưng nhìn là thấy lệch nhịp.
    const rest = need - sum(dur);
    if (Math.abs(rest) > 0.05 && dur.length) {
        const share = rest / dur.length;
        for (let i = 0; i < dur.length; i++) dur[i] = Math.max(1, dur[i] + share);
    }
    const rounded = dur.map(r1);
    const drift = r1(need - sum(rounded));
    if (Math.abs(drift) >= 0.1 && rounded.length) rounded[rounded.length - 1] = r1(rounded[rounded.length - 1] + drift);
    return rounded;
}

// Số giây 1 clip chiếm khi ước lượng độ phủ (chưa rải chính xác).
const estSec = c => c.type === 'video' ? clamp(c.realDur || CLIP_MIN, CLIP_MIN, CLIP_MAX) : IMG_SEC;
// Cảnh chưa đo được lời đọc (chưa tạo voice / link mp3 hết hạn): vẫn lấy 2 hình cho có, người dùng
// chỉnh sau — hơn là bỏ trống rồi export ra nền đen.
const targetOf = scene => scene.need > 0 ? scene.need : IMG_SEC * 2;
// Trần số clip đi theo ĐỘ DÀI CẢNH, không phải hằng số: cảnh 90s mà chốt 14 clip thì mỗi ảnh phải nằm
// 6.4s mới đủ giờ — trần chỉ để chặn trường hợp vô lý, nhịp thật do IMG_SEC quyết định.
const maxItemsOf = scene => clamp(Math.ceil(targetOf(scene) / IMG_MIN), 1, HARD_MAX_ITEMS);

// Chọn thêm clip cho 1 cảnh từ danh sách ứng viên, nối vào những gì cảnh đã có. Chưa gán thời lượng:
// pool chung (drama) còn bù thêm ở lượt sau, rải giây xong rồi mới chốt một lần cho cả cảnh.
function pickInto(scene, picked, cands, usedIds) {
    const free = cands.filter(c => !usedIds.has(c.id) && c.scored);
    if (!free.length) return picked;
    const target = targetOf(scene), maxItems = maxItemsOf(scene);
    const usedGroups = new Set(picked.map(p => p.dup));
    let acc = sum(picked.map(estSec));

    for (const c of rank(free)) {
        if (picked.length >= maxItems) break;
        if (acc >= target - 0.05 && picked.length >= 1) break;
        if (usedGroups.has(c.dup)) continue;                 // 1 ảnh/nhóm trùng -> không lặp hình
        usedGroups.add(c.dup);
        usedIds.add(c.id);
        picked.push(c);
        acc += estSec(c);
    }
    return picked;
}

// Chốt 1 cảnh: xếp lại thứ tự rồi rải thời lượng.
function finalize(scene, picked) {
    // Mở cảnh bằng video nếu có: vào cảnh bằng chuyển động bắt mắt hơn ảnh tĩnh.
    const vi = picked.findIndex(p => p.type === 'video');
    if (vi > 0) picked.unshift(...picked.splice(vi, 1));
    const durs = allocate(picked, scene.need > 0 ? scene.need : 0);
    return picked.map((p, i) => ({ ...p, slot: durs[i] }));
}

// ---------------------------------------------------------------------------
async function main() {
    const args = parseArgs();
    const db = await getDb();
    const post = args.postId
        ? await db.get('SELECT id, project_id, genre, voice_content_type FROM Post WHERE id = ?', [args.postId])
        : await db.get('SELECT id, project_id, genre, voice_content_type FROM Post WHERE project_id = ? ORDER BY id DESC LIMIT 1', [args.projectId]);
    if (!post) { console.error('[auto_select] không tìm thấy post'); process.exit(1); }
    console.log(`[auto_select] post ${post.id} (${post.project_id}, ${post.genre || '?'}) — scope=${args.scope}${args.force ? ' --force' : ''}${args.dry ? ' --dry' : ''}`);

    const projDir = path.join(MEDIA_DIR, (post.project_id || '').replace(/_[a-z]{2}$/, ''));
    const narrFile = path.join(fs.existsSync(projDir) ? projDir : path.join(MEDIA_DIR, post.project_id), 'auto_select_narr.json');
    // Cache độ dài lời đọc: link mp3 ttsmin hết hạn nhanh, đo lại sau vài hôm là ra 0 giây.
    let narrCache = {};
    try { narrCache = JSON.parse(fs.readFileSync(narrFile, 'utf8')); } catch (_) {}

    // TRẢ RỔ TRƯỚC KHI ĐỌC POOL: media máy từng điều ra khỏi rổ chung phải về đúng chỗ cũ trước đã,
    // không thì lần chạy này đọc thấy nó đang nằm ở cảnh lần trước gán, ghi đè mất dấu auto_home và
    // từ lần sau nó kẹt vĩnh viễn ở cảnh đó.
    if (!args.dry) {
        let back = 0;
        for (const row of await db.all('SELECT id, auto_home FROM Asset WHERE auto = 1 AND auto_home IS NOT NULL')) {
            try {
                const home = JSON.parse(row.auto_home);
                if (home?.post_id !== post.id) continue;
                await db.run(`UPDATE Asset SET selected = 0, "order" = 0, auto = 0, auto_home = NULL,
                              paragraph_id = NULL, sentence_id = NULL, post_id = ?, section = ? WHERE id = ?`,
                    [home.post_id, home.section, row.id]);
                back++;
            } catch (_) { /* auto_home hỏng -> để nguyên, chạy tay xử lý */ }
        }
        if (back) console.log(`[auto_select] trả ${back} media của lần chạy trước về rổ chung`);
    }

    const { groups, xPool } = await buildGroups(db, post, narrCache);
    try { fs.mkdirSync(path.dirname(narrFile), { recursive: true }); fs.writeFileSync(narrFile, JSON.stringify(narrCache, null, 2)); } catch (_) {}
    if (!groups.length) { console.log('[auto_select] không có cảnh nào để gán media'); await db.close(); return; }
    if (xPool.length) console.log(`[auto_select] rổ chung (section='x'): ${xPool.length} media dùng cho mọi cảnh`);

    // --- Bỏ qua cảnh người đã tự chọn (trừ khi --scope all / --force) ---
    const active = groups.filter(g => {
        const manual = g.pool.filter(a => a.selected && !a.auto).length;
        if (manual && args.scope !== 'all' && !args.force) {
            console.log(`[auto_select] ${g.label}: đã có ${manual} media chọn tay → bỏ qua`);
            return false;
        }
        return true;
    });
    if (!active.length) { console.log('[auto_select] mọi cảnh đều đã chọn tay → không làm gì'); await db.close(); return; }

    // --- Đo video + cắt frame, rồi chấm điểm cả dự án 1 lượt ---
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autosel-'));
    const jobAssets = [], byId = new Map();
    let missing = 0;
    const prepare = (a) => {
        const abs = path.join(MEDIA_DIR, a.file_path);
        if (!fs.existsSync(abs)) { missing++; return; }
        a.abs = abs;
        if (a.type === 'video') {
            // Đo lại từ FILE, không tin Asset.duration: khi 1 clip được chọn thì cột đó bị ghi đè bằng
            // độ dài SLOT (số giây muốn phát trong cảnh), đọc lại sẽ hiểu nhầm clip 12s thành clip 2.4s
            // -> lần chạy sau xếp hạng và chia nhịp lệch hẳn.
            a.realDur = ffprobeDuration(abs);
            const frames = videoFrames(abs, a.realDur, tmpDir);
            if (!frames.length) return;          // clip hỏng, ffmpeg không lấy nổi frame nào
            jobAssets.push({ id: a.id, paths: frames });
        } else {
            jobAssets.push({ id: a.id, paths: [abs] });
        }
        byId.set(a.id, a);
    };
    for (const g of active) for (const a of g.pool) prepare(a);
    for (const a of xPool) prepare(a);
    if (missing) console.log(`[auto_select] ${missing} asset trong DB không còn file trên đĩa → bỏ qua`);
    if (!jobAssets.length) { console.log('[auto_select] không có file nào đọc được'); await db.close(); return; }

    // Rổ chung được chấm cho MỌI cảnh (mã hoá ảnh vẫn chỉ 1 lần, chỉ nhân thêm phép so text).
    const xIds = xPool.filter(a => byId.has(a.id)).map(a => a.id);
    const job = {
        assets: jobAssets,
        scenes: active.flatMap(g => g.scenes.map(s => ({
            key: s.key,
            texts: s.texts,
            assetIds: [...g.pool.filter(a => byId.has(a.id)).map(a => a.id), ...xIds],
        }))),
    };
    console.log(`[auto_select] chấm điểm ${jobAssets.length} asset cho ${job.scenes.length} cảnh...`);
    const t0 = Date.now();
    const scored = await runScorer(job);
    console.log(`[auto_select] xong sau ${((Date.now() - t0) / 1000).toFixed(1)}s (${scored.model} / ${scored.device})`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    const perScene = new Map(scored.scenes.map(s => [s.key, new Map(s.assets.map(a => [a.id, a]))]));

    // --- Ghi lại đặc trưng ảnh cho MỌI asset (UI sắp pool theo điểm kể cả khi chọn tay) ---
    if (!args.dry) {
        const seen = new Set();
        for (const s of scored.scenes) for (const a of s.assets) {
            if (seen.has(a.id)) continue;
            seen.add(a.id);
            await db.run('UPDATE Asset SET score = ?, width = ?, height = ?, dhash = ? WHERE id = ?',
                [a.score, a.w, a.h, a.dhash, a.id]);
        }
    }

    // --- Dọn lựa chọn cũ của MÁY (giữ nguyên lựa chọn tay, trừ khi --force) ---
    if (!args.dry) {
        for (const g of active) {
            // Bọc NGOẶC quanh điều kiện phạm vi: where của luận điểm có OR, nối thẳng "AND auto = 1"
            // vào sau sẽ chỉ dính vào vế phải -> xoá nhầm lựa chọn tay ở vế trái.
            await db.run(`UPDATE Asset SET ${g.reset.set} WHERE (${g.reset.where})${args.force ? '' : ' AND auto = 1'}`,
                g.reset.args);
        }
    }

    // --- Lượt 1: mỗi cảnh lấy từ POOL RIÊNG của nó ---
    const plan = [];        // [{ scene, picked, ownerLabel }]
    const usedIds = new Set();
    let noNarr = 0;
    for (const g of active) {
        // Giữ nguyên lựa chọn TAY: asset đó coi như đã dùng, không đem chọn lại cho cảnh khác.
        for (const a of g.pool) if (a.selected && !a.auto && !args.force) usedIds.add(a.id);
        for (const scene of g.scenes) {
            const smap = perScene.get(scene.key);
            if (!smap) continue;
            if (!(scene.need > 0)) noNarr++;
            const cands = g.pool.filter(a => byId.has(a.id)).map(a => ({ ...a, ...(smap.get(a.id) || {}), scored: smap.has(a.id) }));
            plan.push({ scene, picked: pickInto(scene, [], cands, usedIds) });
        }
    }

    // --- Lượt 2: bù từ RỔ CHUNG (drama cào X về section='x', mọi cảnh dùng chung) ---
    // Duyệt theo cặp (cảnh, media) điểm cao trước trên TOÀN dự án, không phải cảnh nào tới lượt thì
    // vơ hết: rổ chung thường ít hơn số cảnh rất nhiều, để cảnh đầu vét sạch là cảnh sau trắng hình.
    if (xPool.length) {
        const pairs = [];
        for (const item of plan) {
            const smap = perScene.get(item.scene.key);
            if (!smap) continue;
            const cands = xPool.filter(a => byId.has(a.id) && smap.has(a.id))
                .map(a => ({ ...a, ...smap.get(a.id), scored: true }));
            for (const c of rank(cands)) pairs.push({ item, c });
        }
        pairs.sort((a, b) => b.c.rankScore - a.c.rankScore);
        for (const { item, c } of pairs) {
            if (usedIds.has(c.id)) continue;
            const before = item.picked.length;
            pickInto(item.scene, item.picked, [c], usedIds);
            if (item.picked.length > before) item.picked[item.picked.length - 1]._fromPool = true;
        }
    }

    // --- Chốt thời lượng + ghi ---
    let totalPicked = 0, moved = 0;
    for (const { scene, picked: raw } of plan) {
        if (!raw.length) { console.log(`[auto_select]   ${scene.label}: không có ứng viên`); continue; }
        const picked = finalize(scene, raw);
        totalPicked += picked.length;
        console.log(`[auto_select]   ${scene.label}: cần ${r1(scene.need)}s → ${picked.length} clip (${r1(sum(picked.map(p => p.slot)))}s) | `
            + picked.map(p => `${p.type === 'video' ? '🎬' : '🖼'}${path.basename(p.file_path)}:${p.slot}s`).join(' '));

        if (args.dry) continue;
        for (const [i, p] of picked.entries()) {
            // Media lấy từ rổ chung: nhớ rổ cũ để còn đường quay lại, và xoá post_id/section như move-asset.
            const home = p._fromPool && p.section ? JSON.stringify({ post_id: post.id, section: p.section }) : null;
            if (home) moved++;
            if (scene.owner.kind === 'sent') {
                await db.run(`UPDATE Asset SET selected = 1, auto = 1, "order" = ?, duration = ?, sentence_id = ?,
                              paragraph_id = NULL, post_id = NULL, section = NULL, auto_home = COALESCE(?, auto_home) WHERE id = ?`,
                    [i + 1, p.slot, scene.owner.sentenceId, home, p.id]);
            } else if (scene.owner.kind === 'para') {
                await db.run(`UPDATE Asset SET selected = 1, auto = 1, "order" = ?, duration = ?, sentence_id = NULL,
                              paragraph_id = ?, post_id = NULL, section = NULL, auto_home = COALESCE(?, auto_home) WHERE id = ?`,
                    [i + 1, p.slot, scene.owner.paragraphId, home, p.id]);
            } else {
                await db.run(`UPDATE Asset SET selected = 1, auto = 1, "order" = ?, duration = ?, post_id = ?, section = ?,
                              paragraph_id = NULL, sentence_id = NULL, auto_home = COALESCE(?, auto_home) WHERE id = ?`,
                    [i + 1, p.slot, post.id, scene.owner.section, home, p.id]);
            }
        }
    }
    if (noNarr) console.log(`[auto_select] ⚠ ${noNarr} cảnh không đo được lời đọc (chưa tạo voice / link mp3 hết hạn) → chọn theo số lượng mặc định`);
    if (moved) console.log(`[auto_select] ${moved} media điều từ rổ chung sang cảnh (bỏ chọn là tự về rổ cũ)`);
    console.log(`[auto_select] ✅ chọn ${totalPicked} media${args.dry ? ' (dry-run, KHÔNG ghi DB)' : ''}`);
    await db.close();
}

main().catch(e => { console.error('[auto_select] lỗi:', e.message); process.exit(1); });
