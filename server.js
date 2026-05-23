import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import multer from 'multer';

import { getLanguages, getReferenceSpeakers, getDictionary, getMe, sendToQueue, getSentenceStatus, updateSentence, generateAudios, updateBatchStatus, getBatchAudios, checkAndSaveVoice, getIndividualAudio, getMergedAudio } from './handle_voice/audio_service.js';
import { processAll } from './video_service.js';
import { generateFlowImage } from './browser.js';
import archiver from 'archiver';
import { downloadWithYtDlp } from './ytDlpDownloader.js'; // Nhúng con Bot vừa viết

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || '/usr/gux/media-team/db';

app.use(express.json()); // BẮT BUỘC PHẢI CÓ DÒNG NÀY Ở ĐÂY

const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

// API: Lấy danh sách posts
app.get('/api/posts', async (req, res) => {
    try {
        const db = await getDb();
        const posts = await db.all('SELECT id, title, status, audio_uuid, tieu_de FROM Post ORDER BY id DESC');
        await db.close();
        res.json(posts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Chi tiết 1 post: paragraphs + keywords + assets (file media quét từ thư mục)
app.get('/api/posts/:postId', async (req, res) => {
    try {
        const db = await getDb();
        const post = await db.get('SELECT id, title, tieu_de, mo_bai, mo_bai_vi, tom_tat, tom_tat_vi FROM Post WHERE id = ?', [req.params.postId]);
        if (!post) return res.status(404).json({ error: 'Post not found' });

        const paragraphs = await db.all(
            'SELECT id, content, original_content, title, title_vi, audio FROM Paragraph WHERE post_id = ? ORDER BY id',
            [post.id]
        );

        // Lấy tên thư mục gốc (bỏ suffix _en, _vi...)
        const projectId = post.title.replace(/_[a-z]{2}$/, '');

        for (let i = 0; i < paragraphs.length; i++) {
            const para = paragraphs[i];
            const gid = String(i + 1);

            // Sentences kèm audio
            para.sentences = (await db.all(
                'SELECT id, content, original_content, title, title_vi, audio, sentence_uuid, "order" FROM Sentence WHERE paragraph_id = ? ORDER BY "order"',
                [para.id]
            )).map(s => ({ ...s, sentenceUuid: s.sentence_uuid, audioUrl: s.audio ? (s.audio.startsWith('http') ? s.audio : `/${s.audio}`) : null }));

            // Keywords từ DB
            para.keywords = (await db.all(
                'SELECT content FROM Keyword WHERE paragraph_id = ? ORDER BY id',
                [para.id]
            )).map(r => r.content);

            // File media từ DB
            const assets = await db.all(
                'SELECT id, type, selected, "order", file_path, sentence_id, paragraph_id, duration FROM Asset WHERE paragraph_id = ? OR sentence_id IN (SELECT id FROM Sentence WHERE paragraph_id = ?) ORDER BY id',
                [para.id, para.id]
            );
            para.videos = assets
                .filter(a => a.type === 'video' && (a.paragraph_id || a.sentence_id))
                .map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, sentenceId: a.sentence_id || null, duration: a.duration || 0 }));
            para.images = assets
                .filter(a => a.type === 'image' && (a.paragraph_id || a.sentence_id))
                .map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, sentenceId: a.sentence_id || null, duration: a.duration || 0 }));

            // Audios & generated videos từ thư mục output
            para.audios = {};
            para.generatedVideos = {};
            const outDir = path.join(MEDIA_DIR, projectId, 'output');
            if (fs.existsSync(outDir)) {
                for (const lang of fs.readdirSync(outDir)) {
                    const aFile = path.join(outDir, lang, 'audios', `${gid}.mp3`);
                    if (fs.existsSync(aFile)) para.audios[lang] = { name: `${gid}.mp3`, url: `/${projectId}/output/${lang}/audios/${gid}.mp3` };
                    const vOutDir = path.join(outDir, lang, 'videos');
                    if (fs.existsSync(vOutDir)) {
                        const genVids = fs.readdirSync(vOutDir).filter(f => f.startsWith(`${gid}_`) && f.endsWith('.mp4'));
                        if (genVids.length) para.generatedVideos[lang] = genVids.map(f => ({ name: f, url: `/${projectId}/output/${lang}/videos/${f}` }));
                    }
                }
            }
        }

        await db.close();
        res.json({ ...post, projectId, paragraphs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Lưu Kịch bản và Keywords -> cập nhật thẳng vào DB
app.post('/api/save-content', async (req, res) => {
    const { paragraphId, script, keywords } = req.body;
    try {
        const db = await getDb();
        await db.run('UPDATE Paragraph SET content = ? WHERE id = ?', [script, paragraphId]);
        await db.run('DELETE FROM Keyword WHERE paragraph_id = ?', [paragraphId]);
        for (const kw of (keywords || [])) {
            await db.run('INSERT INTO Keyword (paragraph_id, content) VALUES (?, ?)', [paragraphId, kw]);
        }
        await db.close();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cập nhật API lấy Media
app.post('/api/generate-media', (req, res) => {
    const { videoId, groupId, keywords } = req.body;
    
    if (!keywords || keywords.length === 0) {
        return res.status(400).json({ error: "Không có từ khóa để tìm kiếm" });
    }

    console.log(`\n[HỆ THỐNG] Bắt đầu lấy Media cho: Dự án ${videoId} | Nhóm ${groupId}`);
    console.log(`[HỆ THỐNG] Từ khóa: ${keywords.join(', ')}`);

    // Chạy file craw_sub.js như một tiến trình riêng
    // Chúng ta truyền thêm các tham số để script biết chỉ crawl cho 1 nhóm cụ thể
    const pythonProcess = spawn('node', [
        'craw_sub.js',
        '--mode', 'single',
        '--videoId', videoId,
        '--paragraphId', String(groupId),
        '--keywords', keywords.join(',')
    ]);

    pythonProcess.stdout.on('data', (data) => {
        console.log(`[CRAWLER LOG]: ${data}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[CRAWLER ERROR]: ${data}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`[HỆ THỐNG] Script Crawl đã hoàn thành với mã thoát: ${code}`);
    });

    // Trả về phản hồi ngay lập tức cho Web để người dùng không phải chờ lâu
    res.json({ 
        success: true, 
        message: "Hệ thống đang tải Media ngầm, vui lòng kiểm tra sau vài phút." 
    });
});


// API: Polling OK -> tải audio từ voice service và lưu vào DB
// API: Chỉ zip audio đã có + assets selected -> trả về browser
app.post('/api/download-voice', async (req, res) => {
    try {
        const { videoId, postId } = req.body;
        const db = await getDb();

        const post = await db.get('SELECT title, audio_uuid FROM Post WHERE id = ?', [postId]);
        if (!post?.audio_uuid) { await db.close(); return res.json({ error: 'Chưa tạo voice!' }); }

        const lang = post.title.match(/_([a-z]{2})$/)?.[1] || 'unknown';

        // Lấy tất cả sentences kèm paragraph order
        const sentences = await db.all(
            `SELECT s.id, s.audio, s."order" as s_order, p."order" as p_order FROM Sentence s
             JOIN Paragraph p ON s.paragraph_id = p.id
             WHERE p.post_id = ? ORDER BY p."order", s."order"`,
            [postId]
        );

        // Stream thẳng vào zip
        const zipName = `${videoId}_${lang}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', e => { throw e; });
        archive.pipe(res);

        let lastPOrder = null;
        let sIndex = 0;
        for (const s of sentences) {
            if (s.p_order !== lastPOrder) { sIndex = 1; lastPOrder = s.p_order; } else { sIndex++; }
            const label = `${s.p_order}_${sIndex}`;
            const sceneFolder = `cau_${label}`;

            // Audio -> folder audio/
            if (s.audio) {
                try {
                    const audioBuf = await fetchBunnyAudio(s.audio);
                    archive.append(audioBuf, { name: `audio/${label}_audio.mp3` });
                } catch (e) { console.error(`[download-voice] skip audio ${label}:`, e.message); }
            }

            // Assets
            const assets = await db.all(
                'SELECT file_path, "order", duration FROM Asset WHERE selected = 1 AND sentence_id = ? ORDER BY "order"',
                [s.id]
            );
            for (const asset of assets) {
                const srcPath = path.join(MEDIA_DIR, asset.file_path);
                if (fs.existsSync(srcPath)) {
                    const ext = path.extname(asset.file_path);
                    const durSuffix = asset.duration ? `_${Math.round(asset.duration)}s` : '';
                    archive.file(srcPath, { name: `media/${sceneFolder}/${asset.order}${durSuffix}${ext}` });
                }
            }
        }
        await db.close();
        await archive.finalize();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const BUNNY_BASE_URL = process.env.BUNNYCDN_BASE_URL;
const BUNNY_ACCESS_KEY = process.env.BUNNYCDN_ACCESS_KEY;
const BUNNY_AUDIO_DIR = process.env.BUNNYCDN_AUDIO_DIR || 'sentences';

async function fetchBunnyAudio(audioPath) {
    const url = audioPath.startsWith('http') ? audioPath : `${BUNNY_BASE_URL}/${audioPath}`;
    const res = await fetch(url, { headers: { AccessKey: BUNNY_ACCESS_KEY } });
    if (!res.ok) throw new Error(`Bunny fetch failed: ${res.status} ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

app.post('/api/download-audio/individual', async (req, res) => {
    try {
        const { postId } = req.body;
        const { buf, filename } = await getIndividualAudio(postId);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/download-audio/merged', async (req, res) => {
    try {
        const { postId, silenceDuration = 0.5 } = req.body;
        const tmpDir = path.join(MEDIA_DIR, '_tmp_uploads', `merge_${Date.now()}`);
        const { outputFile, filename } = await getMergedAudio(postId, silenceDuration, tmpDir);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        const stream = fs.createReadStream(outputFile);
        stream.pipe(res);
        stream.on('end', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
        stream.on('error', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-batch-status', async (req, res) => {
    try {
        const { batchUuid } = req.body;
        const result = await updateBatchStatus(batchUuid);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/check-download-voice', async (req, res) => {
    try {
        const { batchUuid, postId } = req.body;
        const result = await checkAndSaveVoice(batchUuid, postId);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-media-video', async (req, res) => {
    try {
        const { videoId, lang } = req.body;
        const projectDir = path.join(MEDIA_DIR, videoId);
        const results = await processAll(projectDir, lang);
        res.json({ success: true, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', async (req, res) => {
    try {
        const result = await getMe();
        res.json(result.data || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-to-queue', async (req, res) => {
    try {
        const { uuids } = req.body;
        const result = await sendToQueue(uuids);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-sentence', async (req, res) => {
    try {
        const { uuid, reference_speaker_uuid, text } = req.body;
        const result = await updateSentence({ uuid, reference_speaker_uuid, text });
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-post-field', async (req, res) => {
    try {
        const { postId, field, value } = req.body;
        if (!['tieu_de', 'mo_bai', 'mo_bai_vi', 'tom_tat', 'tom_tat_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE Post SET ${field} = ? WHERE id = ?`, [value, postId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-para-field', async (req, res) => {
    try {
        const { paragraphId, field, value } = req.body;
        if (!['content', 'original_content', 'title', 'title_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE Paragraph SET ${field} = ? WHERE id = ?`, [value, paragraphId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-sentence-field', async (req, res) => {
    try {
        const { sentenceId, field, value } = req.body;
        if (!['content', 'original_content', 'title', 'title_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE Sentence SET ${field} = ? WHERE id = ?`, [value, sentenceId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/check-sentence-voice', async (req, res) => {
    try {
        const { sentenceUuid, sentenceId } = req.body;
        const result = await getSentenceStatus(sentenceUuid);
        const data = result.data || result;
        if (data.status === 'OK' && data.audio_url && sentenceId) {
            const db = await getDb();
            await db.run('UPDATE Sentence SET audio = ? WHERE id = ?', [data.audio_url, sentenceId]);
            await db.close();
        }
        res.json({ status: data.status, audioUrl: data.audio_url || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/languages', async (req, res) => {
    try {
        const result = await getLanguages();
        res.json(result.data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reference-speakers', async (req, res) => {
    try {
        const result = await getReferenceSpeakers(req.query.lang);
        res.json(result.data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dictionaries', async (req, res) => {
    try {
        const result = await getDictionary();
        res.json(result.data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/create-voice', async (req, res) => {
    try {
        const { videoId, postId, lang, speakerUuid, contentType, dictionaryUuids } = req.body;
        const projectDir = path.join(MEDIA_DIR, videoId);
        const result = await generateAudios(projectDir, postId, lang, speakerUuid, contentType, dictionaryUuids);

        // Lưu batchUuid vào bảng Post
        const db = await getDb();
        await db.run('UPDATE Post SET audio_uuid = ? WHERE id = ?', [result.batch_uuid, postId]);
        await db.close();

        res.json({ batch_uuid: result.batch_uuid, folderNames: result.folderNames, paragraphIds: result.paragraphIds });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Tạo mới dự án từ nội dung
app.post('/api/create-project', async (req, res) => {
    const { content, sources, targetLang } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Thiếu nội dung' });
    try {
        const projectId = 'proj_' + Date.now();
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'original_content.txt'), content.trim());
        if (sources?.length) {
            fs.writeFileSync(path.join(targetDir, 'sources.txt'), sources.join('\n'));
        }
        const crawlProcess = spawn('node', [
            'process_content.js',
            '--projectId', projectId,
            '--content', content.trim(),
            '--sources', (sources || []).join('|'),
            '--targetLang', targetLang || 'en'
        ], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        crawlProcess.stdout.on('data', d => process.stdout.write(`[process_content] ${d}`));
        crawlProcess.stderr.on('data', d => process.stderr.write(`[process_content] ${d}`));
        crawlProcess.unref();
        res.json({ success: true, projectId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Đọc log của project
app.get('/api/project-log/:projectId', (req, res) => {
    const logFile = path.join(MEDIA_DIR, req.params.projectId, 'process.log');
    if (!fs.existsSync(logFile)) return res.json({ log: '' });
    const log = fs.readFileSync(logFile, 'utf8');
    res.json({ log });
});

// API: Xóa toàn bộ project
app.post('/api/delete-project', async (req, res) => {
    const { videoId } = req.body;
    try {
        const db = await getDb();
        // Xóa tất cả posts có title là videoId hoặc bắt đầu bằng videoId_
        const posts = await db.all('SELECT id FROM Post WHERE title = ? OR title LIKE ?', [videoId, `${videoId}\_%`]);
        for (const post of posts) {
            const paras = await db.all('SELECT id FROM Paragraph WHERE post_id = ?', [post.id]);
            for (const para of paras) {
                await db.run('DELETE FROM Keyword WHERE paragraph_id = ?', [para.id]);
                await db.run('DELETE FROM Sentence WHERE paragraph_id = ?', [para.id]);
                await db.run('DELETE FROM Asset WHERE paragraph_id = ?', [para.id]);
            }
            await db.run('DELETE FROM Paragraph WHERE post_id = ?', [post.id]);
            await db.run('DELETE FROM Post WHERE id = ?', [post.id]);
        }
        await db.close();
        const folder = path.join(MEDIA_DIR, videoId);
        if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Xóa tất cả file trong folder
app.post('/api/delete-all', async (req, res) => {
    const { paragraphId, type } = req.body;
    try {
        const db = await getDb();
        const assets = await db.all(
            'SELECT id, file_path FROM Asset WHERE paragraph_id = ? AND type = ?',
            [paragraphId, type]
        );
        for (const asset of assets) {
            await db.run('DELETE FROM Asset WHERE id = ?', [asset.id]);
            const fullPath = path.join(MEDIA_DIR, asset.file_path);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
                // Xóa folder nếu trống
                const dir = path.dirname(fullPath);
                if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                    fs.rmdirSync(dir);
                }
            }
        }
        await db.close();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Xóa file
app.post('/api/delete', async (req, res) => {
    const { relativePath } = req.body;
    try {
        const db = await getDb();
        const asset = await db.get('SELECT paragraph_id, selected, "order" FROM Asset WHERE file_path = ?', [relativePath]);
        await db.run('DELETE FROM Asset WHERE file_path = ?', [relativePath]);
        // Nếu đang selected thì giảm order các asset sau
        if (asset?.selected && asset.order > 0) {
            await db.run(
                'UPDATE Asset SET "order" = "order" - 1 WHERE paragraph_id = ? AND selected = 1 AND "order" > ?',
                [asset.paragraph_id, asset.order]
            );
        }
        await db.close();
        const fullPath = path.join(MEDIA_DIR, relativePath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            const dir = path.dirname(fullPath);
            if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Toggle đổi tên
app.post('/api/unselect-asset', async (req, res) => {
    const { videoId, relativePath, order, gid, type } = req.body;
    try {
        const db = await getDb();
        const asset = await db.get('SELECT paragraph_id FROM Asset WHERE file_path = ?', [relativePath]);
        if (asset) {
            // Bỏ selected và reset order
            await db.run('UPDATE Asset SET selected = 0, "order" = 0 WHERE file_path = ?', [relativePath]);
            // Giảm order tất cả assets (cả video lẫn image) có order lớn hơn
            await db.run(
                'UPDATE Asset SET "order" = "order" - 1 WHERE paragraph_id = ? AND selected = 1 AND "order" > ?',
                [asset.paragraph_id, order]
            );
        }
        await db.close();

        // Xóa file đã tải trong folder lang
        const post = await (await getDb()).get('SELECT title FROM Post WHERE id = (SELECT post_id FROM Paragraph WHERE id = ?)', [asset?.paragraph_id]);
        if (post) {
            const lang = post.title.match(/_([a-z]{2})$/)?.[1] || 'unknown';
            const subDir = type === 'video' ? '_raw_videos' : '_raw_images';
            const targetDir = path.join(MEDIA_DIR, videoId, lang, 'assets', subDir, gid);
            if (fs.existsSync(targetDir)) {
                const files = fs.readdirSync(targetDir).filter(f => f.includes(path.basename(relativePath)));
                files.forEach(f => fs.unlinkSync(path.join(targetDir, f)));
            }
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/toggle', async (req, res) => {
    const { relativePath, action, order, sentenceId } = req.body;
    try {
        const db = await getDb();
        const selected = action === 'select' ? 1 : 0;

        if (action === 'unselect') {
            const asset = await db.get('SELECT paragraph_id, sentence_id, "order" FROM Asset WHERE file_path = ?', [relativePath]);
            if (asset) {
                const pid = asset.paragraph_id || await db.get('SELECT paragraph_id FROM Sentence WHERE id = ?', [asset.sentence_id]).then(r => r?.paragraph_id);
                await db.run(
                    'UPDATE Asset SET "order" = "order" - 1 WHERE paragraph_id = ? AND selected = 1 AND "order" > ?',
                    [pid, asset.order]
                );
                await db.run('UPDATE Asset SET selected = 0, "order" = 0, sentence_id = NULL, paragraph_id = ? WHERE file_path = ?', [pid, relativePath]);
            }
        } else {
            // Tính duration cho video nếu chưa có
            const existing = await db.get('SELECT duration, type FROM Asset WHERE file_path = ?', [relativePath]);
            let duration = existing?.duration || null;
            if (!duration && existing?.type === 'video') {
                try {
                    const { execSync } = await import('child_process');
                    const fullPath = path.join(MEDIA_DIR, relativePath);
                    const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fullPath}"`);
                    duration = parseFloat(out.toString().trim());
                } catch (e) {}
            }
            await db.run(
                'UPDATE Asset SET selected = 1, "order" = ?, sentence_id = ?, duration = COALESCE(?, duration), paragraph_id = CASE WHEN ? IS NOT NULL THEN NULL ELSE paragraph_id END WHERE file_path = ?',
                [order || 0, sentenceId || null, duration, sentenceId || null, relativePath]
            );
        }

        await db.close();
        res.json({ success: true, selected });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const upload = multer({ dest: path.join(MEDIA_DIR, '_tmp_uploads') });

app.post('/api/download-url', async (req, res) => {
    try {
        const { url, videoId, paragraphId } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        const targetDir = path.join(MEDIA_DIR, videoId, 'assets', '_raw_videos', String(paragraphId));
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const fileName = `dl_social_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`;
        const destPath = path.join(targetDir, fileName);

        // 🟢 UY THÁC VIỆC TẢI CHO MODULE YT-DLP
        await downloadWithYtDlp(url, destPath);

        // 🟢 NẾU HÀM TRÊN KHÔNG BÁO LỖI (THROW ERROR), TIẾP TỤC LƯU DB
        const relativePath = path.relative(MEDIA_DIR, destPath);
        const db = await getDb();
        await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [paragraphId, 'video', relativePath]);
        await db.close();

        res.json({ success: true, path: relativePath });

    } catch (e) { 
        // Lỗi sẽ tự động văng xuống đây và trả về cho Frontend
        console.error('[API DL Lỗi]', e.message);
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const { videoId, groupId, paragraphId, type } = req.body;
        const targetDir = path.join(MEDIA_DIR, videoId, 'assets', type === 'video' ? '_raw_videos' : '_raw_images', groupId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const db = await getDb();
        for (const file of req.files) {
            const ext = path.extname(file.originalname);
            const fileName = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
            const destPath = path.join(targetDir, fileName);
            fs.renameSync(file.path, destPath);

            const relativePath = path.relative(MEDIA_DIR, destPath);
            await db.run(
                'INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)',
                [paragraphId, type, relativePath]
            );
        }
        await db.close();
        res.json({ success: true, count: req.files.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-duration', async (req, res) => {
    const { relativePath, duration } = req.body;
    try {
        const db = await getDb();
        await db.run('UPDATE Asset SET duration = ? WHERE file_path = ?', [duration, relativePath]);
        await db.close();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/crop', async (req, res) => {
    const { relativePath, x, y, width, height, duration } = req.body;
    const fullPath = path.join(MEDIA_DIR, relativePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '404' });
    const ext = path.extname(fullPath);
    const outPath = fullPath.replace(ext, `_cropped${ext}`);
    try {
        const { execSync } = await import('child_process');
        execSync(`ffmpeg -i "${fullPath}" -vf "crop=${width}:${height}:${x}:${y}" -y "${outPath}"`);
        // Ghi đè lên file gốc
        fs.renameSync(outPath, fullPath);
        const db = await getDb();
        await db.run('UPDATE Asset SET duration = ? WHERE file_path = ?', [duration || null, relativePath]);
        await db.close();
        res.json({ success: true, newRelativePath: relativePath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trim', async (req, res) => {
    const { relativePath, start, end, duration } = req.body;
    const fullPath = path.join(MEDIA_DIR, relativePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '404' });
    const ext = path.extname(fullPath);
    const base = fullPath.slice(0, -ext.length);
    const ts = Date.now();
    const trimmedPath = `${base}_trim_${ts}${ext}`;
    const trimmedRelative = path.relative(MEDIA_DIR, trimmedPath);
    try {
        const { execSync } = await import('child_process');
        const dur = end - start;
        execSync(`ffmpeg -ss ${start} -t ${dur} -i "${fullPath}" -c copy -y "${trimmedPath}"`);

        const db = await getDb();
        const orig = await db.get('SELECT id, paragraph_id, sentence_id, type, selected, "order" FROM Asset WHERE file_path = ?', [relativePath]);
        if (orig) {
            // Unselect file gốc
            await db.run('UPDATE Asset SET selected = 0, "order" = 0 WHERE id = ?', [orig.id]);
            // File trim chính - kế thừa selected/order của file gốc
            await db.run(
                'INSERT INTO Asset (paragraph_id, sentence_id, type, selected, "order", duration, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [orig.paragraph_id, orig.sentence_id, orig.type, orig.selected, orig.order, duration || null, trimmedRelative]
            );
            // Phần trước [0, start]
            if (start > 0.5) {
                const beforePath = `${base}_trim_before_${ts}${ext}`;
                const beforeRelative = path.relative(MEDIA_DIR, beforePath);
                try {
                    execSync(`ffmpeg -ss 0 -t ${start} -i "${fullPath}" -c copy -y "${beforePath}"`);
                    await db.run(
                        'INSERT INTO Asset (paragraph_id, sentence_id, type, selected, "order", duration, file_path) VALUES (?, NULL, ?, 0, 0, ?, ?)',
                        [orig.paragraph_id || await db.get('SELECT paragraph_id FROM Sentence WHERE id = ?', [orig.sentence_id]).then(r => r?.paragraph_id), orig.type, Math.round(start * 10) / 10, beforeRelative]
                    );
                } catch(e) { /* bỏ qua nếu lỗi */ }
            }
            // Phần sau [end, total]
            const totalDur = await (async () => {
                try {
                    const { execSync } = await import('child_process');
                    const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fullPath}"`);
                    return parseFloat(out.toString().trim());
                } catch(e) { return orig.duration || 0; }
            })();
            if (totalDur && (totalDur - end) > 0.5) {
                const afterPath = `${base}_trim_after_${ts}${ext}`;
                const afterRelative = path.relative(MEDIA_DIR, afterPath);
                try {
                    execSync(`ffmpeg -ss ${end} -i "${fullPath}" -c copy -y "${afterPath}"`);
                    const paraId = orig.paragraph_id || await db.get('SELECT paragraph_id FROM Sentence WHERE id = ?', [orig.sentence_id]).then(r => r?.paragraph_id);
                    await db.run(
                        'INSERT INTO Asset (paragraph_id, sentence_id, type, selected, "order", duration, file_path) VALUES (?, NULL, ?, 0, 0, ?, ?)',
                        [paraId, orig.type, Math.round((totalDur - end) * 10) / 10, afterRelative]
                    );
                } catch(e) { /* bỏ qua nếu lỗi */ }
            }
        }
        await db.close();
        res.json({ success: true, newRelativePath: trimmedRelative });
    } catch (e) {
        if (fs.existsSync(trimmedPath)) fs.unlinkSync(trimmedPath);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/open-folder', async (req, res) => {
    const { videoId, postId, gid, type } = req.body;
    const db = await getDb();
    const post = await db.get('SELECT title FROM Post WHERE id = ?', [postId]);
    await db.close();
    const lang = post?.title?.match(/_([a-z]{2})$/)?.[1] || 'unknown';
    const subDir = type === 'video' ? '_raw_videos' : '_raw_images';
    const folderPath = path.join(MEDIA_DIR, videoId, lang, 'assets', subDir, gid);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    const { platform } = process;
    const cmd = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [folderPath], { detached: true });
    res.json({ success: true });
});

// API: AI Generate Image/Video (Google Flow)
app.post('/api/ai-generate', async (req, res) => {
    const { videoId, paragraphId, gid, keywords, type, content, count, lang, prompt, ratio, videoMode, veo } = req.body;
    if (!keywords?.length) return res.status(400).json({ error: 'Không có keyword' });

    const subDir = type === 'video' ? '_raw_videos_ai_gen' : '_raw_images_ai_gen';
    const targetDir = path.join(MEDIA_DIR, videoId, 'assets', subDir, gid);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    res.json({ success: true, message: `Đang tạo ${type} AI...` });

    (async () => {
        const db = await getDb();

        // Lấy ảnh selected của paragraph nếu là Ingredients mode
        let selectedImages = [];
        if (videoMode === 'Ingredients') {
            const assets = await db.all(
                'SELECT file_path FROM Asset WHERE paragraph_id = ? AND type = ? AND selected = 1 ORDER BY "order"',
                [paragraphId, 'image']
            );
            selectedImages = assets.map(a => path.join(MEDIA_DIR, a.file_path));
        }

        const saved = await generateFlowImage(keywords.join(', '), targetDir, content || '', type, count || 2, lang || 'en', prompt || '', ratio || '16:9', videoMode || 'Frames', veo || 'Lite', selectedImages);
        for (const fileName of saved) {
            const relativePath = path.join(videoId, 'assets', subDir, gid, fileName);
            const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [relativePath]);
            if (!exists) {
                const assetType = fileName.includes('_thumbnail.') ? 'image' : type;
                await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, selected, "order", file_path) VALUES (?, NULL, ?, 0, 0, ?)', [paragraphId, assetType, relativePath]);
            }
        }
        await db.close();
        console.log(`[AI Generate] Done ${type} for paragraph ${paragraphId}`);
    })().catch(e => console.error('[AI Generate] Error:', e.message));
});

// API: Mở trình duyệt đăng nhập cho profile
app.post('/api/chrome-profiles/:id/login', async (req, res) => {
    try {
        const db = await getDb();
        const profile = await db.get('SELECT id, email, password FROM ChromeProfile WHERE id = ?', [req.params.id]);
        await db.close();
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        const profileDirName = `chrome-profile-${profile.id}`;
        const args = ['browser.js', profileDirName];
        if (profile.email) args.push(profile.email);
        if (profile.password) args.push(profile.password);

        // Cập nhật profile_dir vào DB
        const db2 = await getDb();
        await db2.run('UPDATE ChromeProfile SET profile_dir = ? WHERE id = ?', [profileDirName, profile.id]);
        await db2.close();

        const child = spawn('node', args, { detached: false, stdio: 'inherit' });
        child.unref();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Đọc proxies.txt
app.get('/api/proxies', (req, res) => {
    const proxyFile = path.join(__dirname, 'proxies.txt');
    if (!fs.existsSync(proxyFile)) return res.json([]);
    const lines = fs.readFileSync(proxyFile, 'utf8').trim().split('\n').filter(l => l.trim());
    res.json(lines);
});

// API: ChromeProfile CRUD
app.get('/api/chrome-profiles', async (req, res) => {
    try {
        const db = await getDb();
        const profiles = await db.all('SELECT id, profile_dir, email, updated_at FROM ChromeProfile ORDER BY updated_at DESC');
        await db.close();
        res.json(profiles);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chrome-profiles', async (req, res) => {
    const { email, password } = req.body;
    try {
        const db = await getDb();
        await db.run('INSERT INTO ChromeProfile (email, password, updated_at) VALUES (?, ?, 0)', [email || null, password || null]);
        await db.close();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chrome-profiles/:id/delete', async (req, res) => {
    try {
        const db = await getDb();
        const profile = await db.get('SELECT profile_dir FROM ChromeProfile WHERE id = ?', [req.params.id]);
        await db.run('DELETE FROM ChromeProfile WHERE id = ?', [req.params.id]);
        await db.close();
        if (profile?.profile_dir) {
            const fullPath = path.join(process.env.SETTING_DIR, profile.profile_dir);
            if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { recursive: true, force: true });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Lấy prompt theo type và lang
app.get('/api/get-prompt', (req, res) => {
    const { type, lang } = req.query;
    const promptFile = path.join(MEDIA_DIR, 'prompts', type || 'image', `prompt_flow_${lang || 'en'}.txt`);
    const fallbackFile = path.join(MEDIA_DIR, 'prompts', type || 'image', 'prompt_flow.txt');
    const raw = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : fs.existsSync(fallbackFile) ? fs.readFileSync(fallbackFile, 'utf8') : '';
    res.json({ prompt: raw.trim().replace(/\n/g, ' ') });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname));
app.use(express.static(MEDIA_DIR, {
    setHeaders: (res, path) => {
        res.setHeader('Accept-Ranges', 'bytes'); // Cho phép trình duyệt yêu cầu từng đoạn video để tua
    }
}));
// SSE clients
const sseClients = new Set();

export function pushCrawlStatus(postTitle, status) {
    const data = JSON.stringify({ postTitle, status });
    for (const client of sseClients) {
        client.write(`data: ${data}\n\n`);
    }
}

app.get('/api/crawl-status/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

app.post('/api/crawl-status/notify', (req, res) => {
    const { postTitle, status } = req.body;
    pushCrawlStatus(postTitle, status);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
