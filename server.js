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

import { getLanguages, getReferenceSpeakers, getDictionary, getMe, sendToQueue, getSentenceStatus, updateSentence, generateAudios, updateBatchStatus, getBatchAudios, checkAndSaveVoice, getIndividualAudio, getMergedAudio, getAllAudioUrls } from './handle_voice/audio_service.js';
import { alignPost } from './handle_voice/align_service.js';
import { processAll } from './video_service.js';
import { generateFlowImage } from './browser.js';
import { crawlX } from './x_crawler.js';
import { generateSeoTitle } from './seoTitle.js';
import { translateTitle } from './translateTitle.js';
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
        const posts = await db.all('SELECT id, project_id, status, audio_uuid, COALESCE(title, project_id) AS title, voice_content_type FROM Post ORDER BY id DESC');
        await db.close();
        res.json(posts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Chi tiết 1 post: paragraphs + keywords + assets (file media quét từ thư mục)
app.get('/api/posts/:postId', async (req, res) => {
    try {
        const db = await getDb();
        const post = await db.get('SELECT id, project_id, title, hook, hook_vi, hook_audio, hook_vi_audio, summary, summary_vi, summary_audio, summary_vi_audio, summary_target, summary_target_audio, conclusion_vi, conclusion_vi_audio, conclusion_target, conclusion_target_audio, intro_path, outro_path, seo_title FROM Post WHERE id = ?', [req.params.postId]);
        if (!post) return res.status(404).json({ error: 'Post not found' });

        // HookDetail
        post.hook_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM HookDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );
        // Load assets for each hook_detail
        for (const detail of post.hook_details) {
            const assets = await db.all('SELECT id, type, selected, "order", file_path, duration FROM Asset WHERE hook_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
            detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
            detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
        }
        
        // ConclusionDetail
        post.conclusion_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM ConclusionDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );
        for (const detail of post.conclusion_details) {
            const assets = await db.all('SELECT id, type, selected, "order", file_path, duration FROM Asset WHERE conclusion_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
            detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
            detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
        }
        
        // SummaryDetail
        post.summary_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM SummaryDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );
        // Load assets for each summary_detail
        for (const detail of post.summary_details) {
            const assets = await db.all('SELECT id, type, selected, "order", file_path, duration FROM Asset WHERE summary_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
            detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
            detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
        }

        // Lấy keywords và assets cho từng section của post
        const sections = {};
        for (const section of ['hook', 'summary', 'conclusion', 'thumbnail', 'x']) {
            const kws = await db.all('SELECT id, content, type FROM Keyword WHERE post_id = ? AND section = ? ORDER BY id', [post.id, section]);
            const assets = await db.all('SELECT id, type, selected, "order", file_path, duration, source_url FROM Asset WHERE post_id = ? AND section = ? AND hook_detail_id IS NULL AND summary_detail_id IS NULL AND conclusion_detail_id IS NULL ORDER BY selected DESC, COALESCE(source_id, id), id', [post.id, section]);
            const projectId = (post.project_id || '').replace(/_[a-z]{2}$/, '');
            sections[section] = {
                keywords: kws,
                videos: assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null })),
                images: assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null })),
            };
        }

        const paragraphs = await db.all(
            'SELECT id, content, content_vi, title, title_vi, content_audio, content_vi_audio, title_audio, title_vi_audio, title_wt, title_vi_wt FROM Paragraph WHERE post_id = ? ORDER BY id',
            [post.id]
        );

        // Lấy tên thư mục gốc (bỏ suffix _en, _vi...)
        const projectId = post.project_id.replace(/_[a-z]{2}$/, '');

        for (let i = 0; i < paragraphs.length; i++) {
            const para = paragraphs[i];
            const gid = String(i + 1);

            // ParagraphDetail
            para.details = await db.all(
                'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"',
                [para.id]
            );
            // Load assets for each paragraph_detail
            for (const detail of para.details) {
                const assets = await db.all('SELECT id, type, selected, "order", file_path, duration FROM Asset WHERE paragraph_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
                detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
                detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
            }
            const rawSentences = await db.all(
                'SELECT id, content, content_vi, title, title_vi, content_audio, content_vi_audio, title_audio, title_vi_audio, title_wt, title_vi_wt, audio, sentence_uuid, "order" FROM Sentence WHERE paragraph_id = ? ORDER BY "order"',
                [para.id]
            );
            para.sentences = await Promise.all(rawSentences.map(async s => {
                const details = await db.all(
                    'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM SentenceDetail WHERE sentence_id = ? ORDER BY "order"',
                    [s.id]
                );
                // Load assets for each sentence_detail
                for (const detail of details) {
                    const assets = await db.all('SELECT id, type, selected, "order", file_path, duration FROM Asset WHERE sentence_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
                    detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
                    detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0 }));
                }
                return { ...s, sentenceUuid: s.sentence_uuid, audioUrl: s.audio ? (s.audio.startsWith('http') ? s.audio : `/${s.audio}`) : null, details };
            }));

            // Keywords từ DB
            para.keywords = (await db.all(
                'SELECT id, content, type FROM Keyword WHERE paragraph_id = ? ORDER BY id',
                [para.id]
            ));

            // File media từ DB (exclude assets assigned to details)
            const assets = await db.all(
                'SELECT id, type, selected, "order", file_path, sentence_id, paragraph_id, duration FROM Asset WHERE (paragraph_id = ? OR sentence_id IN (SELECT id FROM Sentence WHERE paragraph_id = ?)) AND paragraph_detail_id IS NULL AND sentence_detail_id IS NULL ORDER BY id',
                [para.id, para.id]
            );
            para.videos = assets
                .filter(a => a.type === 'video' && (a.paragraph_id || a.sentence_id))
                .map(a => ({ id: a.id, type: 'video', name: path.basename(a.file_path), url: a.file_path.startsWith('http') ? a.file_path : `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, sentenceId: a.sentence_id || null, duration: a.duration || 0 }));
            para.images = assets
                .filter(a => a.type === 'image' && (a.paragraph_id || a.sentence_id))
                .map(a => ({ id: a.id, type: 'image', name: path.basename(a.file_path), url: a.file_path.startsWith('http') ? a.file_path : `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, sentenceId: a.sentence_id || null, duration: a.duration || 0 }));

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
        res.json({ ...post, projectId, paragraphs, sections });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Thêm keyword
