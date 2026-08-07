import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// ============================================================================
// PODCAST: dự án CHỈ CÓ TIẾNG — đầu vào là file .srt, không cào ảnh/video.
//
//   node src/workers/podcast_srt.js <file.srt> <projectId> [<file_dich.srt>] [targetLang] [--title "..."]
//
// MỖI CUE SRT = 1 ParagraphDetail (1 câu đọc = 1 mp3), NHIỀU cue gộp thành 1 Paragraph (1 cảnh)
// — giống mô hình của sports_srt.js. KHÔNG được để 1 cue = 1 Paragraph: file SRT thật thường
// 500-1000 dòng, dashboard dựng mỗi cảnh 1 khối media đầy đủ nên 537 cảnh = ~25.000 node DOM,
// mở dự án đứng hình ~20 giây (nhìn như màn hình đen).
// Cắt cảnh: đủ PODCAST_CUES_PER_SCENE câu, HOẶC gặp khoảng lặng ≥ PODCAST_SCENE_GAP giây
// (nghỉ dài trong podcast thường là ranh giới ý) — miễn cảnh đã có ít nhất 3 câu.
//
// MỐC THỜI GIAN GỐC của từng cue được giữ trong <project>/srt_timing.json (theo cặp cảnh:câu)
// để nút "Tải SRT" xuất lại đúng timeline gốc kể cả khi dự án KHÔNG tạo voice.
// Không đụng DB schema (mốc thời gian nằm ở file, giống voice_auto.json) vì
// media_system.sqlite dùng chung với các nhánh khác.
// ============================================================================

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const PORT = process.env.PORT || 3000;
const CUES_PER_SCENE = Math.max(1, parseInt(process.env.PODCAST_CUES_PER_SCENE, 10) || 15);
const SCENE_GAP = Number(process.env.PODCAST_SCENE_GAP || 2);   // giây im lặng đủ để sang cảnh mới
const MIN_CUES_PER_SCENE = 3;                                   // đừng cắt vụn vì mỗi lần nghỉ ngắn

const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

// Báo dashboard qua SSE (giống sports_srt.js). Luôn resolve — server chưa chạy cũng kệ.
function notifyDashboard(projectId, status, silent = false) {
    return new Promise((resolve) => {
        try {
            const req = http.request(
                { hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } },
                (res) => { res.resume(); res.on('end', resolve); }
            );
            req.on('error', () => resolve());
            req.setTimeout(3000, () => { req.destroy(); resolve(); });
            req.end(JSON.stringify({ postTitle: projectId, status, silent }));
        } catch (_) { resolve(); }
    });
}

// "00:01:02,500" (hoặc dấu chấm) -> giây. Sai định dạng -> null.
function tcToSec(tc) {
    const m = String(tc || '').trim().match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

// Đọc .srt -> [{ start, end, text }] theo ĐÚNG thứ tự trong file.
// Chịu được: BOM, CRLF, block thiếu số thứ tự, text nhiều dòng.
function parseSrt(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const cues = [];
    for (const block of content.trim().split(/\n\s*\n+/)) {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) continue;
        // Block chuẩn: [số thứ tự, timecode, ...text]. Có file bỏ số thứ tự -> dòng đầu đã là timecode.
        const i = lines[0].includes('-->') ? 0 : 1;
        const tcLine = lines[i];
        if (!tcLine || !tcLine.includes('-->')) continue;
        const [rawStart, rawEnd] = tcLine.split('-->');
        const start = tcToSec(rawStart);
        const end = tcToSec(rawEnd);
        // Cue phải 1 dòng khi đưa vào TTS (xuống dòng giữa câu làm vỡ nhịp đọc).
        const text = lines.slice(i + 1).join(' ').replace(/\s+/g, ' ').trim();
        if (!text || start === null || end === null) continue;
        cues.push({ start, end, text });
    }
    return cues;
}

