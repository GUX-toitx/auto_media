import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

import { getLanguages, getReferenceSpeakers, generateAudios, updateBatchStatus, downloadBatchAudios } from './audio_service.js';
import { processAll } from './video_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3000;

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';

app.use(express.json()); // BẮT BUỘC PHẢI CÓ DÒNG NÀY Ở ĐÂY

const DB_PATH = path.join(MEDIA_DIR, 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

// API: Lấy danh sách posts
app.get('/api/posts', async (req, res) => {
    try {
        const db = await getDb();
        const posts = await db.all('SELECT id, title FROM Post ORDER BY id DESC');
        await db.close();
        res.json(posts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Chi tiết 1 post: paragraphs + keywords + assets (file media quét từ thư mục)
app.get('/api/posts/:postId', async (req, res) => {
    try {
        const db = await getDb();
        const post = await db.get('SELECT id, title FROM Post WHERE id = ?', [req.params.postId]);
        if (!post) return res.status(404).json({ error: 'Post not found' });

        const paragraphs = await db.all(
            'SELECT id, content, original_content FROM Paragraph WHERE post_id = ? ORDER BY id',
            [post.id]
        );

        // Lấy tên thư mục gốc (bỏ suffix _en, _vi...)
        const projectId = post.title.replace(/_[a-z]{2}$/, '');

        for (let i = 0; i < paragraphs.length; i++) {
            const para = paragraphs[i];
            const gid = String(i + 1);

            // Keywords từ DB
            para.keywords = (await db.all(
                'SELECT content FROM Keyword WHERE paragraph_id = ? ORDER BY id',
                [para.id]
            )).map(r => r.content);

            // File media từ DB
            const assets = await db.all(
                'SELECT id, type, file_path FROM Asset WHERE paragraph_id = ? ORDER BY id',
                [para.id]
            );
            para.videos = assets
                .filter(a => a.type === 'video')
                .map(a => ({ name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, isSelected: a.file_path.includes('[selected]') }));
            para.images = assets
                .filter(a => a.type === 'image')
                .map(a => ({ name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, isSelected: a.file_path.includes('[selected]') }));

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

app.post('/api/save-batch-info', (req, res) => {
    const { videoId, batchUuid, lang, folderNames } = req.body;
    const filePath = path.join(MEDIA_DIR, videoId, 'batches.json');
    const batches = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : [];
    batches.push({ batchUuid, lang, folderNames: folderNames || [], createdAt: new Date().toISOString() });
    fs.writeFileSync(filePath, JSON.stringify(batches, null, 2), 'utf-8');
    res.json({ success: true });
});

app.get('/api/batch-info', (req, res) => {
    const { videoId } = req.query;
    const filePath = path.join(MEDIA_DIR, videoId, 'batches.json');
    if (!fs.existsSync(filePath)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
});

app.post('/api/download-voice', async (req, res) => {
    try {
        const { videoId, batchUuid, lang, folderNames } = req.body;
        const outputDir = path.join(MEDIA_DIR, videoId, 'output', lang, 'audios');
        const result = await downloadBatchAudios(batchUuid, outputDir, folderNames || []);
        if (!result) return res.json({ error: 'Batch chưa gen xong' });
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-batch-status', async (req, res) => {
    try {
        const { batchUuid } = req.body;
        const result = await updateBatchStatus(batchUuid);
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

app.get('/api/languages', async (req, res) => {
    try {
        const result = await getLanguages();
        res.json(result.data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reference-speakers', async (req, res) => {
    try {
        const result = await getReferenceSpeakers();
        res.json(result.data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/create-voice', async (req, res) => {
    try {
        const { videoId, lang, speakerUuid } = req.body;
        const projectDir = path.join(MEDIA_DIR, videoId);
        const result = await generateAudios(projectDir, lang, speakerUuid);
        res.json({ batch_uuid: result.batch_uuid, folderNames: result.folderNames });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    const { videoId, groupId, type } = req.body;
    try {
        const db = await getDb();
        const assets = await db.all(
            `SELECT Asset.id, Asset.file_path FROM Asset
             JOIN Paragraph ON Asset.paragraph_id = Paragraph.id
             JOIN Post ON Paragraph.post_id = Post.id
             WHERE (Post.title = ? OR Post.title LIKE ?) AND Asset.type = ? AND Asset.file_path LIKE ?`,
            [videoId, `${videoId}\_%`, type, `%/_raw_${type === 'video' ? 'videos' : 'images'}/${groupId}/%`]
        );
        for (const asset of assets) {
            await db.run('DELETE FROM Asset WHERE id = ?', [asset.id]);
            const fullPath = path.join(MEDIA_DIR, asset.file_path);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
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
        await db.run('DELETE FROM Asset WHERE file_path = ?', [relativePath]);
        await db.close();
        const fullPath = path.join(MEDIA_DIR, relativePath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Toggle đổi tên
app.post('/api/toggle', (req, res) => {
    const { relativePath, action } = req.body;
    const fullPath = path.join(MEDIA_DIR, relativePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '404' });
    const dir = path.dirname(fullPath);
    const oldName = path.basename(fullPath);
    let newName = action === 'select' ? `[selected]_${oldName.replace('[selected]_', '')}` : oldName.replace('[selected]_', '');
    fs.renameSync(fullPath, path.join(dir, newName));
    res.json({ success: true, newRelativePath: path.join(path.dirname(relativePath), newName).replace(/\\/g, '/') });
});

app.post('/api/open-folder', (req, res) => {
    const { videoId, lang } = req.body;
    const folderPath = path.join(MEDIA_DIR, videoId, 'output', lang, 'videos');
    const { platform } = process;
    const cmd = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [folderPath], { detached: true });
    res.json({ success: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(MEDIA_DIR, {
    setHeaders: (res, path) => {
        res.setHeader('Accept-Ranges', 'bytes'); // Cho phép trình duyệt yêu cầu từng đoạn video để tua
    }
}));
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