app.post('/api/add-keyword', async (req, res) => {
    const { paragraphId, postId, section, content, type } = req.body;
    try {
        const db = await getDb();
        let r;
        if (postId && section) {
            r = await db.run('INSERT INTO Keyword (post_id, section, content, type) VALUES (?, ?, ?, ?)', [postId, section, content, type || null]);
        } else {
            r = await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, content, type || null]);
        }
        await db.close();
        res.json({ id: r.lastID });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Di chuyển asset sang section/paragraph khác
app.post('/api/move-asset', async (req, res) => {
    const { assetId, targetParagraphId, targetPostId, targetSection, targetDetailId, detailType } = req.body;
    try {
        const db = await getDb();
        const asset = await db.get('SELECT * FROM Asset WHERE id = ?', [assetId]);
        if (!asset) { await db.close(); return res.status(404).json({ error: 'Asset not found' }); }

        const isFromSection = !!(asset.post_id && asset.section &&
            !asset.hook_detail_id && !asset.summary_detail_id && !asset.conclusion_detail_id &&
            !asset.paragraph_detail_id && !asset.sentence_detail_id);
        const isFromDetail = !!(asset.hook_detail_id || asset.summary_detail_id || asset.conclusion_detail_id ||
            asset.paragraph_detail_id || asset.sentence_detail_id);

        const detailCols = {
            hook_detail: 'hook_detail_id', summary_detail: 'summary_detail_id',
            conclusion_detail: 'conclusion_detail_id', paragraph_detail: 'paragraph_detail_id',
            sentence_detail: 'sentence_detail_id'
        };

        if (detailType && targetDetailId) {
            const col = detailCols[detailType];
            if (isFromSection) {
                // Copy file
                const srcPath = path.join(MEDIA_DIR, asset.file_path);
                const ext = path.extname(asset.file_path);
                const newFileName = path.basename(asset.file_path, ext) + `_copy_${Date.now()}` + ext;
                const newFilePath = path.join(path.dirname(srcPath), newFileName);
                if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, newFilePath);
                const newRel = path.relative(MEDIA_DIR, newFilePath);
                // Insert asset mới gán vào detail
                await db.run(`INSERT INTO Asset (${col}, type, file_path, duration) VALUES (?, ?, ?, ?)`,
                    [targetDetailId, asset.type, newRel, asset.duration]);
            } else {
                // Từ paragraph/sentence -> detail: update và xóa sạch các foreign key cũ
                await db.run(`UPDATE Asset SET
                    hook_detail_id = NULL, summary_detail_id = NULL, conclusion_detail_id = NULL,
                    paragraph_detail_id = NULL, sentence_detail_id = NULL,
                    post_id = NULL, section = NULL, paragraph_id = NULL, sentence_id = NULL
                    WHERE id = ?`, [assetId]);
                await db.run(`UPDATE Asset SET ${col} = ? WHERE id = ?`, [targetDetailId, assetId]);
            }
        } else if (targetPostId && targetSection) {
            await db.run('UPDATE Asset SET paragraph_id = NULL, sentence_id = NULL, post_id = ?, section = ?, hook_detail_id = NULL, summary_detail_id = NULL, conclusion_detail_id = NULL, paragraph_detail_id = NULL, sentence_detail_id = NULL WHERE id = ?',
                [targetPostId, targetSection, assetId]);
        } else if (targetParagraphId) {
            await db.run('UPDATE Asset SET paragraph_id = ?, sentence_id = NULL, post_id = NULL, section = NULL, hook_detail_id = NULL, summary_detail_id = NULL, conclusion_detail_id = NULL, paragraph_detail_id = NULL, sentence_detail_id = NULL WHERE id = ?',
                [targetParagraphId, assetId]);
        }

        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Xóa keyword
app.post('/api/delete-keyword', async (req, res) => {
    const { keywordId } = req.body;
    try {
        const db = await getDb();
        await db.run('DELETE FROM Keyword WHERE id = ?', [keywordId]);
        await db.close();
        res.json({ ok: true });
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
    const { videoId, groupId, postId, section, keywords } = req.body;
    
    if (!keywords || keywords.length === 0) {
        return res.status(400).json({ error: "Không có từ khóa để tìm kiếm" });
    }

    // Nếu là section của post (hook/summary/conclusion), crawl trực tiếp
    if (postId && section) {
        console.log(`[HỆ THỐNG] Crawl media cho section ${section} của post ${postId}`);
        (async () => {
            const db = await getDb();
            const post = await db.get('SELECT project_id FROM Post WHERE id = ?', [postId]);
            const projectId = post?.project_id;
            // Lưu keywords vào DB
            for (const kw of (Array.isArray(keywords) ? keywords : [keywords])) {
                const content = typeof kw === 'object' ? kw.content : kw;
                const type = typeof kw === 'object' ? kw.type : null;
                const ex = await db.get('SELECT id FROM Keyword WHERE post_id = ? AND section = ? AND content = ?', [postId, section, content]);
                if (!ex) await db.run('INSERT INTO Keyword (post_id, section, content, type) VALUES (?, ?, ?, ?)', [postId, section, content, type]);
            }
            await db.close();
            // Import và crawl trực tiếp
            const { fetchAndDownloadStock } = await import('./sync_assets_db.js').catch(() => ({}));
            if (!fetchAndDownloadStock) {
                console.error('[generate-media section] Không import được fetchAndDownloadStock');
                return;
            }
            const vFolder = path.join(MEDIA_DIR, projectId, 'assets', '_raw_videos', section);
            const iFolder = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', section);
            [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            const kwTexts = (Array.isArray(keywords) ? keywords : [keywords]).map(k => typeof k === 'object' ? k.content : k);
            for (const kw of kwTexts) {
                await fetchAndDownloadStock(kw, 'video', vFolder, 4).catch(() => {});
                await fetchAndDownloadStock(kw, 'image', iFolder, 8).catch(() => {});
            }
            // Sync vào DB
            const db2 = await getDb();
            const syncDir = async (folderPath, type) => {
                const exts = type === 'video' ? ['.mp4','.mov'] : ['.jpg','.jpeg','.png','.webp'];
                if (!fs.existsSync(folderPath)) return;
                for (const file of fs.readdirSync(folderPath)) {
                    if (!exts.includes(path.extname(file).toLowerCase())) continue;
                    const rel = path.relative(MEDIA_DIR, path.join(folderPath, file));
                    const ex = await db2.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                    if (!ex) await db2.run('INSERT INTO Asset (post_id, section, paragraph_id, sentence_id, type, file_path) VALUES (?, ?, NULL, NULL, ?, ?)', [postId, section, type, rel]);
                }
            };
            await syncDir(vFolder, 'video');
            await syncDir(iFolder, 'image');
            await db2.close();
            console.log(`[generate-media section] ✅ Xong ${section}`);
        })().catch(e => console.error('[generate-media section]', e.message));
        return res.json({ success: true, message: 'Crawl section media...' });
    }

    const kwTexts = (Array.isArray(keywords) ? keywords : [keywords]).map(k => typeof k === 'object' ? k.content : k).filter(Boolean);
    console.log(`\n[HỆ THỐNG] Bắt đầu lấy Media cho: Dự án ${videoId} | Nhóm ${groupId}`);
    console.log(`[HỆ THỐNG] Từ khóa: ${kwTexts.join(', ')}`);

    const pythonProcess = spawn('node', [
        'craw_sub.js',
        '--mode', 'single',
        '--videoId', videoId,
        '--paragraphId', String(groupId),
        '--keywords', kwTexts.join(',')
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
        const { videoId, postId, contentType: reqContentType } = req.body;
        const db = await getDb();
        const post = await db.get('SELECT project_id, voice_content_type FROM Post WHERE id = ?', [postId]);
        const lang = post.project_id.match(/_([a-z]{2})$/)?.[1] || (reqContentType === 'content_vi' ? 'vi' : 'en');
        const contentType = reqContentType || post.voice_content_type || 'content';

        const zipName = `${videoId}_${lang}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', e => { throw e; });
        archive.pipe(res);

        // Lấy tất cả audio URLs theo thứ tự (giống download audio đơn lẻ)
        const audioList = await getAllAudioUrls(postId, contentType);

        // Đặt tên 1.mp3, 2.mp3...
        for (let i = 0; i < audioList.length; i++) {
            const audioUrl = audioList[i].audio;
            if (!audioUrl) continue;
            try {
                const buf = await fetchBunnyAudio(audioUrl);
                archive.append(buf, { name: `audio/${i + 1}.mp3` });
            } catch(e) { console.error(`[download-voice] skip audio ${i+1}:`, e.message); }
        }

        // Assets selected theo section (hook, summary, conclusion)
        const sectionAssets = await db.all(
            'SELECT file_path, "order", duration, section FROM Asset WHERE selected = 1 AND post_id = ? AND section IS NOT NULL ORDER BY section, "order"',
            [postId]
        );
        for (const asset of sectionAssets) {
            const srcPath = path.join(MEDIA_DIR, asset.file_path);
            if (fs.existsSync(srcPath)) {
                const ext = path.extname(asset.file_path);
                const durSuffix = asset.duration ? `_${Math.round(asset.duration)}s` : '';
                archive.file(srcPath, { name: `media/${asset.section}/${asset.order}${durSuffix}${ext}` });
            }
        }

        // Assets selected theo sentence (paragraphs)
        const paragraphs = await db.all('SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY id', [postId]);
        for (const para of paragraphs) {
            // Assets cho luận điểm (sentence_id IS NULL)
            const paraAssets = await db.all(
                'SELECT file_path, "order", duration FROM Asset WHERE selected = 1 AND paragraph_id = ? AND sentence_id IS NULL ORDER BY "order"',
                [para.id]
            );
            for (const asset of paraAssets) {
                const srcPath = path.join(MEDIA_DIR, asset.file_path);
                if (fs.existsSync(srcPath)) {
                    const ext = path.extname(asset.file_path);
                    const durSuffix = asset.duration ? `_${Math.round(asset.duration)}s` : '';
                    archive.file(srcPath, { name: `media/${para.order}_0/${asset.order}${durSuffix}${ext}` });
                }
            }
            // Assets cho luận cứ (sentence)
            const sentences = await db.all('SELECT id, "order" FROM Sentence WHERE paragraph_id = ? ORDER BY "order"', [para.id]);
            for (const s of sentences) {
                const assets = await db.all(
                    'SELECT file_path, "order", duration FROM Asset WHERE selected = 1 AND sentence_id = ? ORDER BY "order"',
                    [s.id]
                );
                for (const asset of assets) {
                    const srcPath = path.join(MEDIA_DIR, asset.file_path);
                    if (fs.existsSync(srcPath)) {
                        const ext = path.extname(asset.file_path);
                        const durSuffix = asset.duration ? `_${Math.round(asset.duration)}s` : '';
                        archive.file(srcPath, { name: `media/${para.order}_${s.order}/${asset.order}${durSuffix}${ext}` });
                    }
                }
            }
        }

        // Lips sync outputs (nếu đã chạy) -> thư mục lips_sync/ trong zip
        const lipsProjectId = post.project_id.replace(/_[a-z]{2}$/, '');
        const lipsDir = path.join(MEDIA_DIR, lipsProjectId, 'lips_sync');
        if (fs.existsSync(lipsDir)) {
            for (const f of fs.readdirSync(lipsDir)) {
                if (/^\d+\.mp4$/i.test(f)) archive.file(path.join(lipsDir, f), { name: `lips_sync/${f}` });
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
        const { postId, contentType } = req.body;
        const { buf, filename } = await getIndividualAudio(postId, contentType);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/download-audio/merged', async (req, res) => {
    try {
        const { postId, silenceDuration = 0.5, contentType } = req.body;
        const tmpDir = path.join(MEDIA_DIR, '_tmp_uploads', `merge_${Date.now()}`);
        const { outputFile, filename } = await getMergedAudio(postId, silenceDuration, tmpDir, contentType);
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
        const { batchUuid, postId, contentType } = req.body;
        const result = await checkAndSaveVoice(batchUuid, postId, contentType || 'content');
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

// Karaoke: forced-align (WhisperX) mốc từng từ cho cả post, lưu vào cột *_wt.
// contentType: 'content' (target) | 'content_vi' (VN). Không truyền -> chạy cả hai.
app.post('/api/align-words', async (req, res) => {
    try {
        const { postId, contentType } = req.body;
        if (!postId) return res.status(400).json({ error: 'thiếu postId' });
        const types = contentType ? [contentType] : ['content', 'content_vi'];
        const out = [];
        for (const ct of types) out.push(await alignPost(postId, ct));
        res.json({ success: true, results: out });
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
        if (!['title', 'hook', 'hook_vi', 'summary', 'summary_vi', 'summary_target', 'conclusion_vi', 'conclusion_target'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE Post SET ${field} = ? WHERE id = ?`, [value, postId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-para-field', async (req, res) => {
    try {
        const { paragraphId, field, value } = req.body;
        if (!['content', 'content_vi', 'title', 'title_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE Paragraph SET ${field} = ? WHERE id = ?`, [value, paragraphId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-sentence-field', async (req, res) => {
    try {
        const { sentenceId, field, value } = req.body;
        if (!['content', 'content_vi', 'title', 'title_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE Sentence SET ${field} = ? WHERE id = ?`, [value, sentenceId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-detail-field', async (req, res) => {
    try {
        const { detailId, field, value } = req.body;
        if (!['content', 'content_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE SentenceDetail SET ${field} = ? WHERE id = ?`, [value, detailId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-hook-detail-field', async (req, res) => {
    try {
        const { detailId, field, value } = req.body;
        if (!['content', 'content_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE HookDetail SET ${field} = ? WHERE id = ?`, [value, detailId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-conclusion-detail-field', async (req, res) => {
    try {
        const { detailId, field, value } = req.body;
        if (!['content', 'content_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE ConclusionDetail SET ${field} = ? WHERE id = ?`, [value, detailId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-summary-detail-field', async (req, res) => {
    try {
        const { detailId, field, value } = req.body;
        if (!['content', 'content_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE SummaryDetail SET ${field} = ? WHERE id = ?`, [value, detailId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/save-para-detail-field', async (req, res) => {
    try {
        const { detailId, field, value } = req.body;
        if (!['content', 'content_vi'].includes(field)) return res.status(400).json({ error: 'Invalid field' });
        const db = await getDb();
        await db.run(`UPDATE ParagraphDetail SET ${field} = ? WHERE id = ?`, [value, detailId]);
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/split-sentence', async (req, res) => {
    try {
        const { sentenceId } = req.body;
        const db = await getDb();
        const s = await db.get('SELECT content, content_vi FROM Sentence WHERE id = ?', [sentenceId]);
        if (!s) return res.status(404).json({ error: 'Not found' });
        const split = (text) => text ? text.split(/(?<=[.!?])\s+/).map(t => t.trim()).filter(Boolean) : [];
        const viParts = split(s.content_vi);
        const targetParts = split(s.content);
        const maxLen = Math.max(viParts.length, targetParts.length);
        await db.run('DELETE FROM SentenceDetail WHERE sentence_id = ?', [sentenceId]);
        const details = [];
        for (let i = 0; i < maxLen; i++) {
            const r = await db.run('INSERT INTO SentenceDetail (sentence_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
                [sentenceId, targetParts[i] || null, viParts[i] || null, i + 1]);
            details.push({ id: r.lastID, content: targetParts[i]||null, content_vi: viParts[i]||null, content_audio: null, content_vi_audio: null, order: i+1 });
        }
        await db.close();
        res.json({ details });
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
        const { videoId, postId, lang, speakerUuid, contentType, dictionaryUuids, texts } = req.body;
        const projectDir = path.join(MEDIA_DIR, videoId);
        const result = await generateAudios(projectDir, postId, lang, speakerUuid, contentType, dictionaryUuids, texts || null);

        // Lưu batchUuid vào bảng Post
        const db = await getDb();
        await db.run('UPDATE Post SET audio_uuid = ?, voice_content_type = ? WHERE id = ?', [result.batch_uuid, contentType || 'content', postId]);
        await db.close();

        // Kích hoạt TTS chạy ngay
        await updateBatchStatus(result.batch_uuid);
        console.log('[create-voice] Batch activated:', result.batch_uuid);

        res.json({ batch_uuid: result.batch_uuid, folderNames: result.folderNames, paragraphIds: result.paragraphIds });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Kích hoạt crawl toàn bộ media cho 1 post
app.post('/api/crawl-all', async (req, res) => {
    const { postId } = req.body;
    res.json({ success: true, message: 'Đang crawl...' });
    (async () => {
        const { fetchAndDownloadStock } = await import('./sync_assets_db.js').catch(() => ({}));
        if (!fetchAndDownloadStock) return;
        const db = await getDb();
        const post = await db.get('SELECT id, project_id FROM Post WHERE id = ?', [postId]);
        if (!post) { await db.close(); return; }
        const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
        await db.run('UPDATE Post SET status = ? WHERE id = ?', ['crawling', postId]);

        const syncDir = async (folder, type, insertFn) => {
            const exts = type === 'video' ? ['.mp4','.mov'] : ['.jpg','.jpeg','.png','.webp'];
            if (!fs.existsSync(folder)) return;
            for (const file of fs.readdirSync(folder)) {
                if (!exts.includes(path.extname(file).toLowerCase())) continue;
                const rel = path.relative(MEDIA_DIR, path.join(folder, file));
                const ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                if (!ex) await insertFn(rel, type);
            }
        };

        // Sections
        for (const section of ['hook', 'summary', 'conclusion']) {
            const kws = await db.all('SELECT content FROM Keyword WHERE post_id = ? AND section = ?', [postId, section]);
            if (!kws.length) continue;
            const vF = path.join(MEDIA_DIR, projectId, 'assets', '_raw_videos', section);
            const iF = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', section);
            [vF, iF].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            for (const { content: kw } of kws) {
                await fetchAndDownloadStock(kw, 'video', vF, 4).catch(() => {});
                await fetchAndDownloadStock(kw, 'image', iF, 8).catch(() => {});
            }
            await syncDir(vF, 'video', (rel, t) => db.run('INSERT INTO Asset (post_id, section, type, file_path) VALUES (?, ?, ?, ?)', [postId, section, t, rel]));
            await syncDir(iF, 'image', (rel, t) => db.run('INSERT INTO Asset (post_id, section, type, file_path) VALUES (?, ?, ?, ?)', [postId, section, t, rel]));
        }

        // Paragraphs
        const paragraphs = await db.all('SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY "order"', [postId]);
        for (const para of paragraphs) {
            const gid = String(para.order);
            const kws = await db.all('SELECT content FROM Keyword WHERE paragraph_id = ?', [para.id]);
            if (!kws.length) continue;
            const vF = path.join(MEDIA_DIR, projectId, 'assets', '_raw_videos', gid);
            const iF = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', gid);
            [vF, iF].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            for (const { content: kw } of kws) {
                await fetchAndDownloadStock(kw, 'video', vF, 4).catch(() => {});
                await fetchAndDownloadStock(kw, 'image', iF, 8).catch(() => {});
            }
            await syncDir(vF, 'video', (rel, t) => db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [para.id, t, rel]));
            await syncDir(iF, 'image', (rel, t) => db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [para.id, t, rel]));
        }

        await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
        await db.close();
        console.log(`[crawl-all] ✅ Xong post ${postId}`);
    })().catch(e => console.error('[crawl-all]', e.message));
});

// API: Crawl từ nguồn Việt Nam
app.post('/api/crawl-vn', async (req, res) => {
    const { paragraphId, postId, section, keyword, videoId, gid } = req.body;
    if (!keyword?.trim()) return res.status(400).json({ error: 'Thiếu keyword' });
    res.json({ success: true, message: 'Đang crawl nguồn Việt Nam...' });
    (async () => {
        const { fetchFromVnBot } = await import('./vnCrawler.js');
        const db = await getDb();
        const subDir = section || gid;
        const vFolder = path.join(MEDIA_DIR, videoId, 'assets', '_raw_videos', subDir);
        const iFolder = path.join(MEDIA_DIR, videoId, 'assets', '_raw_images', subDir);
        [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
        await fetchFromVnBot(keyword, vFolder, iFolder, 12, 24);
        // Sync vào DB
        const syncDir = async (folderPath, type) => {
            const exts = type === 'video' ? ['.mp4','.mov'] : ['.jpg','.jpeg','.png','.webp'];
            if (!fs.existsSync(folderPath)) return;
            for (const file of fs.readdirSync(folderPath)) {
                if (!exts.includes(path.extname(file).toLowerCase())) continue;
                const rel = path.relative(MEDIA_DIR, path.join(folderPath, file));
                const ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                if (!ex) {
                    if (postId && section) {
                        await db.run('INSERT INTO Asset (post_id, section, paragraph_id, sentence_id, type, file_path) VALUES (?, ?, NULL, NULL, ?, ?)', [postId, section, type, rel]);
                    } else {
                        await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [paragraphId, type, rel]);
                    }
                }
            }
        };
        await syncDir(iFolder, 'image');
        await syncDir(vFolder, 'video');
        await db.close();
        console.log(`[crawl-vn] Xong keyword: ${keyword}`);
    })().catch(e => console.error('[crawl-vn]', e.message));
});

app.post('/api/create-project', async (req, res) => {
    const { content, keywords, sources, country, targetLang, days, lipsAuto, lipsVideo, lipsGuidance } = req.body;
    // LUỒNG ĐỊA CHÍNH TRỊ: input là mảng từ khóa + mảng domain nguồn. Vẫn nhận content (chủ đề/tiêu đề) làm tuỳ chọn.
    const kwArr = Array.isArray(keywords) ? keywords.map(s => String(s).trim()).filter(Boolean) : [];
    const srcArr = Array.isArray(sources) ? sources.map(s => String(s).trim()).filter(Boolean) : [];
    const daysNum = parseInt(days, 10);
    const newsDays = Number.isFinite(daysNum) && daysNum > 0 ? daysNum : 3;   // cửa sổ tin (when:Nd)
    if (!kwArr.length && !content?.trim()) return res.status(400).json({ error: 'Thiếu từ khóa (keywords) hoặc nội dung' });
    try {
        const projectId = 'proj_' + Date.now();
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'original_content.txt'), (content?.trim()) || kwArr.join('\n'));
        // Auto lips sync: ghi config để tự chạy sau khi gen audio ngôn ngữ đích (giống luồng naze/drama)
        if (lipsAuto && lipsVideo) { writeLipsAutoConfig(projectId, { video: lipsVideo, guidanceScale: lipsGuidance }); }
        const cGl = (country && country.gl) || '';
        const cHl = (country && country.hl) || '';
        const procArgs = [
            'process_content.js',
            '--projectId', projectId,
            '--keywords', JSON.stringify(kwArr),
            '--sources', JSON.stringify(srcArr),
            '--country', cGl,
            '--clang', cHl,
            '--targetLang', targetLang || 'en',
            '--days', String(newsDays)
        ];
        if (content?.trim()) { procArgs.push('--content', content.trim()); }
        const crawlProcess = spawn('node', procArgs, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
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
        const posts = await db.all('SELECT id FROM Post WHERE project_id = ? OR project_id LIKE ?', [videoId, `${videoId}\_%`]);
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
app.post('/api/delete-asset', async (req, res) => {
    const { assetId } = req.body;
    try {
        const db = await getDb();
        const asset = await db.get('SELECT file_path FROM Asset WHERE id = ?', [assetId]);
        if (asset) {
            await db.run('DELETE FROM Asset WHERE id = ?', [assetId]);
            // Optionally delete file
            const fullPath = path.join(MEDIA_DIR, asset.file_path);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
        await db.close();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Xóa nội dung (luận điểm / câu / dòng detail / cả khối section) + cascade con + media file
app.post('/api/delete-content', async (req, res) => {
    const { type, id } = req.body;
    const allowed = ['paragraph', 'paragraph_detail', 'sentence', 'sentence_detail',
        'hook_detail', 'summary_detail', 'conclusion_detail', 'hook', 'summary', 'conclusion'];
    if (!allowed.includes(type) || !id)
        return res.status(400).json({ error: 'type/id không hợp lệ' });
    let db;
    try {
        db = await getDb();
        const inClause = (arr) => `(${arr.map(() => '?').join(',')})`;
        const filePaths = [];
        const collect = async (sql, params) => {
            const rows = await db.all(sql, params);
            for (const r of rows) if (r.file_path) filePaths.push(r.file_path);
        };

        if (type === 'paragraph') {
            const sentIds = (await db.all('SELECT id FROM Sentence WHERE paragraph_id = ?', [id])).map(s => s.id);
            const sdIds = sentIds.length
                ? (await db.all(`SELECT id FROM SentenceDetail WHERE sentence_id IN ${inClause(sentIds)}`, sentIds)).map(d => d.id)
                : [];
            const pdIds = (await db.all('SELECT id FROM ParagraphDetail WHERE paragraph_id = ?', [id])).map(d => d.id);

            await collect('SELECT file_path FROM Asset WHERE paragraph_id = ?', [id]);
            if (sentIds.length) await collect(`SELECT file_path FROM Asset WHERE sentence_id IN ${inClause(sentIds)}`, sentIds);
            if (pdIds.length) await collect(`SELECT file_path FROM Asset WHERE paragraph_detail_id IN ${inClause(pdIds)}`, pdIds);
            if (sdIds.length) await collect(`SELECT file_path FROM Asset WHERE sentence_detail_id IN ${inClause(sdIds)}`, sdIds);

            await db.run('DELETE FROM Asset WHERE paragraph_id = ?', [id]);
            if (sentIds.length) await db.run(`DELETE FROM Asset WHERE sentence_id IN ${inClause(sentIds)}`, sentIds);
            if (pdIds.length) await db.run(`DELETE FROM Asset WHERE paragraph_detail_id IN ${inClause(pdIds)}`, pdIds);
            if (sdIds.length) await db.run(`DELETE FROM Asset WHERE sentence_detail_id IN ${inClause(sdIds)}`, sdIds);
            if (sdIds.length) await db.run(`DELETE FROM SentenceDetail WHERE id IN ${inClause(sdIds)}`, sdIds);
            await db.run('DELETE FROM ParagraphDetail WHERE paragraph_id = ?', [id]);
            if (sentIds.length) await db.run('DELETE FROM Sentence WHERE paragraph_id = ?', [id]);
            await db.run('DELETE FROM Keyword WHERE paragraph_id = ?', [id]);
            await db.run('DELETE FROM Paragraph WHERE id = ?', [id]);
        } else if (type === 'paragraph_detail') {
            await collect('SELECT file_path FROM Asset WHERE paragraph_detail_id = ?', [id]);
            await db.run('DELETE FROM Asset WHERE paragraph_detail_id = ?', [id]);
            await db.run('DELETE FROM ParagraphDetail WHERE id = ?', [id]);
        } else if (type === 'sentence') {
            const sdIds = (await db.all('SELECT id FROM SentenceDetail WHERE sentence_id = ?', [id])).map(d => d.id);
            await collect('SELECT file_path FROM Asset WHERE sentence_id = ?', [id]);
            if (sdIds.length) await collect(`SELECT file_path FROM Asset WHERE sentence_detail_id IN ${inClause(sdIds)}`, sdIds);
            await db.run('DELETE FROM Asset WHERE sentence_id = ?', [id]);
            if (sdIds.length) await db.run(`DELETE FROM Asset WHERE sentence_detail_id IN ${inClause(sdIds)}`, sdIds);
            await db.run('DELETE FROM SentenceDetail WHERE sentence_id = ?', [id]);
            await db.run('DELETE FROM Sentence WHERE id = ?', [id]);
        } else if (type === 'sentence_detail') {
            await collect('SELECT file_path FROM Asset WHERE sentence_detail_id = ?', [id]);
            await db.run('DELETE FROM Asset WHERE sentence_detail_id = ?', [id]);
            await db.run('DELETE FROM SentenceDetail WHERE id = ?', [id]);
        } else if (type === 'hook_detail') {
            await collect('SELECT file_path FROM Asset WHERE hook_detail_id = ?', [id]);
            await db.run('DELETE FROM Asset WHERE hook_detail_id = ?', [id]);
            await db.run('DELETE FROM HookDetail WHERE id = ?', [id]);
        } else if (type === 'summary_detail') {
            await collect('SELECT file_path FROM Asset WHERE summary_detail_id = ?', [id]);
            await db.run('DELETE FROM Asset WHERE summary_detail_id = ?', [id]);
            await db.run('DELETE FROM SummaryDetail WHERE id = ?', [id]);
        } else if (type === 'conclusion_detail') {
            await collect('SELECT file_path FROM Asset WHERE conclusion_detail_id = ?', [id]);
            await db.run('DELETE FROM Asset WHERE conclusion_detail_id = ?', [id]);
            await db.run('DELETE FROM ConclusionDetail WHERE id = ?', [id]);
        } else if (type === 'hook' || type === 'summary' || type === 'conclusion') {
            // id = post_id: xóa cả khối section (mở bài / tóm tắt / kết bài)
            const detailTable = { hook: 'HookDetail', summary: 'SummaryDetail', conclusion: 'ConclusionDetail' }[type];
            const detailCol = { hook: 'hook_detail_id', summary: 'summary_detail_id', conclusion: 'conclusion_detail_id' }[type];
            const dIds = (await db.all(`SELECT id FROM ${detailTable} WHERE post_id = ?`, [id])).map(d => d.id);

            if (dIds.length) await collect(`SELECT file_path FROM Asset WHERE ${detailCol} IN ${inClause(dIds)}`, dIds);
            await collect('SELECT file_path FROM Asset WHERE post_id = ? AND section = ?', [id, type]);

            if (dIds.length) await db.run(`DELETE FROM Asset WHERE ${detailCol} IN ${inClause(dIds)}`, dIds);
            await db.run('DELETE FROM Asset WHERE post_id = ? AND section = ?', [id, type]);
            await db.run(`DELETE FROM ${detailTable} WHERE post_id = ?`, [id]);
            await db.run('DELETE FROM Keyword WHERE post_id = ? AND section = ?', [id, type]);
            if (type === 'hook')
                await db.run('UPDATE Post SET hook = NULL, hook_vi = NULL, hook_audio = NULL, hook_vi_audio = NULL WHERE id = ?', [id]);
            else if (type === 'summary')
                await db.run('UPDATE Post SET summary = NULL, summary_vi = NULL, summary_audio = NULL, summary_vi_audio = NULL, summary_target = NULL, summary_target_audio = NULL WHERE id = ?', [id]);
            else
                await db.run('UPDATE Post SET conclusion_vi = NULL, conclusion_vi_audio = NULL, conclusion_target = NULL, conclusion_target_audio = NULL WHERE id = ?', [id]);
        }

        await db.close();
        for (const fp of filePaths) {
            try {
                const full = path.join(MEDIA_DIR, fp);
                if (fs.existsSync(full)) fs.unlinkSync(full);
            } catch (_) { /* bỏ qua file lỗi */ }
        }
        res.json({ ok: true });
    } catch (e) {
        try { if (db) await db.close(); } catch (_) {}
        res.status(500).json({ error: e.message });
    }
});

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
        const post = await (await getDb()).get('SELECT project_id FROM Post WHERE id = (SELECT post_id FROM Paragraph WHERE id = ?)', [asset?.paragraph_id]);
        if (post) {
            const lang = post.project_id.match(/_([a-z]{2})$/)?.[1] || 'unknown';
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
            const asset = await db.get('SELECT paragraph_id, sentence_id, post_id, section, "order" FROM Asset WHERE file_path = ?', [relativePath]);
            if (asset) {
                if (asset.post_id && asset.section) {
                    // Section asset: giảm order các asset cùng section
                    await db.run('UPDATE Asset SET "order" = "order" - 1 WHERE post_id = ? AND section = ? AND selected = 1 AND "order" > ?', [asset.post_id, asset.section, asset.order]);
                    await db.run('UPDATE Asset SET selected = 0, "order" = 0 WHERE file_path = ?', [relativePath]);
                } else {
                    const pid = asset.paragraph_id || await db.get('SELECT paragraph_id FROM Sentence WHERE id = ?', [asset.sentence_id]).then(r => r?.paragraph_id);
                    await db.run('UPDATE Asset SET "order" = "order" - 1 WHERE paragraph_id = ? AND selected = 1 AND "order" > ?', [pid, asset.order]);
                    await db.run('UPDATE Asset SET selected = 0, "order" = 0, sentence_id = NULL, paragraph_id = ? WHERE file_path = ?', [pid, relativePath]);
                }
            }
        } else {
            // Tính duration cho video nếu chưa có
            const existing = await db.get('SELECT duration, type, post_id, section FROM Asset WHERE file_path = ?', [relativePath]);
            let duration = existing?.duration || null;
            if (!duration && existing?.type === 'video') {
                try {
                    const { execSync } = await import('child_process');
                    const fullPath = path.join(MEDIA_DIR, relativePath);
                    const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fullPath}"`);
                    duration = parseFloat(out.toString().trim());
                } catch (e) {}
            }
            if (existing?.post_id && existing?.section) {
                // Section asset: chỉ update selected/order, giữ post_id/section
                await db.run('UPDATE Asset SET selected = 1, "order" = ?, duration = COALESCE(?, duration) WHERE file_path = ?', [order || 0, duration, relativePath]);
            } else {
                await db.run(
                    'UPDATE Asset SET selected = 1, "order" = ?, sentence_id = ?, duration = COALESCE(?, duration), paragraph_id = CASE WHEN ? IS NOT NULL THEN NULL ELSE paragraph_id END WHERE file_path = ?',
                    [order || 0, sentenceId || null, duration, sentenceId || null, relativePath]
                );
            }
        }

        await db.close();
        res.json({ success: true, selected });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sắp xếp lại thứ tự asset đã chọn (video + ảnh chung 1 dãy order) trong 1 luận điểm
app.post('/api/reorder-assets', async (req, res) => {
    const { items } = req.body; // [{ relativePath, order }]
    try {
        const db = await getDb();
        for (const it of (items || [])) {
            await db.run('UPDATE Asset SET "order" = ? WHERE file_path = ?', [it.order, it.relativePath]);
        }
        await db.close();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const upload = multer({ dest: path.join(MEDIA_DIR, '_tmp_uploads') });
// API: Tạo mới dự án từ nội dung
app.post('/api/create-naze-srt', upload.fields([{ name: 'srt', maxCount: 1 }, { name: 'srtTarget', maxCount: 1 }]), async (req, res) => {
    const { projectId, targetLang } = req.body;
    const srtFile = req.files?.srt?.[0];
    if (!srtFile || !projectId?.trim()) return res.status(400).json({ error: 'Thiếu file SRT hoặc projectId' });
    try {
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const srtPath = path.join(targetDir, 'input.srt');
        fs.renameSync(srtFile.path, srtPath);
        let srtTargetPath = '';
        if (req.files?.srtTarget?.[0]) {
            srtTargetPath = path.join(targetDir, 'input_target.srt');
            fs.renameSync(req.files.srtTarget[0].path, srtTargetPath);
        }
        const args = ['naze_content.js', '--srt', srtPath, projectId];
        if (srtTargetPath) args.push(srtTargetPath);
        if (targetLang) args.push(targetLang);
        const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => process.stdout.write(`[naze] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[naze] ${d}`));
        child.unref();
        res.json({ success: true, projectId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== Hàng đợi tuần tự cho naze SRT batch: mỗi lúc chỉ chạy 1 project (tránh nghẽn mạng) =====
const nazeQueue = [];
let nazeQueueRunning = false;
function enqueueNazeJob(job) {
    nazeQueue.push(job);
    runNazeQueue();
}
async function runNazeQueue() {
    if (nazeQueueRunning) return;
    nazeQueueRunning = true;
    while (nazeQueue.length) {
        const job = nazeQueue.shift();
        console.log(`[naze-queue] ▶ Bắt đầu ${job.projectId} (còn ${nazeQueue.length} trong hàng đợi)`);
        await new Promise((resolve) => {
            const child = spawn('node', job.args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', d => process.stdout.write(`[naze:${job.projectId}] ${d}`));
            child.stderr.on('data', d => process.stderr.write(`[naze:${job.projectId}] ${d}`));
            child.on('exit', (code) => { console.log(`[naze-queue] ✔ Xong ${job.projectId} (code ${code})`); resolve(); });
            child.on('error', (e) => { console.error(`[naze-queue] ✖ Lỗi spawn ${job.projectId}: ${e.message}`); resolve(); });
        });
    }
    nazeQueueRunning = false;
    console.log('[naze-queue] Hàng đợi trống, đã xử lý hết.');
}

// API: Tạo nhiều project naze từ nhiều cặp file SRT (nguồn + đích), xử lý tuần tự
app.post('/api/create-naze-srt-batch', upload.array('srts', 500), async (req, res) => {
    const files = req.files || [];
    const targetLang = (req.body.targetLang || '').trim().toLowerCase();
    if (!files.length) return res.status(400).json({ error: 'Không có file SRT nào' });
    if (!targetLang) return res.status(400).json({ error: 'Thiếu ngôn ngữ đích' });

    // Dọn file tạm nếu validate fail
    const cleanup = () => { for (const f of files) { try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) {} } };
    try {
        // Parse tên file: <lang>.<base>.srt
        const parsed = [];
        for (const f of files) {
            const m = f.originalname.match(/^([a-z]{2})\.(.+)\.srt$/i);
            if (!m) { cleanup(); return res.status(400).json({ error: `Sai định dạng tên (cần <lang>.<tên>.srt): ${f.originalname}` }); }
            parsed.push({ lang: m[1].toLowerCase(), base: m[2], file: f });
        }
        const langs = [...new Set(parsed.map(p => p.lang))];
        if (langs.length !== 2) { cleanup(); return res.status(400).json({ error: `Cần đúng 2 ngôn ngữ (nguồn + đích), đang có: ${langs.join(', ') || 'không có'}` }); }
        if (!langs.includes(targetLang)) { cleanup(); return res.status(400).json({ error: `Ngôn ngữ đích "${targetLang}" không có trong file (có: ${langs.join(', ')})` }); }
        const srcLang = langs.find(l => l !== targetLang);

        // Nhóm theo base + validate đủ cặp
        const groups = {};
        for (const p of parsed) { (groups[p.base] ||= {})[p.lang] = p.file; }
        const missing = [];
        for (const [base, g] of Object.entries(groups)) {
            if (!g[srcLang]) missing.push(`${targetLang}.${base}.srt thiếu cặp ${srcLang}.${base}.srt`);
            if (!g[targetLang]) missing.push(`${srcLang}.${base}.srt thiếu cặp ${targetLang}.${base}.srt`);
        }
        if (missing.length) { cleanup(); return res.status(400).json({ error: 'Thiếu file cặp:\n- ' + missing.join('\n- ') }); }

        // Tạo project + xếp hàng
        const projects = [];
        for (const [base, g] of Object.entries(groups)) {
            const projectId = base;
            const targetDir = path.join(MEDIA_DIR, projectId);
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const srcPath = path.join(targetDir, 'input.srt');
            const tgtPath = path.join(targetDir, 'input_target.srt');
            fs.renameSync(g[srcLang].path, srcPath);
            fs.renameSync(g[targetLang].path, tgtPath);
            enqueueNazeJob({ projectId, args: ['naze_content.js', '--srt', srcPath, projectId, tgtPath, targetLang] });
            projects.push(projectId);
        }
        res.json({ success: true, count: projects.length, projects });
    } catch (e) { cleanup(); res.status(500).json({ error: e.message }); }
});

app.post('/api/create-naze-youtube', express.json(), async (req, res) => {
    const { url, projectId, targetLang, lipsAuto, lipsVideo, lipsGuidance } = req.body;
    if (!url?.trim() || !projectId?.trim()) return res.status(400).json({ error: 'Thiếu URL hoặc projectId' });
    try {
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        if (lipsAuto && lipsVideo) writeLipsAutoConfig(projectId, { video: lipsVideo, guidanceScale: lipsGuidance });
        const args = ['naze_content.js', '--youtube', url.trim(), projectId];
        if (targetLang) args.push(targetLang);
        const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => process.stdout.write(`[naze] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[naze] ${d}`));
        child.unref();
        res.json({ success: true, projectId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/create-naze', express.json(), async (req, res) => {
    const { topic, projectId, targetLang, genre, tweetUrls, lipsAuto, lipsVideo, lipsGuidance } = req.body;
    if (!topic?.trim() || !projectId?.trim()) return res.status(400).json({ error: 'Thiếu topic hoặc projectId' });
    try {
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        if (lipsAuto && lipsVideo) writeLipsAutoConfig(projectId, { video: lipsVideo, guidanceScale: lipsGuidance });
        const args = ['naze_content.js', topic.trim(), projectId, targetLang || 'vi', genre === 'drama' ? 'drama' : 'naze'];
        const env = { ...process.env };
        // Chỉ drama mới cào X; truyền link tweet dán tay (nếu có) qua env
        if (genre === 'drama' && tweetUrls && tweetUrls.trim()) env.NAZE_TWEET_URLS = tweetUrls.trim();
        const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'], env });
        child.stdout.on('data', d => process.stdout.write(`[naze] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[naze] ${d}`));
        child.unref();
        res.json({ success: true, projectId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Cào thêm X theo keyword nhập tay -> thêm vào block section='x' của post
app.post('/api/x-crawl', express.json(), async (req, res) => {
    const { postId, keyword } = req.body;
    if (!postId || !keyword?.trim()) return res.status(400).json({ error: 'Thiếu postId hoặc keyword' });
    const kw = keyword.trim();
    let db;
    try {
        db = await getDb();
        const post = await db.get('SELECT id, project_id FROM Post WHERE id = ?', [postId]);
        if (!post) { await db.close(); return res.status(404).json({ error: 'Post not found' }); }
        const projectId = post.project_id;
        const existsKw = await db.get("SELECT id FROM Keyword WHERE post_id = ? AND section = 'x' AND content = ?", [postId, kw]);
        if (!existsKw) await db.run("INSERT INTO Keyword (post_id, section, content, type) VALUES (?, 'x', ?, 'x_ja')", [postId, kw]);
        await db.close(); db = null;

        const outDir = path.join(MEDIA_DIR, projectId, 'assets', 'x');
        const profileName = process.env.X_PROFILE || 'chrome-profile-4';
        const { manifest } = await crawlX({
            profileName, outDir, keywords: kw, urls: '',
            limit: 12, max: 8, captureMax: parseInt(process.env.X_CAPTURE_BUDGET_MANUAL || '3'),
        });

        const db2 = await getDb();
        let added = 0;
        const insertAsset = async (absPath, type, srcUrl) => {
            const rel = path.relative(MEDIA_DIR, absPath);
            const ex = await db2.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
            if (!ex) { await db2.run("INSERT INTO Asset (post_id, section, type, file_path, source_url) VALUES (?, 'x', ?, ?, ?)", [postId, type, rel, srcUrl || null]); added++; }
        };
        for (const t of manifest) {
            for (const img of t.images) await insertAsset(img, 'image', t.url);
            for (const vid of t.videos) await insertAsset(vid, 'video', t.url);
            if (t.screenshot) await insertAsset(t.screenshot, 'image', t.url);
            if (t.recording) await insertAsset(t.recording, 'video', t.url);
        }
        await db2.close();
        res.json({ success: true, added, tweets: manifest.length });
    } catch (e) { try { if (db) await db.close(); } catch (_) {} res.status(500).json({ error: e.message }); }
});

function detectLang(text) {
    const t = text || '';
    if (/[぀-ヿ]/.test(t)) return 'ja';   // kana -> Nhật
    if (/[가-힯]/.test(t)) return 'ko';   // hangul -> Hàn
    if (/[฀-๿]/.test(t)) return 'th';   // Thái
    if (/[Ѐ-ӿ]/.test(t)) return 'ru';   // Cyrillic -> Nga
    if (/[؀-ۿ]/.test(t)) return 'ar';   // Ả Rập
    if (/[一-鿿]/.test(t)) return 'zh';   // CJK (không kana) -> Trung
    return null;
}

// API: Sinh Title SEO (VI + ngôn ngữ đích) từ nội dung dự án
app.post('/api/generate-title', async (req, res) => {
    const { postId } = req.body;
    let { lang } = req.body;
    if (!postId) return res.status(400).json({ error: 'Thiếu postId' });
    try {
        const db = await getDb();
        const post0 = await db.get('SELECT project_id, target_lang FROM Post WHERE id = ?', [postId]);
        const pick = (r) => (r.content || r.content_vi || '').trim();
        const parts = [];
        for (const tbl of ['HookDetail', 'SummaryDetail']) {
            const rows = await db.all(`SELECT content, content_vi FROM ${tbl} WHERE post_id = ? ORDER BY "order"`, [postId]).catch(() => []);
            rows.forEach(r => { const s = pick(r); if (s) parts.push(s); });
        }
        const paras = await db.all('SELECT id FROM Paragraph WHERE post_id = ? ORDER BY "order"', [postId]);
        for (const p of paras) {
            const ds = await db.all('SELECT content, content_vi FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"', [p.id]);
            ds.forEach(r => { const s = pick(r); if (s) parts.push(s); });
        }
        const concl = await db.all(`SELECT content, content_vi FROM ConclusionDetail WHERE post_id = ? ORDER BY "order"`, [postId]).catch(() => []);
        concl.forEach(r => { const s = pick(r); if (s) parts.push(s); });
        await db.close();

        const script = parts.join('\n');
        if (!script.trim()) return res.status(400).json({ error: 'Dự án chưa có nội dung để sinh title' });

        lang = post0?.target_lang || detectLang(script) || lang || (post0?.project_id || '').match(/_([a-z]{2})$/)?.[1] || 'en';
        console.log(`[Title SEO] postId=${postId} lang=${lang} (target_lang=${post0?.target_lang || '-'})`);

        const result = await generateSeoTitle(script, lang); // { target, vi }
        const db2 = await getDb();
        await db2.run('UPDATE Post SET seo_title = ? WHERE id = ?', [JSON.stringify(result), postId]);
        await db2.close();
        res.json({ success: true, result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Lưu/sửa nội dung Title SEO thủ công
app.post('/api/save-seo-title', async (req, res) => {
    const { postId, value } = req.body;
    if (!postId) return res.status(400).json({ error: 'Thiếu postId' });
    try {
        const db = await getDb();
        await db.run('UPDATE Post SET seo_title = ? WHERE id = ?', [value ?? null, postId]);
        await db.close();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});



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
        const { videoId, groupId, paragraphId, section, type } = req.body;
        const targetDir = path.join(MEDIA_DIR, videoId, 'assets', type === 'video' ? '_raw_videos' : '_raw_images', groupId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const db = await getDb();
        for (const file of req.files) {
            const ext = path.extname(file.originalname);
            const fileName = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
            const destPath = path.join(targetDir, fileName);
            fs.renameSync(file.path, destPath);

            const relativePath = path.relative(MEDIA_DIR, destPath);
            if (section) {
                // Upload cho section (hook/summary/conclusion)
                const post = await db.get('SELECT id FROM Post WHERE project_id LIKE ?', [`%${videoId}%`]);
                if (post) {
                    await db.run(
                        'INSERT INTO Asset (post_id, section, type, file_path) VALUES (?, ?, ?, ?)',
                        [post.id, section, type, relativePath]
                    );
                }
            } else {
                // Upload cho paragraph
                await db.run(
                    'INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)',
                    [paragraphId, type, relativePath]
                );
            }
        }
        await db.close();
        res.json({ success: true, count: req.files.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload intro/outro video — chèn vào đầu/cuối khi export CapCut, KHÔNG ảnh hưởng các đoạn
app.post('/api/upload-intro-outro', upload.single('file'), async (req, res) => {
    try {
        const { postId, kind } = req.body; // kind: 'intro' | 'outro'
        if (!req.file) return res.status(400).json({ error: 'No file' });
        if (!['intro', 'outro'].includes(kind)) return res.status(400).json({ error: 'kind phải là intro hoặc outro' });
        const db = await getDb();
        const post = await db.get('SELECT id, project_id, intro_path, outro_path FROM Post WHERE id = ?', [postId]);
        if (!post) { await db.close(); try { fs.unlinkSync(req.file.path); } catch(_) {} return res.status(404).json({ error: 'Post not found' }); }
        const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
        const dir = path.join(MEDIA_DIR, projectId, 'intro_outro');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const ext = (path.extname(req.file.originalname) || '.mp4').toLowerCase();
        const destPath = path.join(dir, `${kind}${ext}`);
        // Xoá file cũ (kể cả khác đuôi) trước khi ghi mới
        const oldRel = kind === 'intro' ? post.intro_path : post.outro_path;
        if (oldRel) { try { fs.unlinkSync(path.join(MEDIA_DIR, oldRel)); } catch(_) {} }
        fs.renameSync(req.file.path, destPath);
        const relPath = path.relative(MEDIA_DIR, destPath);
        const col = kind === 'intro' ? 'intro_path' : 'outro_path';
        await db.run(`UPDATE Post SET ${col} = ? WHERE id = ?`, [relPath, postId]);
        await db.close();
        res.json({ success: true, kind, path: relPath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Xoá intro/outro
app.post('/api/remove-intro-outro', async (req, res) => {
    try {
        const { postId, kind } = req.body;
        if (!['intro', 'outro'].includes(kind)) return res.status(400).json({ error: 'kind không hợp lệ' });
        const db = await getDb();
        const post = await db.get('SELECT intro_path, outro_path FROM Post WHERE id = ?', [postId]);
        if (post) {
            const rel = kind === 'intro' ? post.intro_path : post.outro_path;
            if (rel) { try { fs.unlinkSync(path.join(MEDIA_DIR, rel)); } catch(_) {} }
            const col = kind === 'intro' ? 'intro_path' : 'outro_path';
            await db.run(`UPDATE Post SET ${col} = NULL WHERE id = ?`, [postId]);
        }
        await db.close();
        res.json({ success: true });
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
        // Lấy totalDur TRƯỚC khi xóa file gốc
        const totalDur = (() => {
            try {
                const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${fullPath}"`);
                return parseFloat(out.toString().trim());
            } catch(e) { return 0; }
        })();
        const dur = end - start;
        // Dùng -ss trước -i (nhanh, keyframe snap) và re-encode nếu cần
        execSync(`ffmpeg -ss ${start} -t ${dur} -i "${fullPath}" -c copy -avoid_negative_ts make_zero -y "${trimmedPath}"`);

        const db = await getDb();
        const orig = await db.get('SELECT id, paragraph_id, sentence_id, post_id, section, type, selected, "order" FROM Asset WHERE file_path = ?', [relativePath]);
        if (orig) {
            const isSection = !!(orig.post_id && orig.section);
            // Xóa file gốc khỏi DB
            await db.run('DELETE FROM Asset WHERE id = ?', [orig.id]);
            // File trim chính - kế thừa selected/order của file gốc
            if (isSection) {
                await db.run(
                    'INSERT INTO Asset (post_id, section, type, selected, "order", duration, source_id, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [orig.post_id, orig.section, orig.type, orig.selected, orig.order, duration || null, orig.id, trimmedRelative]
                );
            } else {
                await db.run(
                    'INSERT INTO Asset (paragraph_id, sentence_id, type, selected, "order", duration, source_id, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [orig.paragraph_id, orig.sentence_id, orig.type, orig.selected, orig.order, duration || null, orig.id, trimmedRelative]
                );
            }
            // Phần trước [0, start]
            if (start > 0.5) {
                const beforePath = `${base}_trim_before_${ts}${ext}`;
                const beforeRelative = path.relative(MEDIA_DIR, beforePath);
                try {
                    execSync(`ffmpeg -ss 0 -t ${start} -i "${fullPath}" -c copy -y "${beforePath}"`);
                    if (isSection) {
                        await db.run(
                            'INSERT INTO Asset (post_id, section, type, selected, "order", duration, source_id, file_path) VALUES (?, ?, ?, 0, 0, ?, ?, ?)',
                            [orig.post_id, orig.section, orig.type, Math.round(start * 10) / 10, orig.id, beforeRelative]
                        );
                    } else {
                        const paraId = orig.paragraph_id || await db.get('SELECT paragraph_id FROM Sentence WHERE id = ?', [orig.sentence_id]).then(r => r?.paragraph_id);
                        await db.run(
                            'INSERT INTO Asset (paragraph_id, sentence_id, type, selected, "order", duration, source_id, file_path) VALUES (?, NULL, ?, 0, 0, ?, ?, ?)',
                            [paraId, orig.type, Math.round(start * 10) / 10, orig.id, beforeRelative]
                        );
                    }
                } catch(e) { console.error('[trim before error]', e.message); }
            }
            // Phần sau [end, total]
            console.log('[trim debug] start:', start, 'end:', end, 'totalDur:', totalDur, 'duration param:', duration);
            if (totalDur && (totalDur - end) > 0.5) {
                const afterPath = `${base}_trim_after_${ts}${ext}`;
                const afterRelative = path.relative(MEDIA_DIR, afterPath);
                console.log('[trim] totalDur:', totalDur, 'end:', end, 'after duration:', totalDur - end, 'afterPath:', afterPath);
                try {
                    execSync(`ffmpeg -ss ${end} -i "${fullPath}" -c copy -y "${afterPath}"`);
                    if (isSection) {
                        await db.run(
                            'INSERT INTO Asset (post_id, section, type, selected, "order", duration, source_id, file_path) VALUES (?, ?, ?, 0, 0, ?, ?, ?)',
                            [orig.post_id, orig.section, orig.type, Math.round((totalDur - end) * 10) / 10, orig.id, afterRelative]
                        );
                    } else {
                        const paraId = orig.paragraph_id || await db.get('SELECT paragraph_id FROM Sentence WHERE id = ?', [orig.sentence_id]).then(r => r?.paragraph_id);
                        await db.run(
                            'INSERT INTO Asset (paragraph_id, sentence_id, type, selected, "order", duration, source_id, file_path) VALUES (?, NULL, ?, 0, 0, ?, ?, ?)',
                            [paraId, orig.type, Math.round((totalDur - end) * 10) / 10, orig.id, afterRelative]
                        );
                    }
                } catch(e) { console.error('[trim after error]', e.message); }
            } else {
                console.log('[trim] skip after: totalDur=', totalDur, 'end=', end);
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
    const post = await db.get('SELECT project_id FROM Post WHERE id = ?', [postId]);
    await db.close();
    const lang = post?.project_id?.match(/_([a-z]{2})$/)?.[1] || 'unknown';
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

// API: Tạo thumbnail cho DỰ ÁN — dùng Google Flow. Nội dung title = title dự án DỊCH sang ngôn ngữ đích.
app.post('/api/create-thumbnail', async (req, res) => {
    const { videoId, postId, lang = 'en', count = 2, ratio = '16:9' } = req.body;
    if (!videoId || !postId) return res.status(400).json({ error: 'Thiếu videoId/postId' });

    const gid = 'thumbnail';
    const subDir = '_thumbnail';
    const targetDir = path.join(MEDIA_DIR, videoId, 'assets', subDir, gid);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    res.json({ success: true, message: 'Đang tạo thumbnail (Flow)...' });

    (async () => {
        const db = await getDb();
        const post = await db.get('SELECT title FROM Post WHERE id = ?', [postId]);
        // 1 đoạn content NGÔN NGỮ ĐÍCH làm mốc để dịch title đúng ngôn ngữ
        const ref = await db.get(
            `SELECT content FROM ParagraphDetail WHERE content IS NOT NULL AND TRIM(content) <> '' AND paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?) ORDER BY id LIMIT 1`,
            [postId]
        );
        await db.close();

        const rawTitle = (post?.title || '').trim();
        if (!rawTitle) { console.error('[Thumbnail] Dự án chưa có title'); return; }

        // Dịch title dự án sang ngôn ngữ đích (theo content đích; fallback mã lang)
        const titleTarget = await translateTitle(rawTitle, ref?.content || '', lang);

        // Prompt Flow: PHẢI nêu rõ là TẠO ẢNH THUMBNAIL (không thì Flow hiểu là chủ đề rồi chat).
        const tFile = path.join(MEDIA_DIR, 'prompts', 'thumbnail', `prompt_flow_${lang}.txt`);
        const tFallback = path.join(MEDIA_DIR, 'prompts', 'thumbnail', 'prompt_flow.txt');
        const fileTpl = fs.existsSync(tFile) ? fs.readFileSync(tFile, 'utf8')
            : fs.existsSync(tFallback) ? fs.readFileSync(tFallback, 'utf8') : '';
        const DEFAULT_TPL = 'Generate ONE image only: a bold, eye-catching 16:9 YouTube thumbnail. Do NOT chat, do NOT ask questions, do NOT write any script/plan/outline — output ONLY the image. Photorealistic, cinematic, dramatic lighting, high contrast, vivid colors, single strong focal subject. Build a scene fitting the headline below and render the headline text large, bold and readable on the image, kept fully inside the frame. Headline:';
        const customPrompt = (fileTpl.trim() || DEFAULT_TPL).replace(/\n/g, ' ');

        // content đưa vào Flow = title đã dịch
        const saved = await generateFlowImage(titleTarget, targetDir, titleTarget, 'image', count, lang, customPrompt, ratio, 'Frames', 'Lite', []);

        const db2 = await getDb();
        for (const fileName of saved) {
            const rel = path.join(videoId, 'assets', subDir, gid, fileName);
            const exists = await db2.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
            if (!exists) await db2.run('INSERT INTO Asset (post_id, section, type, selected, "order", file_path) VALUES (?, ?, ?, 0, 0, ?)', [postId, 'thumbnail', 'image', rel]);
        }
        await db2.close();
        console.log(`[Thumbnail] Flow xong ${saved.length} ảnh | title đích: ${titleTarget}`);
    })().catch(e => console.error('[Thumbnail] Error:', e.message));
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

// API: Mở lại trình duyệt profile để lấy thêm cookie (không auto-login, thao tác thủ công)
app.post('/api/chrome-profiles/:id/open', async (req, res) => {
    try {
        const { url } = req.body || {};
        const db = await getDb();
        const profile = await db.get('SELECT id, profile_dir FROM ChromeProfile WHERE id = ?', [req.params.id]);
        await db.close();
        if (!profile) return res.status(404).json({ error: 'Profile not found' });
        const profileDirName = profile.profile_dir || `chrome-profile-${profile.id}`;
        const args = ['browser.js', profileDirName, '--open', (url && url.trim()) || 'https://x.com'];
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

// ===== CAPCUT =====
const WINDOWS_AGENT = `http://192.168.50.248:5000`;

app.post('/api/export-capcut', (req, res) => {
    const { postId, contentType } = req.body || {};
    if (!postId) return res.status(400).json({ error: 'Thieu postId' });
    const outDir = path.join(MEDIA_DIR, '_capcut_exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    let stdout = '', stderr = '', done = false;
    const args = ['capcut_export.js', String(postId), outDir];
    if (contentType) args.push(contentType);
    const child = spawn(process.execPath, args, {
        cwd: __dirname, env: process.env
    });
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { if (!done) { done = true; res.status(500).json({ error: err.message }); } });
    child.on('close', async code => {
        if (done) return; done = true;
        if (code !== 0) return res.status(500).json({ error: 'exit ' + code + ': ' + stderr.slice(-200) });
        const lines = stdout.trim().split('\n');
        let result = null;
        for (let i = lines.length - 1; i >= 0; i--) { try { result = JSON.parse(lines[i]); break; } catch(_) {} }
        if (!result || !result.zipPath || !result.draftId) return res.status(500).json({ error: 'no result. stdout: ' + stdout.slice(-200) });
        const projectName = result.projectName || path.basename(result.zipPath, '_capcut.zip');
        const draftId = result.draftId;
        const simpleBat = buildLocalBatScript(draftId, projectName);
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const outZipName = `${projectName}_${ts}_bundle.zip`;
        res.setHeader('Content-Type', 'application/zip');
        const safeZipName = outZipName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeZipName}"; filename*=UTF-8''${encodeURIComponent(outZipName)}`);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', e => res.status(500).json({ error: e.message }));
        archive.pipe(res);
        archive.file(result.zipPath, { name: `${projectName}/project.zip` });
        archive.append(Buffer.from(simpleBat, 'utf8'), { name: `${projectName}/install.bat` });
        await archive.finalize();
        res.on('finish', () => { try { fs.unlinkSync(result.zipPath); } catch(_) {} });
    });
});

// Proxy audio CDN -> same-origin để client đọc bytes vẽ waveform (tránh CORS)
app.get('/api/audio-proxy', async (req, res) => {
    const url = req.query.url;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return res.status(400).end();
    let u;
    try { u = new URL(url); } catch { return res.status(400).end(); }
    if (!u.hostname.endsWith('b-cdn.net')) return res.status(403).end(); // allowlist, tránh SSRF
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return res.status(r.status).end();
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(buf);
    } catch (e) { res.status(502).end(); }
});

app.get('/api/capcut-zip/:filename', (req, res) => {
    const filePath = path.join(MEDIA_DIR, '_capcut_exports', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + req.params.filename + '"');
    fs.createReadStream(filePath).pipe(res);
    setTimeout(() => { try { fs.unlinkSync(filePath); } catch(_) {} }, 10 * 60 * 1000);
});

function buildLocalBatScript(draftId, projectName) {
    const CRLF = '\r\n';
    const safeName = projectName.replace(/'/g, '').replace(/"/g, '').trim();
    const bat = [];
    bat.push('@echo off');
    bat.push('chcp 65001 >nul');
    bat.push('title CapCut Installer');
    bat.push('echo.');
    bat.push('echo === Installing project ===');
    bat.push('echo.');
    bat.push('set "DR=%LOCALAPPDATA%\\CapCut\\User Data\\Projects\\com.lveditor.draft"');
    bat.push('if not exist "%DR%" set "DR=%LOCALAPPDATA%\\CapCut\\User Data\\com.lveditor.draft"');
    bat.push('if not exist "%DR%" md "%DR%"');
    bat.push('echo [1/2] Extracting...');
    bat.push('if exist "%DR%\\' + draftId + '" rd /s /q "%DR%\\' + draftId + '"');
    bat.push('powershell -NoProfile -Command "Expand-Archive -LiteralPath \'%~dp0project.zip\' -DestinationPath \'%DR%\' -Force"');
    bat.push('echo [2/2] Updating index...');
    bat.push('set "PROJ_NAME=' + safeName + '"');
    const ps = [
        '$f=\'C:/Users/trinh/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft/' + draftId + '\'',
        '$r=Join-Path (Split-Path -Parent $f) \'root_meta_info.json\'',
        '$id=\'' + draftId + '\'',
        '$n=$env:PROJ_NAME',
        '$t=[long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())*1000',
        '$rp=Split-Path -Parent $f',
        'if(Test-Path $r){$j=Get-Content $r -Raw|ConvertFrom-Json}else{$j=[PSCustomObject]@{all_draft_store=@();draft_ids=0;root_path=$rp}}',
        '$ne=[PSCustomObject]@{draft_fold_path=($f-replace\'\\\\\',\'/\');draft_id=$id;draft_name=$n;draft_root_path=$rp;draft_json_file=(($f-replace\'\\\\\',\'/\')+\'/draft_content.json\');tm_draft_create=$t;tm_draft_modified=$t;tm_draft_removed=0;tm_duration=300000000;draft_timeline_materials_size=2000000;streaming_edit_draft_ready=$true;cloud_draft_cover=$false;cloud_draft_sync=$false;draft_is_invisible=$false}',
        '$j.all_draft_store=@($ne)+($j.all_draft_store|Where-Object{$_.draft_id -ne $id})',
        'ConvertTo-Json $j -Depth 10 -Compress|Set-Content $r -Encoding UTF8',
        'Write-Host \'OK\'',
    ].join(';');
    bat.push('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"');
    bat.push('echo.');
    bat.push('echo === Done! Open CapCut to see your project ===');
    bat.push('echo.');
    bat.push('pause');
    return bat.join(CRLF);
}

app.post('/api/render-capcut', (req, res) => {
    const { postId, contentType } = req.body;
    if (!postId) return res.status(400).json({ error: 'Missing postId' });
    const outDir = path.join(MEDIA_DIR, '_capcut_exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    let stdout = '', stderr = '', done = false;
    const renderArgs = ['capcut_export.js', String(postId), outDir];
    if (contentType) renderArgs.push(contentType);
    const child = spawn(process.execPath, renderArgs, {
        cwd: __dirname, env: process.env
    });
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', async code => {
        if (done) return; done = true;
        if (code !== 0) return res.status(500).json({ error: stderr.slice(-200) });
        const lines = stdout.trim().split('\n');
        let result = null;
        for (let i = lines.length - 1; i >= 0; i--) { try { result = JSON.parse(lines[i]); break; } catch(_) {} }
        if (!result?.zipPath) return res.status(500).json({ error: 'Export failed' });
        const LINUX_IP = process.env.LINUX_IP || '192.168.50.43';
        const zipUrl = (req.headers['x-forwarded-proto'] || 'http') + '://' + LINUX_IP + ':' + PORT + '/api/capcut-zip/' + path.basename(result.zipPath);
        try {
            const agentRes = await fetch(`${WINDOWS_AGENT}/render`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ draftId: result.draftId, projectName: result.projectName, postId, zipUrl })
            });
            const agentData = await agentRes.json();
            res.json({ ok: true, message: 'Render started on Windows', ...agentData });
        } catch (e) {
            res.status(500).json({ error: `Windows agent unreachable: ${e.message}` });
        }
    });
});

app.post('/api/capcut-render-done', upload.single('video'), async (req, res) => {
    try {
        const { postId, projectName } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const outDir = path.join(MEDIA_DIR, '_rendered');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `${projectName}_${Date.now()}.mp4`);
        fs.renameSync(req.file.path, outPath);
        console.log(`[Render] Done: ${outPath}`);
        res.json({ ok: true, path: outPath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/capcut-render-status', (req, res) => {
    const { postId, status, message } = req.body;
    console.log(`[Render] Post ${postId}: ${status} - ${message}`);
    res.json({ ok: true });
});

app.post('/api/debug-screenshot', (req, res) => {
    const tempUpload = multer({ dest: '/tmp' }).single('img');
    tempUpload(req, res, (err) => {
        if (err || !req.file) return res.status(400).end();
        const dest = `/tmp/debug_${Date.now()}.png`;
        fs.renameSync(req.file.path, dest);
        console.log('[Debug screenshot]', dest);
        res.json({ ok: true, path: dest });
    });
});
// ===== END CAPCUT =====

// ===== LIPS SYNC (proxy tới server local http://127.0.0.1:8010) — port từ main_v4 =====
const LIPS_SYNC_BASE = process.env.LIPS_SYNC_URL || 'http://127.0.0.1:8010';
app.post('/api/lips-sync/jobs', async (req, res) => {
    try {
        const r = await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body || {}),
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (e) {
        res.status(502).json({ error: 'Không kết nối được lips_sync server: ' + e.message });
    }
});
app.get('/api/lips-sync/jobs/:id', async (req, res) => {
    try {
        const r = await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs/${encodeURIComponent(req.params.id)}`);
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (e) {
        res.status(502).json({ error: 'Không kết nối được lips_sync server: ' + e.message });
    }
});
// Đường dẫn file cấu hình auto lips_sync của 1 project (ghi lúc tạo project nếu bật option)
function lipsAutoConfigPath(rawProjectId) {
    const projectId = String(rawProjectId).replace(/_[a-z]{2}$/, '');
    return path.join(MEDIA_DIR, projectId, 'lips_sync', 'auto.json');
}
function readLipsAutoConfig(rawProjectId) {
    try {
        const p = lipsAutoConfigPath(rawProjectId);
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
}
// Ghi cấu hình auto lips_sync cho project (chỉ khi bật + có video mặt hợp lệ)
function writeLipsAutoConfig(rawProjectId, { video, guidanceScale }) {
    const p = lipsAutoConfigPath(rawProjectId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const gs = Number(guidanceScale);
    const cfg = {
        enabled: true,
        video: String(video),
        contentType: 'content', // luôn chạy trên audio ngôn ngữ đích (target)
        guidanceScale: Number.isFinite(gs) ? gs : 2.2,
    };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    return cfg;
}

// Chạy lips_sync cho TỪNG CÂU của 1 post: tải mp3 mỗi câu, gửi job, output lưu vào <project>/lips_sync/
// Dùng chung cho endpoint thủ công (/run-post) lẫn auto sau khi tạo audio (/auto-run).
async function runLipsSyncForPost({ postId, videoPath, contentType: reqCt, force, guidanceScale }) {
    if (!postId || !videoPath) { const e = new Error('Thiếu postId hoặc videoPath'); e.status = 400; throw e; }
    if (!fs.existsSync(videoPath)) { const e = new Error('Video không tồn tại: ' + videoPath); e.status = 400; throw e; }
    const gs = Number(guidanceScale);
    const guidance = Number.isFinite(gs) ? gs : 2.2;

    const db = await getDb();
    const post = await db.get('SELECT project_id, voice_content_type FROM Post WHERE id = ?', [postId]);
    await db.close();
    if (!post) { const e = new Error('Không tìm thấy post'); e.status = 404; throw e; }

    const contentType = reqCt || post.voice_content_type || 'content';
    const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
    const outDir = path.join(MEDIA_DIR, projectId, 'lips_sync');
    fs.mkdirSync(outDir, { recursive: true });

    const audioList = await getAllAudioUrls(postId, contentType);
    const jobs = [];
    for (let i = 0; i < audioList.length; i++) {
            const idx = i + 1;
            const audioUrl = audioList[i].audio;
            const audioPath = path.join(outDir, `${idx}.mp3`);
            const outputPath = path.join(outDir, `${idx}.mp4`);
            if (!audioUrl) { jobs.push({ index: idx, audioPath, outputPath, error: 'Không có audio' }); continue; }
            // Bỏ qua câu đã có mp4 (trừ khi chạy lại từ đầu)
            if (!force && fs.existsSync(outputPath)) {
                jobs.push({ index: idx, audioPath, outputPath, status: 'done', skipped: true });
                continue;
            }
            try {
                const buf = await fetchBunnyAudio(audioUrl);
                fs.writeFileSync(audioPath, buf);
                const r = await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ video_path: videoPath, audio_path: audioPath, output_path: outputPath, guidance_scale: guidance }),
                });
                const data = await r.json();
                if (!r.ok || data.error) { jobs.push({ index: idx, audioPath, outputPath, error: data.error || ('HTTP ' + r.status) }); continue; }
                jobs.push({ index: idx, jobId: data.job_id, status: data.status || 'queued', audioPath, outputPath });
            } catch (e) {
                jobs.push({ index: idx, audioPath, outputPath, error: e.message });
            }
        }

        // Lưu kết quả vào DB (upsert theo post_id + idx)
        const now = Date.now();
        const wdb = await getDb();
        try {
            // Xoá row thừa nếu số câu giảm
            await wdb.run('DELETE FROM LipsSyncJob WHERE post_id = ? AND idx > ?', [postId, audioList.length]);
            for (const j of jobs) {
                await wdb.run(
                    `INSERT INTO LipsSyncJob (post_id, idx, job_id, status, content_type, video_path, audio_path, output_path, guidance_scale, error, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(post_id, idx) DO UPDATE SET
                        job_id=excluded.job_id, status=excluded.status, content_type=excluded.content_type,
                        video_path=excluded.video_path, audio_path=excluded.audio_path, output_path=excluded.output_path,
                        guidance_scale=excluded.guidance_scale, error=excluded.error, updated_at=excluded.updated_at`,
                    [postId, j.index, j.jobId || null, j.error ? 'error' : (j.status || 'queued'), contentType,
                     videoPath, j.audioPath, j.outputPath, guidance, j.error || null, now, now]
                );
            }
    } finally { await wdb.close(); }

    return { projectId, outDir, total: audioList.length, jobs };
}

app.post('/api/lips-sync/run-post', async (req, res) => {
    try {
        const out = await runLipsSyncForPost(req.body || {});
        res.json(out);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Đọc cấu hình auto lips_sync đã lưu lúc tạo project (client kiểm tra trước khi tự chạy)
app.get('/api/lips-sync/auto/:projectId', (req, res) => {
    const cfg = readLipsAutoConfig(req.params.projectId);
    res.json(cfg && cfg.enabled ? cfg : { enabled: false });
});
// Tự chạy lips_sync sau khi audio target (content) gen xong — dựa trên auto.json của project
app.post('/api/lips-sync/auto-run', async (req, res) => {
    try {
        const { postId, force } = req.body || {};
        if (!postId) return res.status(400).json({ error: 'Thiếu postId' });
        const db = await getDb();
        const post = await db.get('SELECT project_id FROM Post WHERE id = ?', [postId]);
        await db.close();
        if (!post) return res.status(404).json({ error: 'Không tìm thấy post' });
        const cfg = readLipsAutoConfig(post.project_id);
        if (!cfg || !cfg.enabled) return res.json({ enabled: false });
        if (!cfg.video || !fs.existsSync(cfg.video)) {
            return res.status(400).json({ enabled: true, error: 'Video mặt cho auto lips sync không tồn tại: ' + (cfg.video || '(trống)') });
        }
        const out = await runLipsSyncForPost({
            postId,
            videoPath: cfg.video,
            contentType: 'content',
            force: !!force,
            guidanceScale: cfg.guidanceScale,
        });
        res.json({ enabled: true, ...out });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Kiểm tra trạng thái nhiều job cùng lúc (đồng thời cập nhật DB)
app.post('/api/lips-sync/status', async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.jobIds) ? req.body.jobIds : [];
        const out = {};
        const now = Date.now();
        const db = await getDb();
        try {
            for (const id of ids) {
                if (!id) continue;
                try {
                    const r = await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs/${encodeURIComponent(id)}`);
                    const data = await r.json();
                    out[id] = data;
                    if (data && (data.status || data.output_path || data.error)) {
                        await db.run(
                            'UPDATE LipsSyncJob SET status = COALESCE(?, status), output_path = COALESCE(?, output_path), error = ?, updated_at = ? WHERE job_id = ?',
                            [data.status || null, data.output_path || null, data.error || null, now, id]
                        );
                    }
                } catch (e) { out[id] = { error: e.message }; }
            }
        } finally { await db.close(); }
        res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Tải lại kết quả lips_sync đã lưu của 1 post
app.get('/api/lips-sync/saved/:postId', async (req, res) => {
    try {
        const db = await getDb();
        const rows = await db.all(
            `SELECT idx AS "index", job_id AS jobId, status, content_type AS contentType,
                    video_path AS videoPath, audio_path AS audioPath, output_path AS outputPath,
                    guidance_scale AS guidanceScale, error
             FROM LipsSyncJob WHERE post_id = ? ORDER BY idx`,
            [req.params.postId]
        );
        const post = await db.get('SELECT project_id FROM Post WHERE id = ?', [req.params.postId]);
        await db.close();

        const meta = rows.find(r => r.videoPath) || {};
        const contentType = meta.contentType || 'content';
        let jobs = rows;

        // Fallback: chưa lưu DB nhưng đã có file mp4 trên đĩa -> vẫn hiển thị
        if (!jobs.length && post) {
            const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
            const dir = path.join(MEDIA_DIR, projectId, 'lips_sync');
            if (fs.existsSync(dir)) {
                jobs = fs.readdirSync(dir).filter(f => /^\d+\.mp4$/i.test(f))
                    .map(f => ({ index: parseInt(f, 10), status: 'done', outputPath: path.join(dir, f) }))
                    .sort((a, b) => a.index - b.index);
            }
        }

        // Gắn URL audio gốc theo idx để client map lips_sync video vào từng câu
        if (jobs.length) {
            try {
                const audioList = await getAllAudioUrls(req.params.postId, contentType);
                for (const j of jobs) { const a = audioList[j.index - 1]; if (a) j.audio = a.audio; }
            } catch (_) { }
        }
        res.json({
            jobs,
            videoPath: meta.videoPath || '',
            contentType,
            guidanceScale: meta.guidanceScale ?? 2.2,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Upload file lên server rồi trả về đường dẫn tuyệt đối để dùng làm input lips_sync
app.post('/api/lips-sync/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Thiếu file' });
        const destDir = path.join(MEDIA_DIR, 'lips_sync_uploads');
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        const ext = path.extname(req.file.originalname) || (req.body.kind === 'audio' ? '.mp3' : '.mp4');
        const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        const destPath = path.join(destDir, fileName);
        fs.renameSync(req.file.path, destPath);
        res.json({ path: destPath, name: req.file.originalname });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Duyệt file/thư mục trên máy server để chọn input (lấy đường dẫn tuyệt đối)
app.get('/api/lips-sync/browse', (req, res) => {
    try {
        let dir = req.query.dir ? String(req.query.dir) : (process.env.HOME || process.cwd());
        dir = path.resolve(dir);
        if (!fs.existsSync(dir)) dir = process.env.HOME || process.cwd();
        if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
        const exts = (req.query.ext ? String(req.query.ext).split(',') : [])
            .map(e => e.trim().toLowerCase()).filter(Boolean);
        const entries = [];
        for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
            if (it.name.startsWith('.')) continue; // bỏ file/thư mục ẩn
            const full = path.join(dir, it.name);
            let isDir = it.isDirectory();
            if (it.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { continue; } }
            if (isDir) { entries.push({ name: it.name, path: full, isDir: true }); continue; }
            const ext = path.extname(it.name).slice(1).toLowerCase();
            if (exts.length && !exts.includes(ext)) continue;
            let size = 0; try { size = fs.statSync(full).size; } catch { }
            entries.push({ name: it.name, path: full, isDir: false, size });
        }
        entries.sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1));
        const parent = path.dirname(dir);
        res.json({ dir, parent: parent === dir ? null : parent, entries });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});
// Stream video output (nằm ngoài thư mục static) để preview, hỗ trợ tua (Range)
app.get('/api/lips-sync/preview', (req, res) => {
    const p = req.query.path;
    if (!p || !fs.existsSync(p)) return res.status(404).send('Not found');
    res.sendFile(path.resolve(p), (err) => {
        if (err && !res.headersSent) res.status(404).send('Not found');
    });
});
// ===== END LIPS SYNC =====

app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'index.html'));
});
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
