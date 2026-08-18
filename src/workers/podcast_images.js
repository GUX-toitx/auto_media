import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { runFlowImageBatch, FLOW_DAILY_LIMIT } from '../services/browser.js';
import { parseScenePrompts } from '../lib/scenePrompts.js';

// ============================================================================
// SINH ẢNH AI CHO DỰ ÁN PODCAST — MỖI CẢNH MỘT TẤM, CẢ BÀI CHUNG MỘT PROJECT FLOW
//
//   node src/workers/podcast_images.js --projectId <id> [--postId N]
//        [--prompts <file>] [--ratio 16:9] [--batch 0] [--force]
//
// Khác hẳn nút ✨ AI Generate của các thể loại khác (mỗi lần bấm là một project Flow mới):
// truyện podcast có dàn NHÂN VẬT riêng, các cảnh phải ra đúng những người đó. Flow chỉ giữ
// được nhân vật trong PHẠM VI MỘT PROJECT, nên cả bài chạy trong đúng một project:
//
//   prompt nhân vật 01..N   (Flow "biết mặt" từng người)
//   prompt cảnh 01..M       (mỗi cảnh 1 ảnh, gán vào Paragraph cùng thứ tự)
//
// Prompt do người dùng TỰ VIẾT, dán nguyên khối vào lúc tạo dự án; định dạng xem
// src/lib/scenePrompts.js (mẫu: prompts/contents/prompt.txt).
//
// CHẠY LẠI ĐƯỢC (bài 40 cảnh chạy cả tiếng, đứt gánh là chuyện thường):
//   • <project>/ai_images/state.json giữ URL project Flow + trạng thái từng prompt;
//   • chạy lại chỉ làm phần chưa xong, và mở LẠI đúng project Flow cũ;
//   • --batch N để chia mẻ, mỗi lần chỉ chạy N prompt còn thiếu.
//
// Ảnh cảnh ghi thẳng vào Asset (selected=1, duration để trống = trải hết cảnh) nên
// capcut_export dựng được ngay, còn podcast_fill sẽ tự chừa những cảnh đã có ảnh này.
// ============================================================================

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

const SUB_DIR = '_podcast_ai_images';          // thư mục riêng, không đụng vào _raw_images_ai_gen của nút ✨
const hash8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);

function parseArgs() {
    const a = process.argv.slice(2);
    const get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
    return {
        projectId: (get('--projectId') || '').trim(),
        postId: get('--postId'),
        prompts: get('--prompts'),
        ratio: get('--ratio') || '',
        batch: Math.max(0, parseInt(get('--batch') || process.env.PODCAST_IMAGES_BATCH || '0', 10) || 0),
        force: a.includes('--force'),
    };
}

// Ghi song song console.* ra <dự án>/process.log (giống podcast_ai.js) — worker này chạy ngầm cả
// tiếng, output vốn chỉ nằm ở terminal của server nên xem lại "lượt nào ra ảnh nào" là chịu.
// Nút "📜 Log tiến độ" trên dashboard đọc đúng file này. Cả log [Flow] của browser.js cũng vào đây.
function teeLogToProject(projectId) {
    try {
        const dir = path.join(MEDIA_DIR, projectId);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'process.log');
        const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
        for (const level of ['log', 'warn', 'error']) {
            const orig = console[level].bind(console);
            console[level] = (...a) => {
                orig(...a);
                try { fs.appendFileSync(file, `[${new Date().toTimeString().slice(0, 8)}] ${a.map(fmt).join(' ')}\n`); } catch (_) {}
            };
        }
        // Mốc phân tách để đọc log biết đâu là lần chạy nào (bài hay chạy lại nhiều mẻ).
        fs.appendFileSync(file, `\n===== SINH ẢNH AI · ${new Date().toLocaleString('vi-VN')} =====\n`);
    } catch (_) {}
}

// Khung hình do người dùng chọn lúc tạo dự án (server ghi ai_images/options.json).
function readRatio(projectId, override) {
    if (override) return override;
    try {
        const o = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, projectId, 'ai_images', 'options.json'), 'utf8'));
        return o.ratio || '16:9';
    } catch { return '16:9'; }
}

const stateFile = (projectId) => path.join(MEDIA_DIR, projectId, 'ai_images', 'state.json');
const promptsFile = (projectId) => path.join(MEDIA_DIR, projectId, 'ai_images', 'prompts.txt');

function readState(projectId) {
    try { return JSON.parse(fs.readFileSync(stateFile(projectId), 'utf8')); } catch { return null; }
}

