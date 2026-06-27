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
        const posts = await db.all('SELECT id, project_id, status, audio_uuid, COALESCE(title, project_id) AS title, voice_content_type FROM Post ORDER BY id DESC');
        await db.close();
        res.json(posts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Chi tiết 1 post: paragraphs + keywords + assets (file media quét từ thư mục)
app.get('/api/posts/:postId', async (req, res) => {
    try {
        const db = await getDb();
        const post = await db.get('SELECT id, project_id, title, hook, hook_vi, hook_audio, hook_vi_audio, summary, summary_vi, summary_audio, summary_vi_audio, summary_target, summary_target_audio, conclusion_vi, conclusion_vi_audio, conclusion_target, conclusion_target_audio FROM Post WHERE id = ?', [req.params.postId]);
        if (!post) return res.status(404).json({ error: 'Post not found' });

        // HookDetail
        post.hook_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, "order" FROM HookDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );
        // Load assets for each hook_detail
        for (const detail of post.hook_details) {
            const assets = await db.all('SELECT id, type, selected, "order", file_path, duration, source_url FROM Asset WHERE hook_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
            detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
            detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
        }
        
        // ConclusionDetail
        post.conclusion_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, "order" FROM ConclusionDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );
        for (const detail of post.conclusion_details) {
            const assets = await db.all('SELECT id, type, selected, "order", file_path, duration, source_url FROM Asset WHERE conclusion_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
            detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
            detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
        }
        
        // SummaryDetail
        post.summary_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, "order" FROM SummaryDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );
        // Load assets for each summary_detail
        for (const detail of post.summary_details) {
            const assets = await db.all('SELECT id, type, selected, "order", file_path, duration, source_url FROM Asset WHERE summary_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
            detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
            detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
        }

        // Lấy keywords và assets cho từng section của post
        const sections = {};
        for (const section of ['hook', 'summary', 'conclusion']) {
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
            'SELECT id, content, content_vi, title, title_vi, content_audio, content_vi_audio, title_audio, title_vi_audio FROM Paragraph WHERE post_id = ? ORDER BY id',
            [post.id]
        );

        // Lấy tên thư mục gốc (bỏ suffix _en, _vi...)
        const projectId = post.project_id.replace(/_[a-z]{2}$/, '');

        for (let i = 0; i < paragraphs.length; i++) {
            const para = paragraphs[i];
            const gid = String(i + 1);

            // ParagraphDetail
            para.details = await db.all(
                'SELECT id, content, content_vi, content_audio, content_vi_audio, "order" FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"',
                [para.id]
            );
            // Load assets for each paragraph_detail
            for (const detail of para.details) {
                const assets = await db.all('SELECT id, type, selected, "order", file_path, duration, source_url FROM Asset WHERE paragraph_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
                detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
                detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
            }
            const rawSentences = await db.all(
                'SELECT id, content, content_vi, title, title_vi, content_audio, content_vi_audio, title_audio, title_vi_audio, audio, sentence_uuid, "order" FROM Sentence WHERE paragraph_id = ? ORDER BY "order"',
                [para.id]
            );
            para.sentences = await Promise.all(rawSentences.map(async s => {
                const details = await db.all(
                    'SELECT id, content, content_vi, content_audio, content_vi_audio, "order" FROM SentenceDetail WHERE sentence_id = ? ORDER BY "order"',
                    [s.id]
                );
                // Load assets for each sentence_detail
                for (const detail of details) {
                    const assets = await db.all('SELECT id, type, selected, "order", file_path, duration, source_url FROM Asset WHERE sentence_detail_id = ? ORDER BY selected DESC, "order", id', [detail.id]);
                    detail.videos = assets.filter(a => a.type === 'video').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
                    detail.images = assets.filter(a => a.type === 'image').map(a => ({ id: a.id, name: path.basename(a.file_path), url: `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, duration: a.duration || 0, sourceUrl: a.source_url || null }));
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
                'SELECT id, type, selected, "order", file_path, sentence_id, paragraph_id, duration, source_url FROM Asset WHERE (paragraph_id = ? OR sentence_id IN (SELECT id FROM Sentence WHERE paragraph_id = ?)) AND paragraph_detail_id IS NULL AND sentence_detail_id IS NULL ORDER BY id',
                [para.id, para.id]
            );
            para.videos = assets
                .filter(a => a.type === 'video' && (a.paragraph_id || a.sentence_id))
                .map(a => ({ id: a.id, name: path.basename(a.file_path), url: a.file_path.startsWith('http') ? a.file_path : `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, sentenceId: a.sentence_id || null, duration: a.duration || 0, sourceUrl: a.source_url || null }));
            para.images = assets
                .filter(a => a.type === 'image' && (a.paragraph_id || a.sentence_id))
                .map(a => ({ id: a.id, name: path.basename(a.file_path), url: a.file_path.startsWith('http') ? a.file_path : `/${a.file_path}`, relativePath: a.file_path, selected: !!a.selected, order: a.order || 0, sentenceId: a.sentence_id || null, duration: a.duration || 0, sourceUrl: a.source_url || null }));

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
                // Từ detail -> detail: chỉ update id
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

    console.log(`\n[HỆ THỐNG] Bắt đầu lấy Media cho: Dự án ${videoId} | Nhóm ${groupId}`);
    console.log(`[HỆ THỐNG] Từ khóa: ${keywords.join(', ')}`);

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
            const insS = (rel, t) => db.run('INSERT INTO Asset (post_id, section, type, file_path) VALUES (?, ?, ?, ?)', [postId, section, t, rel]);
            for (const { content: kw } of kws) {
                await fetchAndDownloadStock(kw, 'video', vF, 4).catch(() => {});
                await syncDir(vF, 'video', insS);   // insert vào DB ngay sau mỗi keyword (realtime)
                await fetchAndDownloadStock(kw, 'image', iF, 8).catch(() => {});
                await syncDir(iF, 'image', insS);
            }
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
            const insP = (rel, t) => db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [para.id, t, rel]);
            for (const { content: kw } of kws) {
                await fetchAndDownloadStock(kw, 'video', vF, 4).catch(() => {});
                await syncDir(vF, 'video', insP);   // insert vào DB ngay sau mỗi keyword (realtime)
                await fetchAndDownloadStock(kw, 'image', iF, 8).catch(() => {});
                await syncDir(iF, 'image', insP);
            }
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

// API: Tạo mới dự án từ nội dung
app.post('/api/create-project', async (req, res) => {
    const { content, keywords, sources, country, targetLang } = req.body;
    // LUỒNG MỚI: input là mảng từ khóa + mảng domain nguồn. Vẫn nhận content (chủ đề/tiêu đề) làm tuỳ chọn.
    const kwArr = Array.isArray(keywords) ? keywords.map(s => String(s).trim()).filter(Boolean) : [];
    const srcArr = Array.isArray(sources) ? sources.map(s => String(s).trim()).filter(Boolean) : [];
    if (!kwArr.length && !content?.trim()) return res.status(400).json({ error: 'Thiếu từ khóa (keywords) hoặc nội dung' });
    try {
        const projectId = 'proj_' + Date.now();
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'original_content.txt'), (content?.trim()) || kwArr.join('\n'));
        const cGl = (country && country.gl) || '';
        const cHl = (country && country.hl) || '';
        const procArgs = [
            'process_content.js',
            '--projectId', projectId,
            '--keywords', JSON.stringify(kwArr),
            '--sources', JSON.stringify(srcArr),
            '--country', cGl,
            '--clang', cHl,
            '--targetLang', targetLang || 'en'
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


// ===== CapCut export/render (port từ main_sports) =====
app.post('/api/export-capcut', (req, res) => {
    const postId = req.body && req.body.postId;
    const contentType = req.body && req.body.contentType;
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
        const bat = buildBatScript(null, draftId, projectName); // zipUrl=null vì zip nằm sẵn trong folder
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const outZipName = `${projectName}_${ts}_bundle.zip`;

        // Tạo zip bundle: giải nén draft zip rồi đóng gói lại kèm file bat
        res.setHeader('Content-Type', 'application/zip');
        const safeZipName = outZipName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${safeZipName}"; filename*=UTF-8''${encodeURIComponent(outZipName)}`);

        const archive = (await import('archiver')).default('zip', { zlib: { level: 6 } });
        archive.on('error', e => res.status(500).json({ error: e.message }));
        archive.pipe(res);

        // Thêm toàn bộ nội dung draft zip vào bundle (dưới thư mục project/)
        archive.file(result.zipPath, { name: `${projectName}/project.zip` });

        // Tạo file bat đơn giản: chỉ cần giải nén và update index
        const simpleBat = buildLocalBatScript(draftId, projectName);
        archive.append(Buffer.from(simpleBat, 'utf8'), { name: `${projectName}/install.bat` });

        await archive.finalize();
        // Xóa zip gốc sau khi done
        res.on('finish', () => { try { fs.unlinkSync(result.zipPath); } catch(_) {} });
    });
})
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
    // Sanitize projectName: bỏ ký tự gây lỗi trong PS/bat
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

function buildBatScript(zipUrl, draftId, projectName) {
    const CRLF = '\r\n';
    const bat = [];
    bat.push('@echo off');
    bat.push('chcp 65001 >nul');
    bat.push('title CapCut Project Installer');
    bat.push('setlocal enabledelayedexpansion');
    bat.push('echo.');
    bat.push('echo === CapCut Project Installer: ' + projectName + ' ===');
    bat.push('echo.');
    bat.push('set "CTMP=%TEMP%\\capcut_tmp_%RANDOM%"');
    bat.push('set "ZIP=%CTMP%\\project.zip"');
    bat.push('md "%CTMP%"');
    bat.push('');
    bat.push('echo [1/3] Downloading...');
    bat.push('powershell -NoProfile -Command "Invoke-WebRequest -Uri \'' + zipUrl + '\' -OutFile \'%ZIP%\' -UseBasicParsing"');
    bat.push('if not exist "%ZIP%" ( echo FAILED: Download & pause & exit /b 1 )');
    bat.push('echo OK');
    bat.push('');
    bat.push('echo [2/3] Installing...');
    bat.push('set "DR=%LOCALAPPDATA%\\CapCut\\User Data\\Projects\\com.lveditor.draft"');
    bat.push('if not exist "%DR%" set "DR=%LOCALAPPDATA%\\CapCut\\User Data\\com.lveditor.draft"');
    bat.push('if not exist "%DR%" md "%DR%"');
    bat.push('if exist "%DR%\\' + draftId + '" rd /s /q "%DR%\\' + draftId + '"');
    bat.push('powershell -NoProfile -Command "Expand-Archive -LiteralPath \'%ZIP%\' -DestinationPath \'%DR%\' -Force"');
    bat.push('set "DDIR=%DR%\\' + draftId + '"');
    bat.push('if not exist "%DDIR%" ( echo FAILED: Extract & pause & exit /b 1 )');
    bat.push('echo OK');
    bat.push('');
    bat.push('echo [3/3] Updating CapCut index...');
    const ps = [
        '$f=\'%DDIR%\'',
        '$r=Join-Path (Split-Path -Parent $f) \'root_meta_info.json\'',
        '$id=\'' + draftId + '\'',
        '$n=\'' + projectName + '\'',
        '$t=[long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())*1000',
        '$fp=\'' + 'C:/Users/trinh/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft/' + draftId + '\'',
        '$rp=\'' + 'C:/Users/trinh/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft' + '\'',
        'if(Test-Path $r){$j=Get-Content $r -Raw|ConvertFrom-Json}else{$j=[PSCustomObject]@{all_draft_store=@();draft_ids=0;root_path=$rp}}',
        '$ne=[PSCustomObject]@{draft_fold_path=$fp;draft_id=$id;draft_name=$n;draft_root_path=$rp;draft_json_file=($fp+\'/draft_content.json\');tm_draft_create=$t;tm_draft_modified=$t;tm_draft_removed=0;tm_duration=300000000;draft_timeline_materials_size=2000000;streaming_edit_draft_ready=$true;cloud_draft_cover=$false;cloud_draft_sync=$false;draft_is_invisible=$false}',
        '$j.all_draft_store=@($ne)+($j.all_draft_store|Where-Object{$_.draft_id -ne $id})',
        'ConvertTo-Json $j -Depth 10 -Compress|Set-Content $r -Encoding UTF8',
        'Write-Host \'OK\'',
    ].join(';');
    bat.push('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"');
    bat.push('rd /s /q "%CTMP%" 2>nul');
    bat.push('echo.');
    bat.push('echo === Done! Mo CapCut va chon du an: ' + projectName + ' ===');
    bat.push('echo.');
    bat.push('pause');
    bat.push('endlocal');
    return bat.join(CRLF);
}

const WINDOWS_AGENT = `http://192.168.50.248:5000`;

app.post('/api/render-capcut', (req, res) => {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: 'Missing postId' });
    const outDir = path.join(MEDIA_DIR, '_capcut_exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    let stdout = '', stderr = '', done = false;
    const child = spawn(process.execPath, ['capcut_export.js', String(postId), outDir], {
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
        // Cài vào CapCut folder trên Windows rồi render
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
// ===== end CapCut =====

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
