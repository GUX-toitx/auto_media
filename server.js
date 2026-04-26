import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import multer from 'multer';

import { getLanguages, getReferenceSpeakers, generateAudios, updateBatchStatus, downloadBatchAudios } from './audio_service.js';
import { processAll } from './video_service.js';
import { generateFlowImage } from './browser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3000;

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || '/usr/gux/media-team';

app.use(express.json()); // BẮT BUỘC PHẢI CÓ DÒNG NÀY Ở ĐÂY

const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');
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
            'SELECT id, content, original_content, audio FROM Paragraph WHERE post_id = ? ORDER BY id',
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
                'SELECT id, type, selected, "order", file_path FROM Asset WHERE paragraph_id = ? ORDER BY id',
                [para.id]
            );
            para.videos = assets
                .filter(a => a.type === 'video')
                .map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0 }));
            para.images = assets
                .filter(a => a.type === 'image')
                .map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0 }));

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


app.post('/api/download-voice', async (req, res) => {
    try {
        const { videoId, postId } = req.body;
        const db = await getDb();

        const post = await db.get('SELECT title, audio_uuid FROM Post WHERE id = ?', [postId]);
        if (!post?.audio_uuid) { await db.close(); return res.json({ error: 'Chưa tạo voice!' }); }

        const lang = post.title.match(/_([a-z]{2})$/)?.[1] || 'unknown';

        const paragraphs = await db.all(
            'SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY "order"', [postId]
        );
        const folderNames = paragraphs.map(p => String(p.order));
        const paragraphIds = paragraphs.map(p => p.id);

        // 1. Tải audio
        const baseDir = path.join(MEDIA_DIR, videoId, lang, 'audios');
        const result = await downloadBatchAudios(post.audio_uuid, baseDir, folderNames, paragraphIds);
        if (!result) { await db.close(); return res.json({ error: 'Batch chưa gen xong' }); }

        for (const r of result.results) {
            if (r.paragraphId) {
                await db.run('UPDATE Paragraph SET audio = ? WHERE id = ?', [r.relativePath, r.paragraphId]);
            }
        }

        // 2. Copy selected assets vào folder theo lang
        // Xóa sạch folder assets cũ trước khi copy mới
        const assetsDir = path.join(MEDIA_DIR, videoId, lang, 'assets');
        if (fs.existsSync(assetsDir)) fs.rmSync(assetsDir, { recursive: true, force: true });

        for (const para of paragraphs) {
            const assets = await db.all(
                'SELECT type, file_path, "order" FROM Asset WHERE paragraph_id = ? AND selected = 1 ORDER BY "order"',
                [para.id]
            );
            for (const asset of assets) {
                const subDir = asset.type === 'video' ? '_raw_videos' : '_raw_images';
                const targetDir = path.join(MEDIA_DIR, videoId, lang, 'assets', subDir, String(para.order));
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                const srcPath = path.join(MEDIA_DIR, asset.file_path);
                if (fs.existsSync(srcPath)) {
                    const destPath = path.join(targetDir, `${asset.order}_${path.basename(asset.file_path)}`);
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        }

        await db.close();
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
        const { videoId, postId, lang, speakerUuid } = req.body;
        const projectDir = path.join(MEDIA_DIR, videoId);
        const result = await generateAudios(projectDir, postId, lang, speakerUuid);

        // Lưu batchUuid vào bảng Post
        const db = await getDb();
        await db.run('UPDATE Post SET audio_uuid = ? WHERE id = ?', [result.batch_uuid, postId]);
        await db.close();

        res.json({ batch_uuid: result.batch_uuid, folderNames: result.folderNames, paragraphIds: result.paragraphIds });
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
        await db.run('DELETE FROM Asset WHERE file_path = ?', [relativePath]);
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
            // Giảm order các asset cùng type có order lớn hơn
            await db.run(
                'UPDATE Asset SET "order" = "order" - 1 WHERE paragraph_id = ? AND type = ? AND selected = 1 AND "order" > ?',
                [asset.paragraph_id, type, order]
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
    const { relativePath, action, order } = req.body;
    try {
        const db = await getDb();
        const selected = action === 'select' ? 1 : 0;

        if (action === 'unselect') {
            const asset = await db.get('SELECT paragraph_id, "order" FROM Asset WHERE file_path = ?', [relativePath]);
            if (asset) {
                await db.run(
                    'UPDATE Asset SET "order" = "order" - 1 WHERE paragraph_id = ? AND selected = 1 AND "order" > ?',
                    [asset.paragraph_id, asset.order]
                );
            }
        }

        await db.run('UPDATE Asset SET selected = ?, "order" = ? WHERE file_path = ?', [selected, order || 0, relativePath]);
        await db.close();
        res.json({ success: true, selected });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const upload = multer({ dest: path.join(MEDIA_DIR, '_tmp_uploads') });

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

app.post('/api/crop', async (req, res) => {
    const { relativePath, x, y, width, height } = req.body;
    const fullPath = path.join(MEDIA_DIR, relativePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '404' });
    const ext = path.extname(fullPath);
    const outPath = fullPath.replace(ext, `_cropped${ext}`);
    try {
        const { execSync } = await import('child_process');
        execSync(`ffmpeg -i "${fullPath}" -vf "crop=${width}:${height}:${x}:${y}" -y "${outPath}"`);
        const newRelativePath = relativePath.replace(ext, `_cropped${ext}`);
        const db = await getDb();
        const asset = await db.get('SELECT id, paragraph_id, type FROM Asset WHERE file_path = ?', [relativePath]);
        if (asset) await db.run('INSERT OR IGNORE INTO Asset (paragraph_id, type, selected, file_path) VALUES (?, ?, 0, ?)', [asset.paragraph_id, asset.type, newRelativePath]);
        await db.close();
        res.json({ success: true, newRelativePath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trim', async (req, res) => {
    const { relativePath, start, end } = req.body;
    const fullPath = path.join(MEDIA_DIR, relativePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '404' });
    const ext = path.extname(fullPath);
    const tmpPath = fullPath.replace(ext, `_tmp${ext}`);
    try {
        const { execSync } = await import('child_process');
        const duration = end - start;
        execSync(`ffmpeg -ss ${start} -t ${duration} -i "${fullPath}" -c copy -y "${tmpPath}"`);
        fs.renameSync(tmpPath, fullPath);
        res.json({ success: true });
    } catch (e) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
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

// API: Lấy prompt theo type và lang
app.get('/api/get-prompt', (req, res) => {
    const { type, lang } = req.query;
    const promptFile = path.join(MEDIA_DIR, 'prompts', type || 'image', `prompt_flow_${lang || 'en'}.txt`);
    const fallbackFile = path.join(MEDIA_DIR, 'prompts', type || 'image', 'prompt_flow.txt');
    const raw = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : fs.existsSync(fallbackFile) ? fs.readFileSync(fallbackFile, 'utf8') : '';
    res.json({ prompt: raw.trim().replace(/\n/g, ' ') });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(MEDIA_DIR, {
    setHeaders: (res, path) => {
        res.setHeader('Accept-Ranges', 'bytes'); // Cho phép trình duyệt yêu cầu từng đoạn video để tua
    }
}));
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