function writeState(projectId, state) {
    const file = stateFile(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    state.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// Thư mục lưu ảnh của một prompt. Nhân vật để riêng: chúng không phải hình của cảnh nào.
function dirOf(projectId, item) {
    return item.kind === 'character'
        ? path.join(MEDIA_DIR, projectId, 'assets', SUB_DIR, '_characters', String(item.n))
        : path.join(MEDIA_DIR, projectId, 'assets', SUB_DIR, String(item.n));
}

// Dọn sạch dấu vết lần gen trước của MỘT prompt: xoá file + bản ghi Asset trỏ vào thư mục đó.
// Không dọn thì chạy lại sinh flow_2.jpg, flow_3.jpg... và cảnh có 3 tấm chồng nhau.
async function resetItem(db, projectId, item) {
    const dir = dirOf(projectId, item);
    const rel = path.relative(MEDIA_DIR, dir).split(path.sep).join('/');
    const rows = await db.all('SELECT id, file_path FROM Asset WHERE file_path LIKE ?', [`${rel}/%`]);
    for (const r of rows) await db.run('DELETE FROM Asset WHERE id = ?', [r.id]);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return rows.length;
}

// Thư mục của một prompt chỉ giữ ảnh của lần gen MỚI NHẤT. Cần vì có lúc một prompt được chạy lại
// dù đã xong: project Flow cũ chết, phải tạo project mới thì nhân vật được mồi lại từ đầu — lúc đó
// browser.js lưu thành flow_2.jpg, để nguyên là thư mục đầy ảnh cũ không ai dùng.
async function pruneOldFiles(db, item, keep) {
    let dropped = 0;
    for (const f of fs.readdirSync(item.saveDir).filter(f => !keep.includes(f))) {
        const rel = path.relative(MEDIA_DIR, path.join(item.saveDir, f)).split(path.sep).join('/');
        await db.run('DELETE FROM Asset WHERE file_path = ?', [rel]);
        try { fs.unlinkSync(path.join(item.saveDir, f)); dropped++; } catch (_) {}
    }
    return dropped;
}

async function main() {
    const args = parseArgs();
    const db = await getDb();
    const post = args.postId
        ? await db.get('SELECT id, project_id FROM Post WHERE id = ?', [args.postId])
        : await db.get('SELECT id, project_id FROM Post WHERE project_id = ? ORDER BY id DESC LIMIT 1', [args.projectId]);
    if (!post) { console.error(`[podcast_images] không thấy dự án (${args.postId || args.projectId})`); process.exit(1); }
    const projectId = post.project_id;
    teeLogToProject(projectId);
    const ratio = readRatio(projectId, args.ratio);

    const pFile = args.prompts || promptsFile(projectId);
    if (!fs.existsSync(pFile)) { console.error(`[podcast_images] không thấy file prompt: ${pFile}`); process.exit(1); }
    const parsed = parseScenePrompts(fs.readFileSync(pFile, 'utf8'));
    if (!parsed.characters.length && !parsed.scenes.length) {
        console.error('[podcast_images] file prompt không tách được mục nào — mỗi mục phải mở đầu bằng "01." / "1)"');
        process.exit(1);
    }

    const paras = await db.all('SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY "order", id', [post.id]);
    console.log(`[podcast_images] ${projectId} (post ${post.id}) — ${parsed.characters.length} nhân vật, `
        + `${parsed.scenes.length} cảnh trong file / ${paras.length} cảnh trong dự án · ratio ${ratio}`);
    if (parsed.scenes.length !== paras.length) {
        console.warn(`[podcast_images] ⚠ lệch số cảnh: file ${parsed.scenes.length} ≠ dự án ${paras.length}. `
            + (parsed.scenes.length > paras.length
                ? 'Cảnh thừa vẫn gen nhưng không gán vào đâu.'
                : 'Cảnh thiếu sẽ do khâu "lấp nền từ kho" lo (nếu có bật).'));
    }

    // Mục nào cũng có khoá riêng + vân tay prompt: sửa prompt trong file thì mục đó tự tính là chưa xong.
    const items = [
        ...parsed.characters.map(c => ({ ...c, kind: 'character', key: `char_${String(c.n).padStart(2, '0')}` })),
        ...parsed.scenes.map(s => ({ ...s, kind: 'scene', key: `scene_${String(s.n).padStart(3, '0')}` })),
    ].map(it => ({ ...it, hash: hash8(it.prompt), saveDir: dirOf(projectId, it) }));

    const state = readState(projectId) || { projectId, flowProjectUrl: '', flowProjects: {}, ratio, items: {} };
    state.ratio = ratio;
    // Mỗi TÀI KHOẢN Flow có project riêng (project thuộc về tài khoản). Bài dài phải đổi tài khoản
    // giữa chừng vì hạn mức ngày, nên nhớ URL theo id profile để lần sau về đúng chỗ, khỏi mồi lại
    // nhân vật. state cũ chỉ có 1 URL -> nâng cấp tại chỗ, không mất project đang dùng.
    if (!state.flowProjects) state.flowProjects = {};
    if (args.force) { state.items = {}; state.flowProjectUrl = ''; state.flowProjects = {}; }

    const pending = [];
    for (const it of items) {
        const st = state.items[it.key];
        const done = st?.status === 'done' && st.hash === it.hash && (st.files || []).length
            && (st.files || []).every(f => fs.existsSync(path.join(it.saveDir, f)));
        if (done) continue;
        if (st) await resetItem(db, projectId, it);      // gen lỗi / prompt đã sửa -> dọn rồi làm lại
        pending.push(it);
    }

    const doneCount = items.length - pending.length;
    if (!pending.length) {
        console.log(`[podcast_images] ✅ đã đủ ${items.length} ảnh, không còn gì để gen`);
        await db.close();
        console.log(JSON.stringify({ projectId, total: items.length, done: doneCount, failed: 0, pending: 0, noQuota: false, flowProjectUrl: state.flowProjectUrl }));
        return;
    }
    const queue = args.batch ? pending.slice(0, args.batch) : pending;
    console.log(`[podcast_images] còn thiếu ${pending.length}/${items.length} ảnh → mẻ này chạy ${queue.length}`
        + (state.flowProjectUrl ? ` (chạy tiếp trong project Flow cũ)` : ''));

    let ok = 0, fail = 0;
    const { projects, results, noQuota, aborted } = await runFlowImageBatch(queue, {
        ratio,
        count: 1,                                   // MỖI CẢNH ĐÚNG MỘT ẢNH
        projectUrlByProfile: state.flowProjects,
        legacyProjectUrl: state.flowProjectUrl || '',   // state đời đầu chỉ nhớ 1 url, chưa gắn profile
        // Nhân vật là "mồi": project cũ chết phải tạo project mới thì gen lại nhân vật trước,
        // không thì các cảnh sau vẽ ra người khác hẳn.
        primeItems: items.filter(i => i.kind === 'character'),
        onProject: (url, reused, profileId) => {
            state.flowProjectUrl = url;                     // project đang dùng (để hiển thị)
            state.flowProjects[profileId] = url;            // và nhớ theo từng tài khoản
            if (!reused) state.newProjectAt = Date.now();
            writeState(projectId, state);
        },
        onItem: async (item, { files, error }) => {
            const rel = files.map(f => path.relative(MEDIA_DIR, path.join(item.saveDir, f)).split(path.sep).join('/'));
            if (!error) await pruneOldFiles(db, item, files);
            state.items[item.key] = {
                kind: item.kind, n: item.n, label: item.label, hash: item.hash,
                status: error ? 'error' : 'done', files, error: error || null, at: Date.now(),
            };

            // Cảnh: gắn ảnh vào đúng Paragraph cùng thứ tự. duration để TRỐNG -> capcut_export
            // cho tấm ảnh trải trọn cảnh (asset cuối lấp hết khoảng còn lại).
            if (!error && item.kind === 'scene') {
                const para = paras[item.n - 1];
                if (para) {
                    for (const [i, r] of rel.entries()) {
                        const hit = await db.get('SELECT id FROM Asset WHERE file_path = ?', [r]);
                        if (!hit) {
                            await db.run(
                                `INSERT INTO Asset (paragraph_id, sentence_id, type, file_path, selected, auto, "order", duration)
                                 VALUES (?, NULL, 'image', ?, 1, 1, ?, NULL)`, [para.id, r, i + 1]);
                        }
                    }
                    state.items[item.key].paragraphId = para.id;
                } else {
                    console.warn(`[podcast_images] ⚠ cảnh ${item.n} không có Paragraph tương ứng → ảnh để trong ${SUB_DIR}/${item.n}`);
                }
            }
            if (error) fail++; else ok++;
            writeState(projectId, state);
            // Đếm từ state chứ không cộng dồn: project mới thì nhân vật được mồi lại, cộng dồn ra "6/5".
            const nDone = items.filter(i => state.items[i.key]?.status === 'done').length;
            console.log(`[podcast_images] ${error ? '✖' : '✔'} ${item.key} (${item.label})${error ? ' — ' + error : ''}`
                + ` · xong ${nDone}/${items.length}`);
        },
    });
    state.flowProjects = { ...state.flowProjects, ...projects };
    writeState(projectId, state);

    // results có thể nhiều hơn queue (project mới -> mồi lại nhân vật), nên đếm lại từ state.
    const finalDone = items.filter(i => state.items[i.key]?.status === 'done').length;
    const left = items.length - finalDone;
    await db.close();
    console.log(`[podcast_images] ${left ? '⚠' : '✅'} ${projectId}: ${finalDone}/${items.length} ảnh`
        + (left ? ` — còn thiếu ${left}` : '')
        + ` · ${results.filter(r => r.error).length} lượt lỗi`
        + ` · dùng ${Object.keys(state.flowProjects).length} tài khoản Flow`);
    if (noQuota) {
        console.warn(`[podcast_images] ⏳ DỪNG VÌ HẾT HẠN MỨC: mọi tài khoản đã cạn ${FLOW_DAILY_LIMIT} ảnh/ngày. `
            + `Còn ${left} ảnh — mai chạy lại (hoặc thêm profile) là làm tiếp đúng chỗ, project Flow giữ nguyên.`);
    } else if (left) {
        console.warn(`[podcast_images] chạy lại để làm nốt ${left} ảnh còn thiếu (giữ nguyên project Flow của từng tài khoản)`);
    }
    console.log(JSON.stringify({
        projectId, total: items.length, done: finalDone, failed: fail, pending: left,
        noQuota: !!noQuota, aborted: !!aborted, profiles: Object.keys(state.flowProjects).length,
        flowProjectUrl: state.flowProjectUrl,
    }));
}

main().catch(e => { console.error('[podcast_images] lỗi:', e.message); process.exit(1); });
