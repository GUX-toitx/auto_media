import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { getLanguages, getReferenceSpeakers, generateAudios, updateBatchStatus, downloadBatchAudios } from './audio_service.js';
import { processAll } from './video_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3000;

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';

app.use(express.json()); // BẮT BUỘC PHẢI CÓ DÒNG NÀY Ở ĐÂY

// API: Lưu Kịch bản và Keywords
app.post('/api/save-content', (req, res) => {
    const { videoId, groupId, script, keywords } = req.body;
    const vPath = path.join(MEDIA_DIR, videoId, 'assets', '_raw_videos', groupId);
    const iPath = path.join(MEDIA_DIR, videoId, 'assets', '_raw_images', groupId);

    try {
        if (!fs.existsSync(vPath)) fs.mkdirSync(vPath, { recursive: true });
        fs.writeFileSync(path.join(vPath, 'context.txt'), script || '', 'utf-8');
        if (Array.isArray(keywords)) {
            const kwStr = keywords.join(', ');
            fs.writeFileSync(path.join(vPath, 'keywords.txt'), kwStr, 'utf-8');
            if (fs.existsSync(iPath)) {
                fs.writeFileSync(path.join(iPath, 'context.txt'), script || '', 'utf-8');
                fs.writeFileSync(path.join(iPath, 'keywords.txt'), kwStr, 'utf-8');
            }
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Lỗi ghi file" }); }
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
        '--groupId', groupId, 
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

// API: Quét thư mục
app.get('/api/scan', (req, res) => {
    const db = {};
    if (!fs.existsSync(MEDIA_DIR)) return res.json(db);
    const projects = fs.readdirSync(MEDIA_DIR).filter(f => fs.statSync(path.join(MEDIA_DIR, f)).isDirectory());

    for (const vid of projects) {
        const assetsDir = path.join(MEDIA_DIR, vid, 'assets');
        if (!fs.existsSync(assetsDir)) continue;
        db[vid] = { langs: [], contexts: {}, keywords: {}, videos: {}, images: {}, generatedVideos: {} };
        const langSet = new Set();

        // Quét Video & Meta
        const vDir = path.join(assetsDir, '_raw_videos');
        if (fs.existsSync(vDir)) {
            const groups = fs.readdirSync(vDir).filter(f => fs.statSync(path.join(vDir, f)).isDirectory());
            groups.forEach(g => {
                const gPath = path.join(vDir, g);
                const files = fs.readdirSync(gPath);
                db[vid].videos[g] = [];
                files.forEach(f => {
                    if (f === 'context.txt') db[vid].contexts[g] = fs.readFileSync(path.join(gPath, f), 'utf-8');
                    else if (f === 'keywords.txt') db[vid].keywords[g] = fs.readFileSync(path.join(gPath, f), 'utf-8').split(',').map(k => k.trim());
                    else if (f.endsWith('.context.txt') && f !== 'context.txt') langSet.add(f.replace('.context.txt', ''));
                    else if (f.endsWith('.mp4')) db[vid].videos[g].push({ name: f, url: `/${vid}/assets/_raw_videos/${g}/${f}`, relativePath: `${vid}/assets/_raw_videos/${g}/${f}`, isSelected: f.includes('[selected]') });
                });
                db[vid].videos[g].sort((a, b) => parseInt(a.name.match(/\d+/)?.[0] || 0) - parseInt(b.name.match(/\d+/)?.[0] || 0));
            });
        }
        db[vid].langs = langSet;
        db[vid].audios = {};

        // Quét Video Generated & Audios
        const outDir = path.join(MEDIA_DIR, vid, 'output');
        if (fs.existsSync(outDir)) {
            fs.readdirSync(outDir).filter(l => fs.statSync(path.join(outDir, l)).isDirectory()).forEach(lang => {
                langSet.add(lang);
                const aOutDir = path.join(outDir, lang, 'audios');
                if (fs.existsSync(aOutDir)) {
                    if (!db[vid].audios[lang]) db[vid].audios[lang] = {};
                    fs.readdirSync(aOutDir).filter(f => f.endsWith('.mp3')).forEach(f => {
                        const sentenceIdx = f.replace('.mp3', '');
                        db[vid].audios[lang][sentenceIdx] = { name: f, url: `/${vid}/output/${lang}/audios/${f}` };
                    });
                }
                const vOutDir = path.join(outDir, lang, 'videos');
                if (!fs.existsSync(vOutDir)) return;
                if (!db[vid].generatedVideos[lang]) db[vid].generatedVideos[lang] = {};
                fs.readdirSync(vOutDir).filter(f => f.endsWith('.mp4')).forEach(f => {
                    const sentenceIdx = f.split('_')[0];
                    if (!db[vid].generatedVideos[lang][sentenceIdx]) db[vid].generatedVideos[lang][sentenceIdx] = [];
                    db[vid].generatedVideos[lang][sentenceIdx].push({ name: f, url: `/${vid}/output/${lang}/videos/${f}` });
                });
            });
        }

        // Quét Ảnh
        const iDir = path.join(assetsDir, '_raw_images');
        if (fs.existsSync(iDir)) {
            const groups = fs.readdirSync(iDir).filter(f => fs.statSync(path.join(iDir, f)).isDirectory());
            groups.forEach(g => {
                const gPath = path.join(iDir, g);
                db[vid].images[g] = [];
                fs.readdirSync(gPath).forEach(f => {
                    if (f.endsWith('.jpg') || f.endsWith('.png')) db[vid].images[g].push({ name: f, url: `/${vid}/assets/_raw_images/${g}/${f}`, relativePath: `${vid}/assets/_raw_images/${g}/${f}`, isSelected: f.includes('[selected]') });
                });
                db[vid].images[g].sort((a, b) => parseInt(a.name.match(/\d+/)?.[0] || 0) - parseInt(b.name.match(/\d+/)?.[0] || 0));
            });
        }
    }
    // Gộp tất cả ngôn ngữ từ mọi project
    const allLangs = new Set();
    for (const vid of Object.keys(db)) {
        for (const l of db[vid].langs) allLangs.add(l);
    }
    const allLangsArr = [...allLangs];
    for (const vid of Object.keys(db)) {
        db[vid].langs = allLangsArr;
    }
    res.json(db);
});

// API: Xóa file
app.post('/api/delete', (req, res) => {
    const { relativePath } = req.body;
    const fullPath = path.join(MEDIA_DIR, relativePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '404' });
    fs.unlinkSync(fullPath);
    res.json({ success: true });
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

app.post('/api/generate-media', (req, res) => res.json({ success: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(MEDIA_DIR, {
    setHeaders: (res, path) => {
        res.setHeader('Accept-Ranges', 'bytes'); // Cho phép trình duyệt yêu cầu từng đoạn video để tua
    }
}));
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