async function main() {
    const argv = process.argv.slice(2);
    // --title đứng đâu cũng được (server truyền tên file SRT gốc làm tiêu đề dự án)
    let title = '';
    const args = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--title') { title = (argv[++i] || '').trim(); continue; }
        args.push(argv[i]);
    }
    const srtPath = args[0];
    const projectId = args[1];
    const srtTargetPath = args[2] || null;      // '' (giữ chỗ) -> không có bản dịch
    const targetLang = args[3] || 'vi';

    if (!srtPath || !projectId) {
        console.error('Usage: node podcast_srt.js <file.srt> <projectId> [file_dich.srt] [targetLang] [--title "..."]');
        process.exit(1);
    }

    const cues = parseSrt(srtPath);
    if (!cues.length) throw new Error(`Không đọc được cue nào từ ${srtPath} (file rỗng hoặc sai định dạng SRT)`);
    // Bản dịch ghép theo VỊ TRÍ (số thứ tự trong 2 file hay lệch nhau). Lệch số cue thì
    // cue thừa/thiếu dùng luôn câu gốc — thà đọc trùng còn hơn lệch nguyên bài.
    const targetCues = srtTargetPath && fs.existsSync(srtTargetPath) ? parseSrt(srtTargetPath) : null;
    if (targetCues && targetCues.length !== cues.length) {
        console.warn(`[podcast_srt] ⚠️ SRT đích ${targetCues.length} cue ≠ SRT gốc ${cues.length} cue → ghép theo vị trí, phần lệch dùng câu gốc.`);
    }
    console.log(`[podcast_srt] Đọc ${cues.length} cue từ ${srtPath}${targetCues ? ` (+ ${targetCues.length} cue bản dịch)` : ''}`);

    const projectDir = path.join(MEDIA_DIR, projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const db = await getDb();
    const postTitle = title || projectId;
    await db.run(
        'INSERT OR IGNORE INTO Post (project_id, title, status, voice_content_type, target_lang, genre) VALUES (?, ?, ?, ?, ?, ?)',
        [projectId, postTitle, 'crawling', targetLang === 'vi' ? 'content_vi' : 'content', targetLang, 'podcast']
    );
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;
    // INSERT OR IGNORE không cập nhật post đã tồn tại (chạy lại cùng projectId) -> set lại đủ cột.
    await db.run(
        "UPDATE Post SET genre = 'podcast', status = 'crawling', title = ?, voice_content_type = ?, target_lang = ? WHERE id = ?",
        [postTitle, targetLang === 'vi' ? 'content_vi' : 'content', targetLang, postId]
    );
    await notifyDashboard(projectId, 'crawling');

    // Chạy lại cùng projectId -> xoá nội dung cũ, tránh nhân đôi cảnh.
    const oldParas = await db.all('SELECT id FROM Paragraph WHERE post_id = ?', [postId]);
    for (const p of oldParas) {
        await db.run('DELETE FROM ParagraphDetail WHERE paragraph_id = ?', [p.id]);
        await db.run('DELETE FROM Paragraph WHERE id = ?', [p.id]);
    }

    // Gom cue thành cảnh trước khi ghi DB (xem chú thích đầu file về lý do)
    const scenes = [];
    let cur = [];
    for (const [i, cue] of cues.entries()) {
        const prev = cues[i - 1];
        const longPause = prev && (cue.start - prev.end) >= SCENE_GAP;
        if (cur.length >= CUES_PER_SCENE || (longPause && cur.length >= MIN_CUES_PER_SCENE)) { scenes.push(cur); cur = []; }
        // content = ngôn ngữ đích (bản đọc chính khi targetLang != vi), content_vi = câu gốc.
        cur.push({ target: targetCues?.[i]?.text || cue.text, vi: cue.text, start: cue.start, end: cue.end });
    }
    if (cur.length) scenes.push(cur);

    const timing = [];
    for (const [si, lines] of scenes.entries()) {
        const sceneOrder = si + 1;
        // Nội dung cảnh = ghép các câu của nó (giống sports_srt: Paragraph là cả đoạn, detail là từng câu đọc)
        const paraRes = await db.run(
            'INSERT INTO Paragraph (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, lines.map(l => l.target).join(' '), lines.map(l => l.vi).join(' '), sceneOrder]
        );
        for (const [li, l] of lines.entries()) {
            await db.run(
                'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
                [paraRes.lastID, l.target, l.vi, li + 1]
            );
            timing.push({ scene: sceneOrder, line: li + 1, start: l.start, end: l.end });
        }
    }

    // Mốc thời gian gốc: nút "Tải SRT" (chế độ "theo SRT gốc") đọc file này để xuất lại
    // đúng timeline ban đầu — kể cả dự án không tạo voice nên chẳng có mp3 nào để đo.
    fs.writeFileSync(
        path.join(projectDir, 'srt_timing.json'),
        JSON.stringify({ source: path.basename(srtPath), lang: targetLang, version: 2, cues: timing }, null, 2)
    );

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    await notifyDashboard(projectId, null);
    console.log(`[podcast_srt] ✅ Đã tạo dự án podcast '${projectId}': ${cues.length} câu đọc gom thành ${scenes.length} cảnh.`);
}

main().catch(async (e) => {
    console.error('[podcast_srt] LỖI:', e.message);
    // Dọn "ghost project": post đã tạo nhưng chưa có cảnh nào -> xoá, không để dashboard kẹt dự án rỗng.
    const projectId = process.argv[3];
    try {
        const db = await getDb();
        const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
        if (post) {
            const np = await db.get('SELECT COUNT(*) AS n FROM Paragraph WHERE post_id = ?', [post.id]);
            if (!np || !np.n) await db.run('DELETE FROM Post WHERE id = ?', [post.id]);
            else await db.run('UPDATE Post SET status = NULL WHERE id = ?', [post.id]);
        }
        await db.close();
    } catch (_) {}
    // silent: dự án lỗi, không bắn Slack "đã crawl xong".
    await notifyDashboard(projectId, null, true);
    process.exit(1);
});
