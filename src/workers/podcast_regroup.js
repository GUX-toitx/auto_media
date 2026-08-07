import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// ============================================================================
// Gộp cảnh cho dự án PODCAST đã nhập theo kiểu cũ (1 dòng SRT = 1 Paragraph).
//
//   node src/workers/podcast_regroup.js <projectId>
//
// Vì sao cần: file SRT thật 500-1000 dòng -> 500-1000 cảnh, dashboard dựng mỗi cảnh
// một khối media đầy đủ nên mở dự án đứng hình cả chục giây (nhìn như màn hình đen).
//
// GIỮ NGUYÊN ParagraphDetail (mỗi câu 1 mp3) nên VOICE ĐÃ GEN KHÔNG MẤT — chỉ dời
// detail sang Paragraph đại diện của cảnh rồi xoá các Paragraph rỗng còn lại.
// srt_timing.json cũng được viết lại sang v2 (theo cặp cảnh:câu) để xuất SRT vẫn đúng mốc.
// Chạy lại lần 2 trên dự án đã gộp thì không đổi gì thêm.
// ============================================================================

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const CUES_PER_SCENE = Math.max(1, parseInt(process.env.PODCAST_CUES_PER_SCENE, 10) || 15);
const SCENE_GAP = Number(process.env.PODCAST_SCENE_GAP || 2);
const MIN_CUES_PER_SCENE = 3;

const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

async function main() {
    const projectId = process.argv[2];
    if (!projectId) { console.error('Usage: node podcast_regroup.js <projectId>'); process.exit(1); }

    const db = await getDb();
    const post = await db.get('SELECT id, genre FROM Post WHERE project_id = ?', [projectId]);
    if (!post) throw new Error(`Không tìm thấy dự án '${projectId}'`);
    if (post.genre !== 'podcast') throw new Error(`Dự án '${projectId}' không phải podcast (genre=${post.genre})`);

    const paras = await db.all('SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY "order", id', [post.id]);
    if (!paras.length) throw new Error('Dự án chưa có cảnh nào');

    // Mốc thời gian gốc để biết chỗ nào có khoảng lặng dài (ranh giới cảnh tự nhiên).
    // Thiếu file thì gộp thuần theo số câu.
    const timingFile = path.join(MEDIA_DIR, projectId, 'srt_timing.json');
    const meta = fs.existsSync(timingFile) ? JSON.parse(fs.readFileSync(timingFile, 'utf8')) : {};
    if (meta.version === 2) { console.log('[podcast_regroup] srt_timing.json đã là v2 → dự án đã gộp, không làm gì.'); await db.close(); return; }
    const byOrder = new Map();
    for (const c of (meta.cues || [])) byOrder.set(Number(c.scene ?? c.order), { start: Number(c.start), end: Number(c.end) });

    // Mỗi Paragraph cũ = 1 cue; gom lại theo ĐÚNG luật của podcast_srt.js
    const groups = [];
    let cur = [];
    for (const [i, p] of paras.entries()) {
        const t = byOrder.get(Number(p.order));
        const prevT = i > 0 ? byOrder.get(Number(paras[i - 1].order)) : null;
        const longPause = t && prevT && (t.start - prevT.end) >= SCENE_GAP;
        if (cur.length >= CUES_PER_SCENE || (longPause && cur.length >= MIN_CUES_PER_SCENE)) { groups.push(cur); cur = []; }
        cur.push({ ...p, timing: t || null });
    }
    if (cur.length) groups.push(cur);

    if (groups.length === paras.length) { console.log('[podcast_regroup] Không có gì để gộp.'); await db.close(); return; }
    console.log(`[podcast_regroup] ${paras.length} cảnh -> ${groups.length} cảnh (tối đa ${CUES_PER_SCENE} câu/cảnh).`);

    const timing = [];
    for (const [gi, group] of groups.entries()) {
        const sceneOrder = gi + 1;
        const keep = group[0];              // Paragraph đại diện của cảnh
        let line = 0;
        for (const p of group) {
            const details = await db.all('SELECT id, "order" FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"', [p.id]);
            for (const d of details) {
                line++;
                // Dời detail sang cảnh đại diện — audio (content_audio/content_vi_audio) đi theo row nên voice còn nguyên
                if (p.id !== keep.id) await db.run('UPDATE ParagraphDetail SET paragraph_id = ? WHERE id = ?', [keep.id, d.id]);
                await db.run('UPDATE ParagraphDetail SET "order" = ? WHERE id = ?', [line, d.id]);
                if (p.timing) timing.push({ scene: sceneOrder, line, start: p.timing.start, end: p.timing.end });
            }
            if (p.id !== keep.id) {
                // Dời nốt keyword/asset (podcast thường không có, nhưng đừng để mồ côi) rồi xoá cảnh rỗng
                await db.run('UPDATE Keyword SET paragraph_id = ? WHERE paragraph_id = ?', [keep.id, p.id]).catch(() => {});
                await db.run('UPDATE Asset SET paragraph_id = ? WHERE paragraph_id = ?', [keep.id, p.id]).catch(() => {});
                await db.run('DELETE FROM Paragraph WHERE id = ?', [p.id]);
            }
        }
        // Nội dung cảnh = ghép các câu của nó
        const all = await db.all('SELECT content, content_vi FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"', [keep.id]);
        await db.run('UPDATE Paragraph SET content = ?, content_vi = ?, "order" = ? WHERE id = ?', [
            all.map(d => d.content || '').join(' ').trim(),
            all.map(d => d.content_vi || '').join(' ').trim(),
            sceneOrder, keep.id,
        ]);
    }

    if (timing.length) {
        fs.writeFileSync(timingFile, JSON.stringify({ ...meta, version: 2, cues: timing }, null, 2));
        console.log(`[podcast_regroup] Đã cập nhật srt_timing.json sang v2 (${timing.length} mốc).`);
    } else {
        console.warn('[podcast_regroup] ⚠️ Không có srt_timing.json cũ → xuất SRT theo mốc gốc sẽ không dùng được (vẫn xuất theo voice được).');
    }

    const nLeft = await db.get('SELECT COUNT(*) n FROM Paragraph WHERE post_id = ?', [post.id]);
    const nDet = await db.get('SELECT COUNT(*) n FROM ParagraphDetail WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?)', [post.id]);
    const nAudio = await db.get('SELECT COUNT(*) n FROM ParagraphDetail WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?) AND (content_audio IS NOT NULL OR content_vi_audio IS NOT NULL)', [post.id]);
    await db.close();
    console.log(`[podcast_regroup] ✅ Xong: ${nLeft.n} cảnh / ${nDet.n} câu đọc (${nAudio.n} câu còn nguyên audio).`);
}

main().catch(e => { console.error('[podcast_regroup] LỖI:', e.message); process.exit(1); });
