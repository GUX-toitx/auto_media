import { fetchIPv4 as fetch } from './src/lib/fetchIPv4.js';
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
import { processAll } from './src/services/video_service.js';
import { generateFlowImage } from './src/services/browser.js';
import { crawlX } from './src/x/x_crawler.js';
import { generateSeoTitle } from './src/services/seoTitle.js';
import { translateTitle } from './src/services/translateTitle.js';
import archiver from 'archiver';
import { downloadWithYtDlp } from './src/services/ytDlpDownloader.js'; // Nhúng con Bot vừa viết
import { ensureThumb } from './src/services/thumbs.js';
import { proxyPathFor, proxyReady, ensureProxy, warmProxies, hasNvenc, needsProxy } from './src/lib/proxies.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

// ffmpeg/ffprobe PHẢI chạy async: execSync khoá event loop của Node, tức là suốt lúc cắt/crop
// (vài giây) server không phục vụ được gì — thumbnail, video, API đều đứng. Đó là lý do chọn/trim video thấy lâu.
const execFileP = promisify(execFile);
const runFfmpeg = (args) => execFileP('ffmpeg', args, { maxBuffer: 32 * 1024 * 1024 });
async function ffprobeDuration(file) {
    try {
        const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
        return parseFloat(String(stdout).trim()) || 0;
    } catch { return 0; }
}
// Tên codec của luồng hình đầu tiên ('mjpeg', 'png', 'h264'...). '' nếu đọc không được.
async function ffprobeVideoCodec(file) {
    try {
        const { stdout } = await execFileP('ffprobe',
            ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]);
        return String(stdout).trim();
    } catch { return ''; }
}
// Codec của ẢNH TĨNH. Dùng để chặn việc ghi đè 1 file ảnh bằng luồng video.
const STILL_IMAGE_CODECS = new Set(['mjpeg', 'png', 'webp', 'bmp', 'gif', 'tiff']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import crypto from 'crypto';
import os from 'os';
import { listLipsLib, lipsLibVideo, saveLipsLibFile, removeLipsLibFile, resolveLipsVideo, lipsWeekday, normLipsGenre, LIPS_GENRES, LIPS_GENRE_LABELS, LIPS_WEEKDAY_LABELS } from './src/lib/lipsVideoLib.js';

// IP LAN của máy (cho người cùng mạng truy cập) — ưu tiên 192.168.*, rồi 10.*, tránh docker 172.17/172.18.
function getLanIp() {
    try {
        const addrs = [];
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces || {})) for (const i of ifaces[name] || []) if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
        return addrs.find(a => a.startsWith('192.168.')) || addrs.find(a => a.startsWith('10.'))
            || addrs.find(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a) && !/^172\.1[78]\./.test(a)) || addrs[0] || 'localhost';
    } catch { return 'localhost'; }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || '/usr/gux/media-team/db';

app.use(express.json()); // BẮT BUỘC PHẢI CÓ DÒNG NÀY Ở ĐÂY

const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');
// DB dùng CHUNG với các worker crawl (tiến trình riêng, ghi Asset/Keyword liên tục).
// Mặc định sqlite3 chỉ chờ 1s rồi ném SQLITE_BUSY → lệnh sửa/xóa bấm từ dashboard fail ngay
// khi pipeline đang ghi, trông như "nút không hoạt động". Chờ 15s cho khoá nhả ra.
const getDb = async () => {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.run('PRAGMA busy_timeout = 15000').catch(() => {});
    return db;
};

// Mã dự án theo NGÀY GIỜ (giờ địa phương): <prefix>YYYY-MM-DD_HH-MM-SS — vd proj_2026-07-16_13-43-40.
// Ngăn cách cho dễ đọc. Có cả GIÂY để 2 dự án tạo trong cùng 1 phút không trùng mã
// (project_id là UNIQUE + là tên thư mục → trùng phút sẽ đè/gộp dữ liệu).
// GIỮ tiền tố 'proj_' (geo) / 'naze_' (naze,drama): UI nhận diện thể loại theo tiền tố này.
// KẾT THÚC bằng giây (2 chữ SỐ) → không dính regex /_([a-z]{2})$/ nhận diện hậu tố ngôn ngữ (_vi/_en).
function stampId(prefix) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${prefix}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// API: Lấy danh sách posts
app.get('/api/posts', async (req, res) => {
    try {
        const db = await getDb();
        // genre có thể NULL với post do nhánh khác tạo (dùng chung DB) → suy ra từ project_id để không lọt khỏi menu
        const posts = await db.all(`SELECT id, project_id, status, audio_uuid, COALESCE(title, project_id) AS title, voice_content_type, content_score,
                                           COALESCE(genre, CASE WHEN project_id LIKE 'proj_%' THEN 'geo' ELSE 'naze' END) AS genre
                                    FROM Post ORDER BY id DESC`);
        await db.close();
        res.json(posts);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Chi tiết 1 post: paragraphs + keywords + assets (file media quét từ thư mục)
app.get('/api/posts/:postId', async (req, res) => {
    try {
        const db = await getDb();
        const post = await db.get('SELECT id, project_id, title, hook, hook_vi, hook_audio, hook_vi_audio, summary, summary_vi, summary_audio, summary_vi_audio, summary_target, summary_target_audio, conclusion_vi, conclusion_vi_audio, conclusion_target, conclusion_target_audio, intro_path, outro_path, seo_title, content_score, content_score_reason, content_score_detail, content_score_history, silence_duration, voice_content_type, genre FROM Post WHERE id = ?', [req.params.postId]);
        if (!post) return res.status(404).json({ error: 'Post not found' });

        // HookDetail
        post.hook_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM HookDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );
        
        // ConclusionDetail
        post.conclusion_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM ConclusionDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );

        // SummaryDetail
        post.summary_details = await db.all(
            'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM SummaryDetail WHERE post_id = ? ORDER BY "order"',
            [post.id]
        );

        // Lấy keywords và assets cho từng section của post
        const sections = {};
        for (const section of ['hook', 'summary', 'conclusion', 'thumbnail', 'x']) {
            const kws = await db.all('SELECT id, content, type FROM Keyword WHERE post_id = ? AND section = ? ORDER BY id', [post.id, section]);
            const assets = await db.all('SELECT id, type, selected, "order", file_path, duration, source_url FROM Asset WHERE post_id = ? AND section = ? ORDER BY selected DESC, COALESCE(source_id, id), id', [post.id, section]);
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
            const rawSentences = await db.all(
                'SELECT id, content, content_vi, title, title_vi, content_audio, content_vi_audio, title_audio, title_vi_audio, title_wt, title_vi_wt, audio, sentence_uuid, "order" FROM Sentence WHERE paragraph_id = ? ORDER BY "order"',
                [para.id]
            );
            para.sentences = await Promise.all(rawSentences.map(async s => {
                const details = await db.all(
                    'SELECT id, content, content_vi, content_audio, content_vi_audio, content_wt, content_vi_wt, "order" FROM SentenceDetail WHERE sentence_id = ? ORDER BY "order"',
                    [s.id]
                );
                return { ...s, sentenceUuid: s.sentence_uuid, audioUrl: s.audio ? (s.audio.startsWith('http') ? s.audio : `/${s.audio}`) : null, details };
            }));

            // Keywords từ DB
            para.keywords = (await db.all(
                'SELECT id, content, type FROM Keyword WHERE paragraph_id = ? ORDER BY id',
                [para.id]
            ));

            // File media từ DB (exclude assets assigned to details)
            const assets = await db.all(
                'SELECT id, type, selected, "order", file_path, sentence_id, paragraph_id, duration FROM Asset WHERE (paragraph_id = ? OR sentence_id IN (SELECT id FROM Sentence WHERE paragraph_id = ?)) ORDER BY id',
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

        // Mở project = encode nền proxy 480p cho toàn bộ video của nó, để lúc bấm xem là có sẵn.
        // Asset video nằm rải ở nhiều tầng (section / paragraph / detail / sentence) nên duyệt cả cây.
        const vids = new Set();
        (function collect(node) {
            if (Array.isArray(node)) return node.forEach(collect);
            if (!node || typeof node !== 'object') return;
            if (typeof node.relativePath === 'string' && /\.(mp4|mov|mkv|webm|avi)$/i.test(node.relativePath)) vids.add(node.relativePath);
            Object.values(node).forEach(collect);
        })({ paragraphs, sections });
        warmProxies(MEDIA_DIR, [...vids], `post:${post.id}`);
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
    const { assetId, targetParagraphId, targetPostId, targetSection, targetSentenceId } = req.body;
    try {
        const db = await getDb();
        const asset = await db.get('SELECT * FROM Asset WHERE id = ?', [assetId]);
        if (!asset) { await db.close(); return res.status(404).json({ error: 'Asset not found' }); }

        if (targetPostId && targetSection) {
            await db.run('UPDATE Asset SET paragraph_id = NULL, sentence_id = NULL, post_id = ?, section = ?, hook_detail_id = NULL, summary_detail_id = NULL, conclusion_detail_id = NULL, paragraph_detail_id = NULL, sentence_detail_id = NULL WHERE id = ?',
                [targetPostId, targetSection, assetId]);
        } else if (targetSentenceId) {
            // Gán asset vào 1 LUẬN CỨ (sentence) cụ thể; giữ paragraph_id của luận điểm cha để vẫn thuộc cảnh.
            const s = await db.get('SELECT paragraph_id FROM Sentence WHERE id = ?', [targetSentenceId]);
            await db.run('UPDATE Asset SET sentence_id = ?, paragraph_id = ?, post_id = NULL, section = NULL, hook_detail_id = NULL, summary_detail_id = NULL, conclusion_detail_id = NULL, paragraph_detail_id = NULL, sentence_detail_id = NULL WHERE id = ?',
                [targetSentenceId, s?.paragraph_id || null, assetId]);
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
app.post('/api/generate-media', async (req, res) => {
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
            const { fetchAndDownloadStock } = await import('./src/workers/sync_assets_db.js').catch(() => ({}));
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

    // Cảnh của dự án SPORT → chỉ lấy lại ẢNH (Bing/Google xoay vòng như pipeline sport).
    // craw_sub.js bên dưới lấy cả video lẫn ảnh từ stock — sai hẳn với keyword bóng đá tiếng Nhật.
    try {
        const db = await getDb();
        const para = await db.get(
            'SELECT p.id, p."order" AS ord, po.genre, po.project_id FROM Paragraph p JOIN Post po ON po.id = p.post_id WHERE p.id = ?',
            [groupId]
        );
        if (para?.genre === 'sport') {
            res.json({ success: true, message: 'Đang lấy lại ảnh (sport)...' });
            crawlSportImages(db, para.project_id, para.id, para.ord, kwTexts)
                .then(n => { console.log(`[generate-media/sport] cảnh ${para.ord}: +${n} ảnh`); pushCrawlScene(para.project_id); })
                .catch(e => console.error('[generate-media/sport]', e.message))
                .finally(() => db.close().catch(() => {}));
            return;
        }
        await db.close();
    } catch (e) { console.error('[generate-media] kiểm tra genre lỗi:', e.message); }

    const pythonProcess = spawn('node', [
        'src/workers/craw_sub.js',
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

        const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
        const lipsDir = path.join(MEDIA_DIR, projectId, 'lips_sync');

        // ===== 1) AUDIO: tải TOÀN BỘ trước (song song + retry) rồi mới đóng zip → tránh tải thiếu/đứt giữa chừng.
        const audioList = await getAllAudioUrls(postId, contentType);
        // Fallback local: file lips_sync/<idx>.mp3 (tải lúc chạy lips) — chỉ dùng khi lips CÙNG ngôn ngữ với bản đang tải.
        let lipsSameType = false;
        try { const lr = await db.get('SELECT content_type FROM LipsSyncJob WHERE post_id = ? LIMIT 1', [postId]); lipsSameType = !!lr && (lr.content_type || 'content') === contentType; } catch (_) {}
        const fetchAudio = async (idx, url) => {
            if (url) { try { return await fetchBunnyAudio(url); } catch (e) { console.warn(`[download-voice] audio ${idx} CDN lỗi (${e.message}) → thử file local`); } }
            if (lipsSameType) { try { const lp = path.join(lipsDir, `${idx}.mp3`); if (fs.existsSync(lp) && fs.statSync(lp).size > 1000) return fs.readFileSync(lp); } catch (_) {} }
            return null;
        };
        const audios = new Array(audioList.length).fill(null);
        const CONC = 6;
        for (let i = 0; i < audioList.length; i += CONC) {
            const chunk = audioList.slice(i, i + CONC);
            const bufs = await Promise.all(chunk.map((a, k) => fetchAudio(i + k + 1, a.audio)));
            for (let k = 0; k < bufs.length; k++) audios[i + k] = bufs[k];
        }
        const missing = [];
        audios.forEach((b, i) => { if (!b) missing.push(i + 1); });

        // ===== 2) MEDIA: gom TẤT CẢ asset đã chọn theo ĐÚNG thứ tự video (hook → summary → luận điểm(+câu) → kết),
        // rồi để trong 1 THƯ MỤC PHẲNG media/ đánh số 001, 002... (không lồng thư mục con) — ném vào CapCut cho dễ.
        const ordered = [];
        const q = (sql, p) => db.all(sql, p);
        const push = (rows) => { for (const r of rows) ordered.push(r); };
        push(await q('SELECT file_path, duration FROM Asset WHERE selected=1 AND post_id=? AND section=\'hook\' ORDER BY "order", id', [postId]));
        push(await q('SELECT file_path, duration FROM Asset WHERE selected=1 AND post_id=? AND section=\'summary\' ORDER BY "order", id', [postId]));
        const paragraphs = await q('SELECT id FROM Paragraph WHERE post_id=? ORDER BY "order", id', [postId]);
        for (const para of paragraphs) {
            push(await q('SELECT file_path, duration FROM Asset WHERE selected=1 AND paragraph_id=? AND sentence_id IS NULL ORDER BY "order", id', [para.id]));
            const sentences = await q('SELECT id FROM Sentence WHERE paragraph_id=? ORDER BY "order", id', [para.id]);
            for (const s of sentences) push(await q('SELECT file_path, duration FROM Asset WHERE selected=1 AND sentence_id=? ORDER BY "order", id', [s.id]));
        }
        push(await q('SELECT file_path, duration FROM Asset WHERE selected=1 AND post_id=? AND section=\'conclusion\' ORDER BY "order", id', [postId]));
        await db.close();

        // ===== 3) Đóng gói & stream
        const zipName = `${videoId}_${lang}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', () => { try { res.destroy(); } catch (_) {} });
        archive.pipe(res);

        let audioOk = 0;
        audios.forEach((buf, i) => { if (buf) { archive.append(buf, { name: `audio/${String(i + 1).padStart(3, '0')}.mp3` }); audioOk++; } });

        let mi = 0;
        for (const a of ordered) {
            const srcPath = path.join(MEDIA_DIR, a.file_path);
            if (!fs.existsSync(srcPath)) continue;
            mi++;
            const ext = path.extname(a.file_path);
            const durSuffix = a.duration ? `_${Math.round(a.duration)}s` : '';
            archive.file(srcPath, { name: `media/${String(mi).padStart(3, '0')}${durSuffix}${ext}` });
        }

        // (Không đưa lips_sync/ vào zip nữa — lips đã có sẵn trong bản export CapCut, khỏi trùng.)

        // Báo cáo: cho biết CHÍNH XÁC có thiếu voice không (không còn bỏ qua âm thầm)
        const report = [
            `Voice: tải được ${audioOk}/${audioList.length} câu.`,
            missing.length ? `⚠️ THIẾU ${missing.length} câu (index): ${missing.join(', ')}` : '✅ Đủ toàn bộ voice.',
            missing.length ? '   → URL audio có thể đã hết hạn. Hãy gen lại voice rồi tải lại (hoặc chạy lips sync để có bản mp3 local dự phòng).' : '',
            `Media: ${mi} file trong thư mục media/ (đánh số theo thứ tự video).`,
        ].filter(Boolean).join('\n');
        archive.append(report, { name: '_bao_cao.txt' });
        console.log(`[download-voice] post ${postId}: voice ${audioOk}/${audioList.length} (thiếu ${missing.length}), media ${mi} file`);

        await archive.finalize();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const BUNNY_BASE_URL = process.env.BUNNYCDN_BASE_URL;
const BUNNY_ACCESS_KEY = process.env.BUNNYCDN_ACCESS_KEY;
const BUNNY_AUDIO_DIR = process.env.BUNNYCDN_AUDIO_DIR || 'sentences';

async function fetchBunnyAudio(audioPath, { retries = 4, timeoutMs = 30000 } = {}) {
    const url = audioPath.startsWith('http') ? audioPath : `${BUNNY_BASE_URL}/${audioPath}`;
    let lastErr;
    // Mạng tới CDN hay chập chờn ("fetch failed") → retry với backoff + timeout mỗi lần.
    for (let attempt = 1; attempt <= retries; attempt++) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        try {
            const res = await fetch(url, { headers: { AccessKey: BUNNY_ACCESS_KEY }, signal: ac.signal });
            if (res.ok) return Buffer.from(await res.arrayBuffer());
            // 4xx (trừ 429) = hỏng hẳn (URL sai/hết hạn) → dừng luôn, không retry
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                throw new Error(`Bunny fetch failed: ${res.status} ${url}`);
            }
            lastErr = new Error(`HTTP ${res.status}`);   // 5xx/429 → retry
        } catch (e) {
            if (/Bunny fetch failed: 4/.test(e.message)) throw e;   // 4xx: không retry
            lastErr = e;   // lỗi mạng / timeout → retry
        } finally { clearTimeout(t); }
        if (attempt < retries) await new Promise(r => setTimeout(r, 500 * attempt));
    }
    throw new Error(`Tải audio thất bại sau ${retries} lần (mạng chập chờn tới CDN): ${lastErr?.message || 'fetch failed'}`);
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
        const { videoId, postId, lang, speakerUuid, contentType, dictionaryUuids, texts, speed } = req.body;
        const projectDir = path.join(MEDIA_DIR, videoId);
        const result = await generateAudios(projectDir, postId, lang, speakerUuid, contentType, dictionaryUuids, texts || null, speed);

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
// SPORT chỉ dùng ẢNH: pipeline sports_srt.js cào Bing/Google theo keyword tiếng Nhật, không hề có video.
// Mọi nút "lấy lại nguồn" của dự án sport đều đi qua đây → cào lại ĐÚNG kiểu đó, không đụng tới _raw_videos
// và không gọi stock (Storyblocks/Pexels/Pixabay) — stock trả về footage vu vơ với keyword bóng đá.
// Sync ảnh vào DB ngay sau MỖI keyword để dashboard hiện dần. Trả về số ảnh mới thêm.
const SPORT_IMAGES_PER_KEYWORD = 8;   // khớp IMAGES_PER_KEYWORD của sports_srt.js
async function crawlSportImages(db, projectId, paragraphId, order, keywords) {
    const { crawlKeywordImageRotate } = await import('./src/crawlers/imageCrawlRotate.js');
    const dir = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', String(order));
    fs.mkdirSync(dir, { recursive: true });
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(0), ms))]);
    let added = 0;
    for (const [i, kw] of keywords.entries()) {
        await withTimeout(
            crawlKeywordImageRotate(kw, dir, i, SPORT_IMAGES_PER_KEYWORD)
                .then(got => console.log(`[sport-media] "${kw}" -> ${got} ảnh`))
                .catch(e => console.error(`[sport-media] lỗi "${kw}": ${e.message}`)),
            60000
        );
        for (const file of fs.readdirSync(dir)) {
            if (!imageExts.has(path.extname(file).toLowerCase())) continue;
            const rel = path.join(projectId, 'assets', '_raw_images', String(order), file);
            const ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
            if (!ex) { await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [paragraphId, 'image', rel]); added++; }
        }
    }
    return added;
}

app.post('/api/crawl-all', async (req, res) => {
    const { postId, force } = req.body;   // force=true → crawl lại HẾT; mặc định chỉ crawl cảnh còn THIẾU (0 asset)
    res.json({ success: true, message: 'Đang crawl...' });
    (async () => {
        const db0 = await getDb();
        const p0 = await db0.get('SELECT id, project_id, genre FROM Post WHERE id = ?', [postId]);
        await db0.close();
        if (!p0) return;

        // Project ĐỊA CHÍNH TRỊ → crawl lại bằng ĐÚNG pipeline của nó (process_content.js --mediaOnly):
        // tin từ RSS gốc/Google News → cào ảnh/video trong bài báo thật → stock (Google/Bing) bổ sung.
        // Luồng stock thuần bên dưới chỉ dành cho project không phải geo.
        if (p0.genre === 'geo') {
            const args = ['src/workers/process_content.js', '--mediaOnly', '--postId', String(postId)];
            if (force) args.push('--force');
            console.log(`[crawl-all] post ${postId} là geo → chạy lại pipeline tin (${force ? 'toàn bộ' : 'bù cảnh thiếu'})`);
            const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', d => process.stdout.write(`[crawl-all/geo] ${d}`));
            child.stderr.on('data', d => process.stderr.write(`[crawl-all/geo] ${d}`));
            child.on('exit', async (code) => {
                console.log(`[crawl-all/geo] post ${postId} xong (code ${code})`);
                // Xong bình thường: process_content đã tự POST /api/crawl-status/notify (status=null) → SSE + Slack.
                // Chỉ cần dọn khi nó chết giữa chừng, kẻo Post kẹt status 'crawling' mãi.
                if (code !== 0) {
                    try { const d = await getDb(); await d.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]); await d.close(); } catch (_) { }
                    pushCrawlStatus(p0.project_id, null);
                }
                orchestrateAutoVoice(p0.project_id.replace(/_[a-z]{2}$/, '')).catch(e => console.error('[crawl-all/geo] auto voice lỗi:', e.message));
            });
            return;
        }

        // Project SPORT → chỉ cào lại ẢNH bằng đúng crawler của pipeline sport.
        // project_id KHÔNG cắt đuôi ngôn ngữ như nhánh dưới: sports_srt.js ghi media vào MEDIA_DIR/<project_id> nguyên vẹn.
        if (p0.genre === 'sport') {
            const db = await getDb();
            await db.run('UPDATE Post SET status = ? WHERE id = ?', ['crawling', postId]);
            pushCrawlStatus(p0.project_id, 'crawling');
            const paragraphs = await db.all('SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY "order"', [postId]);
            for (const para of paragraphs) {
                const kws = await db.all('SELECT content FROM Keyword WHERE paragraph_id = ?', [para.id]);
                if (!kws.length) continue;
                if (!force) { const c = await db.get('SELECT COUNT(*) c FROM Asset WHERE paragraph_id = ?', [para.id]); if (c.c > 0) continue; }   // mặc định chỉ bù cảnh trống
                const n = await crawlSportImages(db, p0.project_id, para.id, para.order, kws.map(k => k.content));
                console.log(`[crawl-all/sport] cảnh ${para.order}: +${n} ảnh`);
                pushCrawlScene(p0.project_id);   // xong 1 cảnh → hiện ngay
            }
            await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
            await db.close();
            console.log(`[crawl-all/sport] ✅ Xong post ${postId}`);
            pushCrawlStatus(p0.project_id, null);
            announceSlack(p0.project_id);
            return;
        }

        const { fetchAndDownloadStock } = await import('./src/workers/sync_assets_db.js').catch(() => ({}));
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
            if (!force) { const c = await db.get('SELECT COUNT(*) c FROM Asset WHERE post_id = ? AND section = ?', [postId, section]); if (c.c > 0) continue; }   // đã có ảnh → bỏ qua
            const vF = path.join(MEDIA_DIR, projectId, 'assets', '_raw_videos', section);
            const iF = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', section);
            [vF, iF].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            for (const { content: kw } of kws) {
                await fetchAndDownloadStock(kw, 'video', vF, 4).catch(() => {});
                await fetchAndDownloadStock(kw, 'image', iF, 8).catch(() => {});
            }
            await syncDir(vF, 'video', (rel, t) => db.run('INSERT INTO Asset (post_id, section, type, file_path) VALUES (?, ?, ?, ?)', [postId, section, t, rel]));
            await syncDir(iF, 'image', (rel, t) => db.run('INSERT INTO Asset (post_id, section, type, file_path) VALUES (?, ?, ?, ?)', [postId, section, t, rel]));
            pushCrawlScene(post.project_id);   // xong 1 section → hiện ngay
        }

        // Paragraphs
        const paragraphs = await db.all('SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY "order"', [postId]);
        for (const para of paragraphs) {
            const gid = String(para.order);
            const kws = await db.all('SELECT content FROM Keyword WHERE paragraph_id = ?', [para.id]);
            if (!kws.length) continue;
            if (!force) { const c = await db.get('SELECT COUNT(*) c FROM Asset WHERE paragraph_id = ?', [para.id]); if (c.c > 0) continue; }   // cảnh đã có ảnh → bỏ qua, chỉ crawl cảnh thiếu
            const vF = path.join(MEDIA_DIR, projectId, 'assets', '_raw_videos', gid);
            const iF = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', gid);
            [vF, iF].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            for (const { content: kw } of kws) {
                await fetchAndDownloadStock(kw, 'video', vF, 4).catch(() => {});
                await fetchAndDownloadStock(kw, 'image', iF, 8).catch(() => {});
            }
            await syncDir(vF, 'video', (rel, t) => db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [para.id, t, rel]));
            await syncDir(iF, 'image', (rel, t) => db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [para.id, t, rel]));
            pushCrawlScene(post.project_id);   // xong 1 đoạn → hiện ngay
        }

        await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
        await db.close();
        console.log(`[crawl-all] ✅ Xong post ${postId}`);
        // Giống pipeline hoàn tất: dashboard SSE + Slack + tự tạo voice (+lips) nếu project có cấu hình
        pushCrawlStatus(post.project_id, null);
        announceSlack(post.project_id);
        orchestrateAutoVoice(projectId).catch(e => console.error('[crawl-all] auto voice lỗi:', e.message));
    })().catch(e => console.error('[crawl-all]', e.message));
});

// Gen voice (+lips) cho 1 post NGAY khi content sẵn sàng — KHÔNG cần chờ crawl ảnh/video xong.
// Pipeline gọi ngay sau khi lưu kịch bản (song song với crawl media). Idempotent (đã có voice thì bỏ qua).
app.post('/api/auto-voice/run', async (req, res) => {
    const { projectId, postId } = req.body || {};
    res.json({ success: true });
    (async () => {
        const pid = String(projectId || '').trim();
        const cfg = pid ? readVoiceAutoConfig(pid) : null;
        if (!cfg || !cfg.enabled) return;                    // project không bật auto voice → thôi
        const db = await getDb();
        const post = postId
            ? await db.get('SELECT id, target_lang FROM Post WHERE id = ?', [postId])
            : await db.get('SELECT id, target_lang FROM Post WHERE project_id = ? OR project_id LIKE ? ORDER BY id DESC LIMIT 1', [pid, `${pid}\_%`]);
        await db.close();
        if (!post) return;
        console.log(`[auto-voice/run] Gen voice sớm cho post ${post.id} (${pid})`);
        await autoGenVoiceForPost(pid, post, cfg);
    })().catch(e => console.error('[auto-voice/run] lỗi:', e.message));
});

// API: Crawl từ nguồn Việt Nam
app.post('/api/crawl-vn', async (req, res) => {
    const { paragraphId, postId, section, keyword, videoId, gid } = req.body;
    if (!keyword?.trim()) return res.status(400).json({ error: 'Thiếu keyword' });
    res.json({ success: true, message: 'Đang crawl nguồn Việt Nam...' });
    (async () => {
        const { fetchFromVnBot } = await import('./src/crawlers/vnCrawler.js');
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
    const { content, keywords, sources, xAccounts, country, targetLang, days,
            voiceAuto, voiceContentType, speakerUuid, dictionaryUuids, lipsAuto, lipsVideo, lipsGuidance, voiceSpeed } = req.body;
    // LUỒNG ĐỊA CHÍNH TRỊ: input là mảng từ khóa + mảng domain nguồn. Vẫn nhận content (chủ đề/tiêu đề) làm tuỳ chọn.
    const kwArr = Array.isArray(keywords) ? keywords.map(s => String(s).trim()).filter(Boolean) : [];
    const srcArr = Array.isArray(sources) ? sources.map(s => String(s).trim()).filter(Boolean) : [];
    // Account X (tuỳ chọn): username thuần, bỏ @ và URL
    const xArr = Array.isArray(xAccounts) ? xAccounts.map(s => String(s).trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?]/)[0]).filter(Boolean) : [];
    const daysNum = parseInt(days, 10);
    const newsDays = Number.isFinite(daysNum) && daysNum > 0 ? daysNum : 1;   // cửa sổ tin (when:Nd)
    if (!kwArr.length && !content?.trim()) return res.status(400).json({ error: 'Thiếu từ khóa (keywords) hoặc nội dung' });
    try {
        const projectId = stampId('proj_');
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'original_content.txt'), (content?.trim()) || kwArr.join('\n'));
        // Auto voice: lưu cấu hình để orchestrator tự chạy sau khi crawl xong
        if (voiceAuto && speakerUuid) {
            const genreForLips = 'geo';
            writeVoiceAutoConfig(projectId, {
                speakerUuid,
                contentType: voiceContentType,
                dictionaryUuids,
                lips: lipsAuto && resolveLipsVideo(lipsVideo, genreForLips) ? { video: resolveLipsVideo(lipsVideo, genreForLips), guidanceScale: lipsGuidance } : null,
                speed: voiceSpeed,
            });
        }
        const cGl = (country && country.gl) || '';
        const cHl = (country && country.hl) || '';
        const procArgs = [
            'src/workers/process_content.js',
            '--projectId', projectId,
            '--keywords', JSON.stringify(kwArr),
            '--sources', JSON.stringify(srcArr),
            '--country', cGl,
            '--clang', cHl,
            '--targetLang', targetLang || 'en',
            '--days', String(newsDays)
        ];
        if (content?.trim()) { procArgs.push('--content', content.trim()); }
        if (xArr.length) { procArgs.push('--xAccounts', JSON.stringify(xArr)); }
        const crawlProcess = spawn('node', procArgs, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        crawlProcess.stdout.on('data', d => process.stdout.write(`[process_content] ${d}`));
        crawlProcess.stderr.on('data', d => process.stderr.write(`[process_content] ${d}`));
        // Sau khi crawl xong (thành công) → tự tạo voice (+lips) nếu project bật auto voice
        crawlProcess.on('exit', (code) => {
            if (code !== 0) { if (voiceAuto) console.warn(`[auto-voice] Pipeline lỗi (code ${code}), bỏ qua auto voice cho ${projectId}`); return; }
            orchestrateAutoVoice(projectId).catch(e => console.error('[auto-voice] Orchestrate lỗi:', e.message));
        });
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

// API: log MỌI bài X đã "lướt qua" khi crawl (theo cảnh) — kèm link, để xem trong modal "Log X".
app.get('/api/x-browse-log/:projectId', (req, res) => {
    const safe = String(req.params.projectId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
    const file = path.join(__dirname, 'logs', safe, 'x_browse.json');
    if (!fs.existsSync(file)) return res.json({ updatedAt: '', entries: [] });
    try { res.json(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { res.json({ updatedAt: '', entries: [] }); }
});

// API: Xóa toàn bộ project
app.post('/api/delete-project', async (req, res) => {
    const { videoId } = req.body;
    try {
        const db = await getDb();
        // Xóa tất cả posts có title là videoId hoặc bắt đầu bằng videoId_
        const posts = await db.all('SELECT id FROM Post WHERE project_id = ? OR project_id LIKE ?', [videoId, `${videoId}\_%`]);
        // HUỶ + XOÁ job lips của các post này TRƯỚC khi xoá Post → không còn chạy ngầm cho dự án đã xoá,
        // và không để lại row LipsSyncJob mồ côi (post_id trỏ vào Post không còn tồn tại).
        const postIds = posts.map(p => p.id);
        if (postIds.length) {
            try {
                const ph = postIds.map(() => '?').join(',');
                const jrows = await db.all(
                    `SELECT job_id FROM LipsSyncJob WHERE post_id IN (${ph}) AND job_id IS NOT NULL AND status NOT IN ('done','error','cancelled')`,
                    postIds);
                const jobIds = jrows.map(r => r.job_id).filter(Boolean);
                if (jobIds.length) {
                    await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs/cancel`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ job_ids: jobIds }),
                    }).catch(() => {});   // worker có thể chưa chạy → bỏ qua, vẫn xoá DB bên dưới
                }
                await db.run(`DELETE FROM LipsSyncJob WHERE post_id IN (${ph})`, postIds);
            } catch (e) { console.warn('[delete-project] dọn job lips lỗi:', e.message); }
        }
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
        // Xoá luôn cache tin đã dùng (NewsSeen) của dự án này → xoá xong thì các dự án sau
        // ĐƯỢC PHÉP xào lại tin về chủ đề đó. (Dedup "vấn đề" theo Post/Paragraph tự hết khi Post bị xoá.)
        const seenDel = await db.run('DELETE FROM NewsSeen WHERE project_id = ? OR project_id LIKE ?', [videoId, `${videoId}\_%`]).catch(() => null);
        await db.close();
        const folder = path.join(MEDIA_DIR, videoId);
        if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
        // Dọn thư mục log riêng của dự án (logs/<projectId>/ — chứa cả x_browse.json).
        const safeLog = String(videoId || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
        const logFolder = path.join(__dirname, 'logs', safeLog);
        if (safeLog && fs.existsSync(logFolder)) fs.rmSync(logFolder, { recursive: true, force: true });
        res.json({ success: true, newsSeenDeleted: seenDel?.changes || 0 });
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
    // Log MỌI lệnh xóa: khi người dùng báo "bấm xóa không ăn", đây là chỗ duy nhất phân biệt được
    // request có tới server hay không, và xóa mất bao lâu (server 1 luồng, đang crawl thì rất chậm).
    const t0 = Date.now();
    console.log(`[delete-content] nhận: type=${type} id=${id}`);
    const allowed = ['paragraph', 'paragraph_detail', 'sentence', 'sentence_detail',
        'hook_detail', 'summary_detail', 'conclusion_detail', 'hook', 'summary', 'conclusion'];
    if (!allowed.includes(type) || !id) {
        console.warn(`[delete-content] ✗ type/id không hợp lệ: type=${type} id=${id}`);
        return res.status(400).json({ error: 'type/id không hợp lệ' });
    }
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
        console.log(`[delete-content] ✅ xong ${type} #${id} (${filePaths.length} file media, ${Date.now() - t0}ms)`);
        res.json({ ok: true });
    } catch (e) {
        try { if (db) await db.close(); } catch (_) {}
        console.error(`[delete-content] ❌ LỖI ${type} #${id} sau ${Date.now() - t0}ms:`, e.message);
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
                duration = await ffprobeDuration(path.join(MEDIA_DIR, relativePath)) || null;
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
// Tạo project từ 2 file SRT (gốc + đích). genre='drama' → cào X + lưu đúng thể loại
// (đây là đầu vào DUY NHẤT của drama trên UI: 2 file SRT thay cho ô "thông tin vụ việc" cũ).
app.post('/api/create-naze-srt', upload.fields([{ name: 'srt', maxCount: 1 }, { name: 'srtTarget', maxCount: 1 }]), async (req, res) => {
    const { projectId, targetLang, genre, tweetUrls,
        voiceAuto, voiceContentType, speakerUuid, dictionaryUuids, lipsAuto, lipsVideo, lipsGuidance, voiceSpeed } = req.body;
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
        // multipart → mọi field là chuỗi; dictionaryUuids gửi dạng JSON
        const isYes = (v) => v === true || v === 'true' || v === '1' || v === 'on';
        let dicts = [];
        try { dicts = dictionaryUuids ? JSON.parse(dictionaryUuids) : []; } catch { dicts = []; }
        if (isYes(voiceAuto) && speakerUuid) {
            writeVoiceAutoConfig(projectId, {
                speakerUuid, contentType: voiceContentType || 'content', dictionaryUuids: dicts,
                lips: isYes(lipsAuto) && resolveLipsVideo(lipsVideo, genreForLips) ? { video: resolveLipsVideo(lipsVideo, genreForLips), guidanceScale: parseFloat(lipsGuidance) || 2.2 } : null,
                speed: voiceSpeed,
            });
        }
        const args = ['src/workers/naze_content.js', '--srt', srtPath, projectId];
        if (srtTargetPath) args.push(srtTargetPath);
        if (targetLang) args.push(targetLang);
        if (genre === 'drama') args.push('--genre', 'drama');
        const env = { ...process.env };
        if (genre === 'drama' && tweetUrls && tweetUrls.trim()) env.NAZE_TWEET_URLS = tweetUrls.trim();
        const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'], env });
        child.stdout.on('data', d => process.stdout.write(`[naze] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[naze] ${d}`));
        child.on('exit', (code) => {
            if (code !== 0) return console.warn(`[naze-srt] pipeline lỗi (code ${code}) — bỏ qua auto voice ${projectId}`);
            orchestrateAutoVoice(projectId).catch(e => console.error('[naze-srt] auto voice lỗi:', e.message));
        });
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
            enqueueNazeJob({ projectId, args: ['src/workers/naze_content.js', '--srt', srcPath, projectId, tgtPath, targetLang] });
            projects.push(projectId);
        }
        res.json({ success: true, count: projects.length, projects });
    } catch (e) { cleanup(); res.status(500).json({ error: e.message }); }
});

app.post('/api/create-naze-youtube', express.json(), async (req, res) => {
    const { url, projectId, targetLang, voiceAuto, voiceContentType, speakerUuid, dictionaryUuids, lipsAuto, lipsVideo, lipsGuidance, voiceSpeed } = req.body;
    if (!url?.trim() || !projectId?.trim()) return res.status(400).json({ error: 'Thiếu URL hoặc projectId' });
    try {
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        if (voiceAuto && speakerUuid) {
            const genreForLips = 'naze';   // luồng YouTube luôn là naze
            writeVoiceAutoConfig(projectId, { speakerUuid, contentType: voiceContentType, dictionaryUuids,
                lips: lipsAuto && resolveLipsVideo(lipsVideo, genreForLips) ? { video: resolveLipsVideo(lipsVideo, genreForLips), guidanceScale: lipsGuidance } : null, speed: voiceSpeed });
        }
        const args = ['src/workers/naze_content.js', '--youtube', url.trim(), projectId];
        if (targetLang) args.push(targetLang);
        const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => process.stdout.write(`[naze] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[naze] ${d}`));
        child.on('exit', (code) => {
            if (code !== 0) { if (voiceAuto) console.warn(`[auto-voice] naze pipeline lỗi (code ${code}), bỏ qua ${projectId}`); return; }
            orchestrateAutoVoice(projectId).catch(e => console.error('[auto-voice] Orchestrate lỗi:', e.message));
        });
        child.unref();
        res.json({ success: true, projectId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/create-naze', express.json(), async (req, res) => {
    const { topic, projectId, targetLang, genre, tweetUrls, voiceAuto, voiceContentType, speakerUuid, dictionaryUuids, lipsAuto, lipsVideo, lipsGuidance, voiceSpeed } = req.body;
    if (!topic?.trim() || !projectId?.trim()) return res.status(400).json({ error: 'Thiếu topic hoặc projectId' });
    try {
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        if (voiceAuto && speakerUuid) {
            const genreForLips = (genre === 'drama' ? 'drama' : 'naze');
            writeVoiceAutoConfig(projectId, { speakerUuid, contentType: voiceContentType, dictionaryUuids,
                lips: lipsAuto && resolveLipsVideo(lipsVideo, genreForLips) ? { video: resolveLipsVideo(lipsVideo, genreForLips), guidanceScale: lipsGuidance } : null, speed: voiceSpeed });
        }
        const args = ['src/workers/naze_content.js', topic.trim(), projectId, targetLang || 'vi', genre === 'drama' ? 'drama' : 'naze'];
        const env = { ...process.env };
        // Chỉ drama mới cào X; truyền link tweet dán tay (nếu có) qua env
        if (genre === 'drama' && tweetUrls && tweetUrls.trim()) env.NAZE_TWEET_URLS = tweetUrls.trim();
        const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'], env });
        child.stdout.on('data', d => process.stdout.write(`[naze] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[naze] ${d}`));
        child.on('exit', (code) => {
            if (code !== 0) { if (voiceAuto) console.warn(`[auto-voice] naze pipeline lỗi (code ${code}), bỏ qua ${projectId}`); return; }
            orchestrateAutoVoice(projectId).catch(e => console.error('[auto-voice] Orchestrate lỗi:', e.message));
        });
        child.unref();
        res.json({ success: true, projectId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== SPORT (port từ nhánh main_sports, luồng chạy độc lập với naze/drama/geo) =====
// Pipeline riêng: src/workers/sports_srt.js — 2 chế độ (upload SRT | nhập prompt cho GPT-5 tự viết bài),
// tự sinh keyword tiếng Nhật rồi cào ảnh Bing/Google. Post được đánh genre='sport'.
const runningSportsJobs = new Map(); // projectId -> child process

function spawnSportsJob(args, logPrefix, projectId, res) {
    if (runningSportsJobs.has(projectId)) {
        return res.status(409).json({ error: `Project "${projectId}" đang chạy, vui lòng chờ` });
    }
    const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    runningSportsJobs.set(projectId, child);
    child.stdout.on('data', d => process.stdout.write(`[${logPrefix}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[${logPrefix}] ${d}`));
    child.on('close', () => runningSportsJobs.delete(projectId));
    child.unref();
    res.json({ success: true, projectId });
}

// Tạo dự án Sport từ prompt: GPT-5 (web_search) tự viết bài phân tích.
// minutes: độ dài video mong muốn. <12' -> 1 lượt gọi như cũ; >=12' -> worker chuyển sang
// luồng BÀI DÀI (lên dàn ý rồi viết nối tiếp từng phần) vì 1 lượt không đủ context.
app.post('/api/create-sports-prompt', express.json(), async (req, res) => {
    const { projectId, prompt, targetLang, minutes } = req.body;
    if (!prompt?.trim() || !projectId?.trim()) return res.status(400).json({ error: 'Thiếu prompt hoặc projectId' });
    try {
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const args = ['src/workers/sports_srt.js', '--prompt', projectId, prompt.trim()];
        if (targetLang) args.push(targetLang);
        // Cờ luôn nằm CUỐI: worker đọc targetLang theo vị trí args[3], và nhánh dọn lỗi tra projectId ở argv[3].
        const mins = parseInt(minutes, 10);
        if (Number.isFinite(mins) && mins > 0) args.push('--minutes', String(Math.min(60, mins)));
        spawnSportsJob(args, 'sports_prompt', projectId, res);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tạo dự án Sport từ file SRT (gốc bắt buộc, bản dịch tuỳ chọn)
app.post('/api/create-sports', upload.fields([{ name: 'srt', maxCount: 1 }, { name: 'srtTranslated', maxCount: 1 }]), async (req, res) => {
    const { projectId, targetLang, translate } = req.body;
    const srtFile = req.files?.srt?.[0];
    const srtTranslatedFile = req.files?.srtTranslated?.[0];
    if (!srtFile || !projectId?.trim()) return res.status(400).json({ error: 'Thiếu file SRT hoặc projectId' });
    try {
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const srtPath = path.join(targetDir, 'input.srt');
        fs.renameSync(srtFile.path, srtPath);
        let srtTranslatedPath = '';
        if (srtTranslatedFile) {
            srtTranslatedPath = path.join(targetDir, 'input_translated.srt');
            fs.renameSync(srtTranslatedFile.path, srtTranslatedPath);
        }
        // sports_srt.js đọc tham số THEO VỊ TRÍ: [srt, projectId, srtĐãDịch, targetLang].
        // Không có bản dịch vẫn phải giữ chỗ args[2] bằng '' (worker coi '' là null),
        // nếu bỏ trống thì targetLang tụt xuống ô srtĐãDịch → parseSrt('vi') → ENOENT.
        const args = ['src/workers/sports_srt.js', srtPath, projectId, srtTranslatedPath, targetLang || 'vi'];
        // Cờ ở CUỐI (worker tách cờ trước khi đọc tham số vị trí). Có file dịch sẵn thì bỏ qua cờ:
        // worker vẫn tôn trọng file người dùng đưa, nhưng đừng gửi cờ thừa cho khỏi hiểu nhầm khi đọc log.
        const wantTranslate = translate === true || translate === 'true' || translate === '1' || translate === 'on';
        if (wantTranslate && !srtTranslatedPath) args.push('--translate');
        spawnSportsJob(args, 'sports_srt', projectId, res);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cào bù: các câu chưa có keyword nào (GPT lỗi/timeout lúc chạy pipeline)
app.post('/api/sports-retry', express.json(), async (req, res) => {
    const { postId } = req.body;
    try {
        const db = await getDb();
        const post = await db.get('SELECT project_id FROM Post WHERE id = ?', [postId]);
        await db.close();
        if (!post) return res.status(404).json({ error: 'Post not found' });
        const child = spawn('node', ['src/workers/sports_retry.js', String(postId), post.project_id], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => process.stdout.write('[sports_retry] ' + d));
        child.stderr.on('data', d => process.stderr.write('[sports_retry] ' + d));
        child.unref();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== PODCAST: dự án CHỈ CÓ TIẾNG, đầu vào là file .srt =====
// Pipeline riêng src/workers/podcast_srt.js: mỗi cue SRT = 1 cảnh (1 câu đọc), KHÔNG cào ảnh/video.
// Tuỳ chọn tự tạo voice sau khi import (dùng chung voice_auto.json + orchestrateAutoVoice như naze/geo).
// Mốc thời gian gốc lưu ở <project>/srt_timing.json -> xuất lại .srt qua /api/srt-timing/:postId.
app.post('/api/create-podcast', upload.fields([{ name: 'srt', maxCount: 1 }, { name: 'srtTarget', maxCount: 1 }]), async (req, res) => {
    const { projectId, targetLang, title,
        voiceAuto, voiceContentType, speakerUuid, dictionaryUuids, voiceSpeed } = req.body;
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
        // multipart -> mọi field là chuỗi; dictionaryUuids gửi dạng JSON
        const isYes = (v) => v === true || v === 'true' || v === '1' || v === 'on';
        let dicts = [];
        try { dicts = dictionaryUuids ? JSON.parse(dictionaryUuids) : []; } catch { dicts = []; }
        const wantVoice = isYes(voiceAuto) && speakerUuid;
        if (wantVoice) {
            // Podcast không có hình -> không lips sync, chỉ giọng đọc.
            writeVoiceAutoConfig(projectId, {
                speakerUuid, contentType: voiceContentType || 'content', dictionaryUuids: dicts,
                lips: null, speed: voiceSpeed,
            });
        }
        // podcast_srt.js đọc tham số THEO VỊ TRÍ: [srt, projectId, srtĐích, targetLang]; --title đứng cuối.
        // Không có bản dịch vẫn phải giữ chỗ args[2] bằng '' kẻo targetLang tụt xuống ô đó -> parseSrt('vi') -> ENOENT.
        const args = ['src/workers/podcast_srt.js', srtPath, projectId, srtTargetPath, targetLang || 'vi'];
        const cleanTitle = (title || '').trim();
        if (cleanTitle) args.push('--title', cleanTitle);
        const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => process.stdout.write(`[podcast] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[podcast] ${d}`));
        child.on('exit', (code) => {
            if (code !== 0) return console.warn(`[podcast] import lỗi (code ${code}) — bỏ qua auto voice ${projectId}`);
            if (wantVoice) orchestrateAutoVoice(projectId).catch(e => console.error('[podcast] auto voice lỗi:', e.message));
        });
        child.unref();
        res.json({ success: true, projectId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== KHO VIDEO PODCAST =====
// Thư mục PHẲNG dùng chung mọi dự án podcast (podcast chỉ có tiếng nên không tự cào được hình,
// hình phải do người dùng bỏ vào kho này rồi chọn). Đặt TRONG MEDIA_DIR để dùng luôn hai endpoint
// sẵn có: /api/media?path= (xem, có proxy 480p) và /api/thumb?path= (ảnh đại diện) — khỏi viết mới.
const PODCAST_VIDEO_DIRNAME = '_podcast_videos';
const PODCAST_VIDEO_DIR = path.join(MEDIA_DIR, PODCAST_VIDEO_DIRNAME);
const PODCAST_VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
// ffprobe mỗi lần liệt kê thì kho vài chục file là treo cả giây; nhớ theo (tên|size|mtime)
// nên file bị thay bằng bản khác vẫn đo lại đúng.
const podcastDurCache = new Map();

async function podcastVideoDuration(name, size, mtime) {
    const key = `${name}|${size}|${mtime}`;
    if (podcastDurCache.has(key)) return podcastDurCache.get(key);
    const d = await ffprobeDuration(path.join(PODCAST_VIDEO_DIR, name)).catch(() => 0);
    const val = Number.isFinite(d) && d > 0 ? d : 0;
    podcastDurCache.set(key, val);
    return val;
}

app.get('/api/podcast-videos', async (req, res) => {
    try {
        fs.mkdirSync(PODCAST_VIDEO_DIR, { recursive: true });
        const items = [];
        for (const e of fs.readdirSync(PODCAST_VIDEO_DIR, { withFileTypes: true })) {
            if (!e.isFile() || !PODCAST_VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) continue;
            let size = 0, mtime = 0;
            try { const st = fs.statSync(path.join(PODCAST_VIDEO_DIR, e.name)); size = st.size; mtime = st.mtimeMs; } catch { continue; }
            items.push({ name: e.name, size, mtime, relativePath: `${PODCAST_VIDEO_DIRNAME}/${e.name}`, duration: await podcastVideoDuration(e.name, size, mtime) });
        }
        items.sort((a, b) => b.mtime - a.mtime);   // mới nhất lên đầu
        res.json({ dir: PODCAST_VIDEO_DIR, items });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/podcast-videos/upload', upload.array('files', 100), (req, res) => {
    try {
        if (!req.files?.length) return res.status(400).json({ error: 'Không có file nào' });
        fs.mkdirSync(PODCAST_VIDEO_DIR, { recursive: true });
        const saved = [], skipped = [];
        for (const file of req.files) {
            const name = safeMediaName(file.originalname);
            const ext = name ? path.extname(name).toLowerCase() : '';
            if (!name || !PODCAST_VIDEO_EXTS.has(ext)) {
                skipped.push(file.originalname);
                try { fs.unlinkSync(file.path); } catch {}
                continue;
            }
            // Trùng tên thì thêm hậu tố thay vì ghi đè — người khác có thể đang dùng file cũ.
            let dest = path.join(PODCAST_VIDEO_DIR, name);
            if (fs.existsSync(dest)) {
                const stem = name.slice(0, name.length - ext.length);
                let i = 1;
                do { dest = path.join(PODCAST_VIDEO_DIR, `${stem}_${i}${ext}`); i++; } while (fs.existsSync(dest));
            }
            // rename hỏng khi _tmp_uploads khác phân vùng với MEDIA_DIR -> chép rồi xoá.
            try { fs.renameSync(file.path, dest); }
            catch { fs.copyFileSync(file.path, dest); try { fs.unlinkSync(file.path); } catch {} }
            saved.push(path.basename(dest));
        }
        res.json({ success: true, saved, skipped });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/podcast-videos', (req, res) => {
    try {
        const name = safeMediaName(req.query.name);
        if (!name || !PODCAST_VIDEO_EXTS.has(path.extname(name).toLowerCase())) return res.status(400).json({ error: 'Tên file không hợp lệ' });
        const target = path.join(PODCAST_VIDEO_DIR, name);
        // Chặn path traversal lần nữa: phải nằm ĐÚNG trong thư mục kho.
        if (path.dirname(path.resolve(target)) !== path.resolve(PODCAST_VIDEO_DIR)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
        if (!fs.existsSync(target)) return res.status(404).json({ error: 'File không tồn tại' });
        fs.unlinkSync(target);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mốc thời gian của file SRT ĐẦU VÀO (dự án podcast), quy về từng ParagraphDetail để client
// xuất lại .srt đúng timeline gốc — dùng được cả khi dự án chưa/không tạo voice.
// srt_timing.json v2 lưu theo cặp (scene = Paragraph."order", line = ParagraphDetail."order")
// nên tra ra ĐÚNG mốc của từng câu. Câu do người dùng tách thêm sau này (không khớp cặp nào)
// thì chia đều khoảng thời gian của cả cảnh — chấp nhận xê xích, còn hơn mất cue.
// v1 (1 cue = 1 cảnh) vẫn đọc được: coi như cảnh chỉ có 1 mốc, chia đều cho các câu trong cảnh.
app.get('/api/srt-timing/:postId', async (req, res) => {
    let db;
    try {
        db = await getDb();
        const post = await db.get('SELECT id, project_id FROM Post WHERE id = ?', [req.params.postId]);
        if (!post) { await db.close(); return res.status(404).json({ error: 'Post not found' }); }
        const file = path.join(MEDIA_DIR, post.project_id, 'srt_timing.json');
        if (!fs.existsSync(file)) { await db.close(); return res.json({ items: [] }); }
        const exact = new Map();      // "cảnh:câu" -> mốc chính xác
        const sceneSpan = new Map();  // cảnh -> [đầu, cuối] (để chia đều cho câu không khớp)
        for (const c of (JSON.parse(fs.readFileSync(file, 'utf8')).cues || [])) {
            const scene = Number(c.scene ?? c.order);   // v1 dùng 'order'
            const start = Number(c.start), end = Number(c.end);
            if (c.line != null) exact.set(`${scene}:${Number(c.line)}`, { start, end });
            const cur = sceneSpan.get(scene);
            sceneSpan.set(scene, cur ? [Math.min(cur[0], start), Math.max(cur[1], end)] : [start, end]);
        }
        const paras = await db.all('SELECT id, "order" FROM Paragraph WHERE post_id = ? ORDER BY id', [post.id]);
        const items = [];
        for (const p of paras) {
            const scene = Number(p.order);
            const span = sceneSpan.get(scene);
            if (!span) continue;
            const details = await db.all('SELECT id, "order" FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"', [p.id]);
            const step = Math.max(0, span[1] - span[0]) / (details.length || 1);
            details.forEach((d, i) => {
                const hit = exact.get(`${scene}:${Number(d.order)}`);
                items.push(hit ? { detailId: d.id, ...hit }
                               : { detailId: d.id, start: span[0] + step * i, end: span[0] + step * (i + 1) });
            });
        }
        await db.close(); db = null;
        res.json({ items });
    } catch (e) {
        if (db) await db.close().catch(() => {});
        res.status(500).json({ error: e.message });
    }
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
        const post0 = await db.get('SELECT project_id, target_lang, genre FROM Post WHERE id = ?', [postId]);
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
        // genre quyết định BỘ FILE prompt SEO (sport -> Nhiemvu_bongda/tieudemau_bongda).
        const seoGenre = post0?.genre || null;
        console.log(`[Title SEO] postId=${postId} lang=${lang} genre=${seoGenre || '-'} (target_lang=${post0?.target_lang || '-'})`);

        const result = await generateSeoTitle(script, lang, seoGenre); // { target, vi }
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
        // Trả về asset vừa tạo (đúng shape UI dùng) để frontend APPEND vào cảnh, KHỎI phải full reload post.
        const created = [];
        for (const file of req.files) {
            const ext = path.extname(file.originalname);
            const fileName = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
            const destPath = path.join(targetDir, fileName);
            fs.renameSync(file.path, destPath);

            const relativePath = path.relative(MEDIA_DIR, destPath);
            let assetId = null;
            if (section) {
                // Upload cho section (hook/summary/conclusion)
                const post = await db.get('SELECT id FROM Post WHERE project_id LIKE ?', [`%${videoId}%`]);
                if (post) {
                    const r = await db.run(
                        'INSERT INTO Asset (post_id, section, type, file_path) VALUES (?, ?, ?, ?)',
                        [post.id, section, type, relativePath]
                    );
                    assetId = r.lastID;
                }
            } else {
                // Upload cho paragraph
                const r = await db.run(
                    'INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)',
                    [paragraphId, type, relativePath]
                );
                assetId = r.lastID;
            }
            if (assetId) {
                created.push({
                    id: assetId, type, name: path.basename(destPath), url: `/${relativePath}`,
                    relativePath, selected: false, order: 0, duration: 0, sentenceId: null,
                });
                // Video: tạo sẵn proxy 480p nền ngay sau upload → lúc mở Edit là có liền, khỏi chờ encode.
                if (type === 'video' && needsProxy(MEDIA_DIR, relativePath)) ensureProxy(MEDIA_DIR, relativePath).catch(() => {});
            }
        }
        await db.close();
        res.json({ success: true, count: req.files.length, assets: created });
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


// ---- THƯ VIỆN VIDEO KHUÔN MẶT (LIPS SYNC) THEO THỨ × THỂ LOẠI ----
app.get('/api/lips-lib', (req, res) => {
    try {
        res.json({ today: lipsWeekday(), genre: normLipsGenre(req.query.genre),
                   genres: LIPS_GENRES, genreLabels: LIPS_GENRE_LABELS, items: listLipsLib(req.query.genre) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/lips-lib/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Thiếu file' });
        const abs = saveLipsLibFile(req.body.weekday, req.file.path, req.file.originalname, normLipsGenre(req.body.genre));
        res.json({ success: true, weekday: Number(req.body.weekday), genre: normLipsGenre(req.body.genre), path: abs });
    } catch (e) {
        try { if (req.file) fs.unlinkSync(req.file.path); } catch (_) {}
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/lips-lib/remove', (req, res) => {
    try { removeLipsLibFile(req.body.weekday, normLipsGenre(req.body.genre)); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
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
    const isImage = IMAGE_EXTS.has(ext.toLowerCase());
    try {
        // ẢNH và VIDEO phải encode KHÁC NHAU. Trước đây dùng chung nhánh video (h264_nvenc) cho cả ảnh:
        // ffmpeg vẫn EXIT 0 nhưng nhét luồng H.264 vào file .jpg → rename đè lên ảnh gốc → ảnh hỏng, mất luôn bản gốc.
        let args;
        if (isImage) {
            // Để ffmpeg tự chọn encoder theo đuôi file (mjpeg/png/webp). -update 1 -frames:v 1 = ghi ĐÚNG
            // 1 ảnh tĩnh (không có cờ này ffmpeg coi đường dẫn là mẫu image-sequence). Không có -c:a: ảnh không có tiếng.
            const q = /^\.(jpg|jpeg|webp)$/i.test(ext) ? ['-q:v', '2'] : [];
            args = ['-i', fullPath, '-vf', `crop=${width}:${height}:${x}:${y}`, '-frames:v', '1', '-update', '1', ...q, '-y', outPath];
        } else {
            // Crop video bắt buộc re-encode → dùng NVENC cho nhanh (libx264 mặc định mất vài giây/clip 1080p)
            const vcodec = hasNvenc
                ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '8M']
                : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
            args = ['-i', fullPath, '-vf', `crop=${width}:${height}:${x}:${y}`, ...vcodec, '-c:a', 'copy', '-y', outPath];
        }
        await runFfmpeg(args);

        // CHỐT AN TOÀN trước khi đè lên bản gốc: exit code 0 của ffmpeg KHÔNG đủ để kết luận file ra dùng được
        // (đúng ca hỏng ở trên: exit 0 nhưng ra H.264 trong .jpg). Sai kiểu thì giữ nguyên bản gốc và báo lỗi.
        const outCodec = await ffprobeVideoCodec(outPath);
        const okSize = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
        const okKind = isImage ? STILL_IMAGE_CODECS.has(outCodec) : !!outCodec && !STILL_IMAGE_CODECS.has(outCodec);
        if (!okSize || !okKind) {
            try { fs.unlinkSync(outPath); } catch {}
            throw new Error(`Crop ra file không hợp lệ (codec='${outCodec || 'không đọc được'}') → giữ nguyên file gốc.`);
        }
        // Ghi đè lên file gốc
        fs.renameSync(outPath, fullPath);
        const db = await getDb();
        await db.run('UPDATE Asset SET duration = ? WHERE file_path = ?', [duration || null, relativePath]);
        await db.close();
        res.json({ success: true, newRelativePath: relativePath });
    } catch (e) {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
        res.status(500).json({ error: e.message });
    }
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
        // Lấy totalDur TRƯỚC khi xóa file gốc
        const totalDur = await ffprobeDuration(fullPath);
        const dur = end - start;
        // RE-ENCODE để cắt CHÍNH XÁC từng frame. Nếu dùng -c copy thì cắt theo KEYFRAME → cắt vài giây đầu
        // bị "nhảy" về keyframe trước đó (vd cắt 2s nhưng vẫn ra gần đủ 23s). NVENC cho nhanh, fallback libx264.
        // -ss trước -i = seek nhanh; -t sau -i = độ dài output chính xác. +faststart: moov ở đầu → browser đọc duration ngay.
        const vcodec = hasNvenc
            ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '8M']
            : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
        await runFfmpeg(['-ss', String(start), '-i', fullPath, '-t', String(dur), ...vcodec, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', trimmedPath]);

        const db = await getDb();
        // Lấy ĐỦ mọi cột "chủ sở hữu" — bỏ sót cột nào thì mảnh cắt rơi khỏi chỗ đứng cũ, thành asset mồ côi.
        const OWNER_COLS = ['post_id', 'section', 'paragraph_id', 'sentence_id'];
        const orig = await db.get(`SELECT id, ${OWNER_COLS.join(', ')}, type, selected, "order" FROM Asset WHERE file_path = ?`, [relativePath]);
        if (orig) {
            // Insert 1 mảnh cắt, giữ nguyên chỗ đứng (section / luận điểm / câu) của file gốc.
            const insertPiece = (owner, filePath, selected, order, dur) => db.run(
                `INSERT INTO Asset (${OWNER_COLS.join(', ')}, type, selected, "order", duration, source_id, file_path)
                 VALUES (${OWNER_COLS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?)`,
                [...OWNER_COLS.map(c => owner[c] ?? null), orig.type, selected, order, dur || null, orig.id, filePath]
            );
            // Xóa file gốc khỏi DB
            await db.run('DELETE FROM Asset WHERE id = ?', [orig.id]);
            // File trim chính - kế thừa selected/order + chỗ đứng của file gốc
            await insertPiece(orig, trimmedRelative, orig.selected, orig.order, duration);

            // Phần thừa (trước/sau): cùng chỗ với file gốc nhưng CHƯA CHỌN → rơi xuống pool bên dưới,
            // không nằm lại ô đã chọn. Asset gắn thẳng vào 1 câu thì đẩy lên cấp luận điểm cho dễ dùng lại.
            const leftoverOwner = { ...orig };
            if (!leftoverOwner.paragraph_id && leftoverOwner.sentence_id) {
                leftoverOwner.paragraph_id = await db.get('SELECT paragraph_id FROM Sentence WHERE id = ?', [leftoverOwner.sentence_id]).then(r => r?.paragraph_id || null);
            }
            if (leftoverOwner.paragraph_id) leftoverOwner.sentence_id = null;

            // Phần trước [0, start]
            if (start > 0.5) {
                const beforePath = `${base}_trim_before_${ts}${ext}`;
                const beforeRelative = path.relative(MEDIA_DIR, beforePath);
                try {
                    await runFfmpeg(['-ss', '0', '-t', String(start), '-i', fullPath, '-c', 'copy', '-movflags', '+faststart', '-y', beforePath]);
                    await insertPiece(leftoverOwner, beforeRelative, 0, 0, Math.round(start * 10) / 10);
                } catch(e) { console.error('[trim before error]', e.message); }
            }
            // Phần sau [end, total]
            console.log('[trim debug] start:', start, 'end:', end, 'totalDur:', totalDur, 'duration param:', duration);
            if (totalDur && (totalDur - end) > 0.5) {
                const afterPath = `${base}_trim_after_${ts}${ext}`;
                const afterRelative = path.relative(MEDIA_DIR, afterPath);
                console.log('[trim] totalDur:', totalDur, 'end:', end, 'after duration:', totalDur - end, 'afterPath:', afterPath);
                try {
                    await runFfmpeg(['-ss', String(end), '-i', fullPath, '-c', 'copy', '-movflags', '+faststart', '-y', afterPath]);
                    await insertPiece(leftoverOwner, afterRelative, 0, 0, Math.round((totalDur - end) * 10) / 10);
                } catch(e) { console.error('[trim after error]', e.message); }
            } else {
                console.log('[trim] skip after: totalDur=', totalDur, 'end=', end);
            }
        }
        await db.close();
        res.json({ success: true, newRelativePath: trimmedRelative });
        // File vừa cắt xong: encode proxy nền để bấm xem lại là có ngay
        warmProxies(MEDIA_DIR, [trimmedRelative], `trim:${ts}`);
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
        const args = ['src/services/browser.js', profileDirName];
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
        const args = ['src/services/browser.js', profileDirName, '--open', (url && url.trim()) || 'https://x.com'];
        const child = spawn('node', args, { detached: false, stdio: 'inherit' });
        child.unref();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// API: Đọc proxies.txt
app.get('/api/proxies', (req, res) => {
    const proxyFile = path.join(__dirname, 'config', 'proxies.txt');
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
    const args = ['src/workers/capcut_export.js', String(postId), outDir];
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
    const renderArgs = ['src/workers/capcut_export.js', String(postId), outDir];
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
// ===== GIẢI PHÓNG VRAM cho Lips Sync =====
// LatentSync (:8010) hay OOM khi tiến trình GPU khác đang giữ VRAM (WhisperX align, matte RVM...).
// Nút này kill CÁC WORKER GPU CỦA CHÍNH APP (whisperx / matte) để nhường VRAM, KHÔNG đụng vào
// server lips (latentsync), node server, hay tiến trình lạ (browser, app khác) — trừ khi aggressive=true.
async function nvidiaGpuMem() {
    // Trả { total, used, free } (MiB) của GPU đầu tiên; null nếu không có nvidia-smi.
    try {
        const { stdout } = await execFileP('nvidia-smi',
            ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits']);
        const [total, used, free] = stdout.trim().split('\n')[0].split(',').map(s => parseInt(s.trim(), 10));
        return { total, used, free };
    } catch { return null; }
}
async function nvidiaComputeApps() {
    // [{ pid, mem(MiB), cmd }] các tiến trình đang chiếm VRAM.
    try {
        const { stdout } = await execFileP('nvidia-smi',
            ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits']);
        return stdout.trim().split('\n').filter(Boolean).map(line => {
            const [pid, mem] = line.split(',').map(s => s.trim());
            let cmd = '';
            try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
            return { pid: parseInt(pid, 10), mem: parseInt(mem, 10) || 0, cmd };
        }).filter(p => p.pid);
    } catch { return []; }
}
app.post('/api/lips-sync/free-vram', async (req, res) => {
    try {
        const aggressive = !!(req.body && req.body.aggressive);
        const before = await nvidiaGpuMem();
        const apps = await nvidiaComputeApps();
        // Worker GPU của app cạnh tranh với LatentSync -> được phép kill.
        const KILL_RE = /\.venv-whisperx|align_words\.py|matte_lips\.py/;
        // Không bao giờ kill: server lips (latentsync), node server, chính process này.
        const PROTECT_RE = /lips_sync|app\.main|uvicorn|server\.js/;
        const killed = [], skipped = [];
        for (const p of apps) {
            if (p.pid === process.pid) { skipped.push({ ...p, reason: 'server này' }); continue; }
            if (PROTECT_RE.test(p.cmd)) { skipped.push({ ...p, reason: 'được bảo vệ (lips/node)' }); continue; }
            const shouldKill = aggressive ? true : KILL_RE.test(p.cmd);
            if (!shouldKill) { skipped.push({ ...p, reason: 'không phải worker của app' }); continue; }
            try { process.kill(p.pid, 'SIGTERM'); killed.push(p); }
            catch (e) { skipped.push({ ...p, reason: 'kill lỗi: ' + e.message }); }
        }
        // Chờ tiến trình nhả VRAM; SIGKILL cho đứa còn ngoan cố.
        if (killed.length) {
            await new Promise(r => setTimeout(r, 1500));
            for (const p of killed) {
                try { process.kill(p.pid, 0); process.kill(p.pid, 'SIGKILL'); } catch {}
            }
            await new Promise(r => setTimeout(r, 500));
        }
        const after = await nvidiaGpuMem();
        const freed = (before && after) ? Math.max(0, after.free - before.free) : 0;
        console.log(`[free-vram] kill ${killed.length} tiến trình, giải phóng ~${freed} MiB (free ${before?.free}→${after?.free})`);

        // Đảm bảo server lips (latentsync) đang chạy — CHỈ (re)start khi nó đang DOWN, để không cắt job đang chạy.
        let lipsServer = 'unknown';
        try {
            const h = await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs`, { signal: AbortSignal.timeout(2000) });
            lipsServer = h.ok ? 'online' : 'online'; // phản hồi được = còn sống
        } catch {
            lipsServer = 'down';
            try {
                await execFileP('pm2', ['restart', 'latentsync', '--update-env']);
                lipsServer = 'restarting';   // pm2 nhận lệnh; pipeline cần ~60s để load vào VRAM vừa giải phóng
                console.log('[free-vram] latentsync đang down → đã gọi pm2 restart');
            } catch (e) {
                lipsServer = 'restart-failed';
                console.warn('[free-vram] không gọi được pm2 restart latentsync:', e.message);
            }
        }
        res.json({ ok: true, before, after, freed, killed, skipped, hasGpu: !!before, lipsServer });
    } catch (e) {
        res.status(500).json({ error: e.message });
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

// ===== Auto voice (luồng Địa chính trị): lưu cấu hình + tự gen voice sau khi crawl xong =====
// Cấu hình lưu ở <project>/voice_auto.json (KHÔNG dùng cột DB → an toàn với schema dùng chung nhiều nhánh)
function voiceAutoConfigPath(rawProjectId) {
    const projectId = String(rawProjectId).replace(/_[a-z]{2}$/, '');
    return path.join(MEDIA_DIR, projectId, 'voice_auto.json');
}
function readVoiceAutoConfig(rawProjectId) {
    try {
        const p = voiceAutoConfigPath(rawProjectId);
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
}
function writeVoiceAutoConfig(rawProjectId, { speakerUuid, contentType, dictionaryUuids, lips, viSpeakerUuid, speed }) {
    const p = voiceAutoConfigPath(rawProjectId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ct = contentType === 'content_vi' ? 'content_vi' : 'content';
    const spd = Number(speed);
    const cfg = {
        enabled: true,
        speakerUuid: String(speakerUuid || ''),
        contentType: ct,
        dictionaryUuids: Array.isArray(dictionaryUuids) ? dictionaryUuids : [],
        // Tốc độ đọc (ttsmin). Kẹp [0.5, 2]; không hợp lệ → 1 (bình thường).
        speed: Number.isFinite(spd) ? Math.min(2, Math.max(0.5, spd)) : 1,
        // lips chỉ áp dụng khi voice là ngôn ngữ đích (content)
        lips: (ct === 'content' && lips && lips.video)
            ? { enabled: true, video: String(lips.video), guidanceScale: Number.isFinite(Number(lips.guidanceScale)) ? Number(lips.guidanceScale) : 2.2 }
            : { enabled: false },
        // Voice tiếng Việt phụ (tuỳ chọn) → tạo thêm content_vi bằng giọng này
        viSpeakerUuid: viSpeakerUuid ? String(viSpeakerUuid) : '',
    };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    return cfg;
}

// Chờ 1 batch TTS gen xong (checkAndSaveVoice là single-shot → tự poll). Lưu URL audio vào DB khi status OK.
function waitBatchDone(batchUuid, postId, contentType, { intervalMs = 5000, timeoutMs = 20 * 60 * 1000 } = {}) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = async () => {
            try {
                const r = await checkAndSaveVoice(batchUuid, postId, contentType);
                if (r && r.status === 'OK') return resolve(true);
            } catch (e) { console.error('[auto-voice] poll lỗi:', e.message); }
            if (Date.now() - start > timeoutMs) { console.warn('[auto-voice] timeout batch', batchUuid); return resolve(false); }
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

// Tự gen voice cho 1 post rồi (tuỳ chọn) chạy lips sync — dùng params đã lưu lúc tạo project.
async function autoGenVoiceForPost(projectId, post, cfg) {
    // Idempotent: nếu post ĐÃ có voice (audio_uuid) → bỏ qua, tránh gen trùng khi nhiều trigger (content-ready + exit + crawl-all).
    try { const d0 = await getDb(); const cur = await d0.get('SELECT audio_uuid FROM Post WHERE id = ?', [post.id]); await d0.close(); if (cur && cur.audio_uuid) { console.log(`[auto-voice] post ${post.id} đã có voice → bỏ qua`); return; } } catch {}
    const projectDir = path.join(MEDIA_DIR, projectId);

    // ===== 1) VOICE CHÍNH (nếu có speakerUuid) =====
    const primaryCt = cfg.speakerUuid ? (cfg.contentType === 'content_vi' ? 'content_vi' : 'content') : null;
    if (cfg.speakerUuid) {
        const lang = primaryCt === 'content_vi' ? 'vi' : (post.target_lang || 'en');
        console.log(`[auto-voice] Gen voice chính post ${post.id} (lang=${lang}, ct=${primaryCt})`);
        const result = await generateAudios(projectDir, post.id, lang, cfg.speakerUuid, primaryCt, cfg.dictionaryUuids || [], null, cfg.speed);
        const db = await getDb();
        await db.run('UPDATE Post SET audio_uuid = ?, voice_content_type = ? WHERE id = ?', [result.batch_uuid, primaryCt, post.id]);
        await db.close();
        await updateBatchStatus(result.batch_uuid);
        const ok = await waitBatchDone(result.batch_uuid, post.id, primaryCt);
        if (ok) {
            console.log(`[auto-voice] Voice chính xong post ${post.id}`);
            // Lips sync: chỉ với target (content) + đã bật auto lips. Video LUÔN lấy theo THỨ (runLipsSyncForPost tự resolve).
            if (primaryCt === 'content' && cfg.lips && cfg.lips.enabled) {
                try {
                    await runLipsSyncForPost({ postId: post.id, contentType: 'content', guidanceScale: cfg.lips.guidanceScale });
                    console.log(`[auto-voice] Đã gửi job lips sync post ${post.id}`);
                } catch (e) { console.error('[auto-voice] Lips sync lỗi post ' + post.id + ':', e.message); }
            }
        } else console.warn('[auto-voice] Voice chính chưa xong post', post.id);
    }

    // ===== 2) VOICE TIẾNG VIỆT PHỤ (tuỳ chọn) — chỉ khi voice chính KHÔNG phải content_vi (tránh trùng) =====
    if (cfg.viSpeakerUuid && primaryCt !== 'content_vi') {
        try {
            console.log(`[auto-voice] Gen thêm voice tiếng Việt post ${post.id}`);
            const rvi = await generateAudios(projectDir, post.id, 'vi', cfg.viSpeakerUuid, 'content_vi', [], null, cfg.speed);
            // Nếu KHÔNG có voice chính thì audio_uuid chưa được set → lưu theo VN để idempotent
            if (!cfg.speakerUuid) { const db = await getDb(); await db.run('UPDATE Post SET audio_uuid = ?, voice_content_type = ? WHERE id = ?', [rvi.batch_uuid, 'content_vi', post.id]); await db.close(); }
            await updateBatchStatus(rvi.batch_uuid);
            const okVi = await waitBatchDone(rvi.batch_uuid, post.id, 'content_vi');
            console.log(okVi ? `[auto-voice] Voice tiếng Việt xong post ${post.id}` : `[auto-voice] Voice tiếng Việt chưa xong post ${post.id}`);
        } catch (e) { console.error('[auto-voice] Voice tiếng Việt lỗi post ' + post.id + ':', e.message); }
    }
}

// Điều phối: sau khi pipeline crawl xong, gen voice (+lips) cho mọi post của project đã hoàn tất.
async function orchestrateAutoVoice(projectId) {
    const cfg = readVoiceAutoConfig(projectId);
    if (!cfg || !cfg.enabled) return;
    const db = await getDb();
    const posts = await db.all(
        'SELECT id, target_lang FROM Post WHERE (project_id = ? OR project_id LIKE ?) AND status IS NULL',
        [projectId, `${projectId}\_%`]
    );
    await db.close();
    if (!posts.length) { console.warn('[auto-voice] Không có post nào hoàn tất cho', projectId); return; }
    console.log(`[auto-voice] Bắt đầu tự tạo voice cho ${posts.length} post của ${projectId}`);
    for (const post of posts) {
        try { await autoGenVoiceForPost(projectId, post, cfg); }
        catch (e) { console.error('[auto-voice] Lỗi post ' + post.id + ':', e.message); }
    }
    console.log(`[auto-voice] Hoàn tất auto voice cho ${projectId}`);
}

// Chạy lips_sync cho TỪNG CÂU của 1 post: tải mp3 mỗi câu, gửi job, output lưu vào <project>/lips_sync/
// Dùng chung cho endpoint thủ công (/run-post) lẫn auto sau khi tạo audio (/auto-run).
// Ngưỡng VRAM trống tối thiểu để bắt đầu bắn job lips (MiB). Đo thực tế: chạy khoẻ luôn còn
// 6400-7400 MiB trống, lúc OOM chỉ còn ~100 MiB. Trùng ngưỡng MIN_FREE_VRAM_MB của server lips.
const LIPS_MIN_FREE_VRAM_MB = parseInt(process.env.LIPS_MIN_FREE_VRAM_MB || '2048', 10);

// Ảnh chụp các job CÒN SỐNG (queued/running) trên server lips, tra theo output_path.
//
// Vì sao cần: DB chỉ nhớ job_id MỚI NHẤT của mỗi (post, idx) — upsert ON CONFLICT ghi đè.
// Bấm "chạy lips sync" lần 2 lúc lần 1 chưa xong => job cũ bị mất dấu trong DB nhưng VẪN
// nằm trong hàng đợi và vẫn chạy: không tra ra dự án, không huỷ được qua UI, và 2-3 job
// cùng ghi đè 1 file mp4. Đo thực tế đã có 174/221 job trong hàng đợi là bản trùng.
// Tra theo output_path (không theo DB) nên tóm được cả job mồ côi từ các lần chạy trước.
async function lipsLiveJobsByOutput() {
    const map = new Map();   // output_path -> [jobId]
    try {
        const qr = await globalThis.fetch(`${LIPS_SYNC_BASE}/queue`, { signal: AbortSignal.timeout(5000) });
        if (!qr.ok) return map;
        const q = await qr.json();
        const ids = [...(q.running || []), ...(q.waiting || [])];
        await Promise.all(ids.map(async (jid) => {
            try {
                const r = await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs/${encodeURIComponent(jid)}`, { signal: AbortSignal.timeout(5000) });
                if (!r.ok) return;
                const d = await r.json();
                if (!d.output_path || !['queued', 'running'].includes(d.status)) return;
                if (!map.has(d.output_path)) map.set(d.output_path, []);
                map.get(d.output_path).push(jid);
            } catch { /* 1 job tra lỗi không được làm hỏng cả ảnh chụp */ }
        }));
    } catch (e) {
        console.warn('[lips] không đọc được hàng đợi để lọc trùng:', e.message);
    }
    return map;
}

async function cancelLipsJobs(jobIds) {
    if (!jobIds || !jobIds.length) return;
    try {
        await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs/cancel`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_ids: jobIds }), signal: AbortSignal.timeout(5000),
        });
    } catch (e) { console.warn('[lips] không huỷ được job cũ:', e.message); }
}

async function runLipsSyncForPost({ postId, contentType: reqCt, force, guidanceScale, ignoreVram }) {
    if (!postId) { const e = new Error('Thiếu postId'); e.status = 400; throw e; }
    const gs = Number(guidanceScale);
    const guidance = Number.isFinite(gs) ? gs : 2.2;

    const db = await getDb();
    const post = await db.get('SELECT project_id, voice_content_type, genre FROM Post WHERE id = ?', [postId]);
    await db.close();
    if (!post) { const e = new Error('Không tìm thấy post'); e.status = 404; throw e; }

    // LUÔN chạy THEO NGÀY: dùng video khuôn mặt của THỨ hôm nay theo thể loại (đã bỏ input video thủ công).
    const genre = normLipsGenre(post.genre) || (String(post.project_id).startsWith('proj_') ? 'geo' : 'naze');
    const wd = lipsWeekday();
    const videoPath = lipsLibVideo(wd, genre);
    if (!videoPath || !fs.existsSync(videoPath)) {
        const e = new Error(`Chưa có video khuôn mặt cho ${LIPS_WEEKDAY_LABELS[wd] || ('thứ ' + wd)} (thể loại ${genre}). Thêm ở "🗓️ Video khuôn mặt theo thứ".`);
        e.status = 400; throw e;
    }

    // CHẶN SỚM khi GPU đang bị app khác chiếm: bắn cả trăm job vào GPU không còn chỗ thì
    // mỗi job chết OOM sau ~4s, và người dùng chỉ thấy "hàng trăm job chờ mà không chạy".
    // Thà báo ngay ở đây, kèm tên tiến trình đang giữ VRAM, để còn tắt app đó rồi chạy lại.
    if (!ignoreVram) {
        const mem = await nvidiaGpuMem();
        if (mem && mem.free < LIPS_MIN_FREE_VRAM_MB) {
            const apps = await nvidiaComputeApps();
            const hogs = apps
                .filter(p => p.mem >= 200 && !/lips_sync|app\.main|uvicorn/.test(p.cmd))
                .sort((a, b) => b.mem - a.mem)
                .map(p => `${path.basename((p.cmd || '').split(' ')[0]) || 'pid ' + p.pid} (${p.mem} MiB)`);
            const e = new Error(
                `GPU chỉ còn ${mem.free}/${mem.total} MiB trống, cần tối thiểu ${LIPS_MIN_FREE_VRAM_MB} MiB. `
                + (hogs.length ? `Đang chiếm VRAM: ${hogs.join(', ')}. Tắt bớt rồi chạy lại.` : 'Hãy chờ GPU rảnh rồi chạy lại.')
            );
            e.status = 409;
            throw e;
        }
    }

    const contentType = reqCt || post.voice_content_type || 'content';
    const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
    const outDir = path.join(MEDIA_DIR, projectId, 'lips_sync');
    fs.mkdirSync(outDir, { recursive: true });

    const audioList = await getAllAudioUrls(postId, contentType);
    // Job đang chờ/chạy cho CHÍNH các file mp4 sắp ghi. Bấm chạy lại lúc lượt trước chưa
    // xong sẽ rơi vào đây và dùng lại job cũ thay vì gửi thêm bản trùng.
    const liveByOutput = await lipsLiveJobsByOutput();
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
            const live = liveByOutput.get(outputPath) || [];
            if (live.length && !force) {
                // Đã có job sống ghi đúng file này -> DÙNG LẠI (ghi job_id vào DB, nhận
                // luôn cả job mồ côi của lần chạy trước), không gửi thêm job trùng.
                jobs.push({ index: idx, jobId: live[0], status: 'queued', audioPath, outputPath, reused: true });
                if (live.length > 1) await cancelLipsJobs(live.slice(1));   // dọn bản trùng cũ
                continue;
            }
            // force = làm lại từ đầu: huỷ job cũ trước, tránh 2 job cùng ghi 1 file.
            if (live.length) await cancelLipsJobs(live);
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
// Dừng lips_sync của 1 post: huỷ các job đang chờ trên server inference + đánh dấu 'cancelled' trong DB.
// Job đang chạy (đang inference) không cắt được giữa chừng nên sẽ chạy nốt câu đó.
app.post('/api/lips-sync/stop', async (req, res) => {
    const { postId } = req.body || {};
    if (!postId) return res.status(400).json({ error: 'Thiếu postId' });
    try {
        const db = await getDb();
        // Các job còn dang dở (chưa xong/ chưa lỗi/ chưa huỷ)
        const rows = await db.all(
            "SELECT job_id AS jobId FROM LipsSyncJob WHERE post_id = ? AND job_id IS NOT NULL AND status NOT IN ('done','error','cancelled')",
            [postId]
        );
        const jobIds = rows.map(r => r.jobId).filter(Boolean);
        let running = [];
        // Best-effort: gọi server inference huỷ job đang chờ (không có cũng không sao)
        try {
            const r = await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs/cancel`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_ids: jobIds }),
            });
            const data = await r.json().catch(() => ({}));
            running = Array.isArray(data.running) ? data.running : [];
        } catch (e) { console.warn('[lips-sync/stop] Không gọi được cancel :8010:', e.message); }
        // Đánh dấu cancelled cho các job KHÔNG phải đang chạy (job đang chạy để nó chạy nốt)
        const now = Date.now();
        let cancelled = 0;
        for (const jid of jobIds) {
            if (running.includes(jid)) continue;
            await db.run("UPDATE LipsSyncJob SET status = 'cancelled', updated_at = ? WHERE job_id = ?", [now, jid]);
            cancelled++;
        }
        await db.close();
        res.json({ ok: true, cancelled, running });
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
// Tải TẤT CẢ video lips sync của 1 post thành 1 file zip (đặt tên 1.mp4, 2.mp4... theo thứ tự câu)
app.get('/api/lips-sync/download/:postId', async (req, res) => {
    try {
        const postId = req.params.postId;
        const db = await getDb();
        const post = await db.get('SELECT project_id FROM Post WHERE id = ?', [postId]);
        const rows = await db.all(
            `SELECT idx AS "index", output_path AS outputPath FROM LipsSyncJob
             WHERE post_id = ? AND status = 'done' AND output_path IS NOT NULL ORDER BY idx`, [postId]);
        await db.close();
        if (!post) return res.status(404).json({ error: 'Không thấy post' });
        const projectId = post.project_id.replace(/_[a-z]{2}$/, '');

        // Ưu tiên DB; chưa lưu DB thì quét thẳng thư mục lips_sync (giống /saved)
        let files = rows.filter(r => r.outputPath && fs.existsSync(r.outputPath))
            .map(r => ({ index: r.index, path: r.outputPath }));
        if (!files.length) {
            const dir = path.join(MEDIA_DIR, projectId, 'lips_sync');
            if (fs.existsSync(dir)) {
                files = fs.readdirSync(dir).filter(f => /^\d+\.mp4$/i.test(f))
                    .map(f => ({ index: parseInt(f, 10), path: path.join(dir, f) }))
                    .sort((a, b) => a.index - b.index);
            }
        }
        if (!files.length) return res.status(404).json({ error: 'Chưa có video lips sync nào để tải' });

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${projectId}_lips_sync.zip"`);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', e => { console.error('[lips-zip]', e.message); try { res.end(); } catch (_) {} });
        archive.pipe(res);
        for (const f of files) archive.file(f.path, { name: `${f.index}.mp4` });
        console.log(`[lips-zip] post ${postId}: đóng gói ${files.length} video`);
        await archive.finalize();
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
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

// Thumbnail jpg 320px cho lưới asset (video + ảnh). Sinh lần đầu rồi cache trên đĩa.
// Lưới KHÔNG trỏ thẳng file gốc nữa: mở 1 project naze là ~400 video/10GB, kéo qua LAN thì treo máy.
app.get('/api/thumb', async (req, res) => {
    const rel = String(req.query.path || '');
    const root = path.resolve(MEDIA_DIR);
    const src = path.resolve(MEDIA_DIR, rel);
    if (!rel || !src.startsWith(root + path.sep)) return res.status(400).send('Bad path');
    try {
        const thumb = await ensureThumb(MEDIA_DIR, rel);
        // Cache 1 ngày CHỈ khi URL có dấu phiên bản (?v=<id asset>). Xóa ảnh rồi cào lại thì file mới
        // lấy đúng tên cũ (stock_1.jpg...) -> cùng URL, khác nội dung: trình duyệt giữ cache 24h nên
        // hiện lại ẢNH CŨ. Không có ?v= (link cũ, chỗ khác gọi) thì bắt buộc kiểm lại với server.
        res.setHeader('Cache-Control', req.query.v ? 'public, max-age=86400' : 'no-cache');
        res.sendFile(thumb, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) {
        // Không tạo được thumb (file hỏng/ffmpeg lỗi) → trả 404, UI tự fallback về nền đen
        res.status(404).end();
    }
});

// Xem video: trả bản proxy 480p nếu đã encode xong, chưa có thì phát bản gốc và encode nền cho lần sau.
// Không bao giờ bắt client CHỜ encode — chờ ffmpeg còn lâu hơn tải file gốc.
app.get('/api/media', (req, res) => {
    const rel = String(req.query.path || '');
    const root = path.resolve(MEDIA_DIR);
    const src = path.resolve(MEDIA_DIR, rel);
    if (!rel || !src.startsWith(root + path.sep) || !fs.existsSync(src)) return res.status(404).end();

    if (proxyReady(MEDIA_DIR, rel)) {
        // Cùng lý do như /api/thumb: chỉ cache dài khi URL có ?v=<id asset>, kẻo file bị thay
        // (xóa rồi cào lại trùng tên) mà trình duyệt vẫn phát bản cũ.
        res.setHeader('Cache-Control', req.query.v ? 'public, max-age=86400' : 'no-cache');
        return res.sendFile(proxyPathFor(MEDIA_DIR, rel), (err) => { if (err && !res.headersSent) res.status(404).end(); });
    }
    ensureProxy(MEDIA_DIR, rel).catch(() => {});
    res.sendFile(src, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// Tạo & CHỜ proxy 480p sẵn sàng rồi mới báo "ready" — dùng khi mở Edit video: client chờ cái này xong
// mới nạp video, để luôn xem qua bản 480p nhẹ (faststart) thay vì tải nguyên bản gốc lớn qua LAN 100Mbps.
app.post('/api/ensure-proxy', express.json(), async (req, res) => {
    const rel = String(req.body?.path || '');
    const src = path.resolve(MEDIA_DIR, rel);
    if (!rel || !src.startsWith(path.resolve(MEDIA_DIR) + path.sep) || !fs.existsSync(src)) return res.json({ ready: false });
    try {
        // Proxy đã sẵn → dùng luôn.
        if (proxyReady(MEDIA_DIR, rel)) return res.json({ ready: true });
        // LUÔN tạo proxy 480p (faststart, moov ở đầu) cho video mở trong Edit — kể cả clip nhỏ đã trim.
        // Trước đây bỏ qua file <4MB → clip đã trim (nhỏ + moov cuối do -c copy) nạp thẳng, trình duyệt đọc
        // duration lỗi → không trim lại được. Proxy faststart đảm bảo timeline luôn đọc đúng duration.
        await ensureProxy(MEDIA_DIR, rel);
        res.json({ ready: true });
    } catch { res.json({ ready: false }); }
});

app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Chỉ phục vụ public/ (index.html, media-upload.html). Trước đây static(__dirname) mở cả thư mục gốc
// ra HTTP — nghĩa là /google_sheet.json (key service account) tải được từ trình duyệt. UI không dùng
// file tĩnh nào ở gốc (chỉ /api/* + media từ MEDIA_DIR) nên bỏ đi là an toàn.
// index.html chứa TOÀN BỘ app (Vue inline) → tuyệt đối không để trình duyệt dùng bản cache:
// sửa dashboard xong mà tab cũ vẫn chạy JS cũ thì mọi nút mới/bản vá đều "không có tác dụng".
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
}));
app.use(express.static(MEDIA_DIR, {
    setHeaders: (res, path) => {
        res.setHeader('Accept-Ranges', 'bytes'); // Cho phép trình duyệt yêu cầu từng đoạn video để tua
    }
}));

// ============================================================
// TRANG QUẢN LÝ FILE trong thư mục Downloads (SHEET_FILE_DIR)
// Cho team thêm/xóa file SRT/MP4... từ xa, không cần chép tay vào máy.
// ============================================================
const MEDIA_UPLOAD_DIR = process.env.SHEET_FILE_DIR || '/home/gux/Downloads';
// Chỉ cho phép các đuôi này (an toàn, tránh upload file thực thi)
const MEDIA_UPLOAD_EXTS = new Set(['.srt', '.vtt', '.txt', '.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.jpg', '.jpeg', '.png', '.webp']);
// Tên file an toàn: chỉ lấy basename, chặn path traversal
function safeMediaName(name) {
    const base = path.basename(String(name || '')).replace(/[\\/]/g, '');
    if (!base || base === '.' || base === '..') return null;
    return base;
}

app.get('/media-upload', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'media-upload.html'));
});

// Trang list hàng đợi Lips Sync
app.get('/lips-queue', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'lips-queue.html'));
});

// API: liệt kê hàng đợi lips sync theo TỪNG DỰ ÁN + trạng thái worker inference (running/waiting).
app.get('/api/lips-sync/queues', async (req, res) => {
    try {
        const db = await getDb();
        const has = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='LipsSyncJob'");
        if (!has) { await db.close(); return res.json({ projects: [], queue: null }); }
        // Trạng thái worker inference (best-effort, không có cũng không sao)
        let queue = null;
        try {
            const r = await globalThis.fetch(`${LIPS_SYNC_BASE}/queue`);
            if (r.ok) queue = await r.json();
        } catch (_) {}

        // KHÔNG tin cột status trong DB: nó chỉ được cập nhật bởi /api/lips-sync/status,
        // mà endpoint đó chỉ chạy khi người dùng đang MỞ modal lips của đúng post đó.
        // Hệ quả cũ: không dòng nào từng mang status 'running' -> cột "Đang chạy" luôn 0,
        // và job đã xong từ lâu vẫn nằm ở 'queued' -> số "Đang chờ" phóng đại.
        // Nay đối chiếu lại từng dòng với hàng đợi sống (:8010) + file mp4 có thật trên đĩa.
        // CHỈ đối chiếu khi thực sự đọc được hàng đợi. Nếu :8010 đang down/timeout thì
        // queue=null — lúc đó coi mọi job 'queued' là đã huỷ sẽ xoá sạch trạng thái thật
        // chỉ vì một lần mất kết nối. Không có snapshot thì giữ nguyên status trong DB.
        const canReconcile = !!queue && Array.isArray(queue.waiting);
        const liveRunning = new Set(queue?.running || []);
        const liveWaiting = new Set(queue?.waiting || []);
        const rows = await db.all(`
            SELECT j.post_id AS postId, j.job_id AS jobId, j.status AS status, j.output_path AS outputPath,
                   j.updated_at AS updatedAt, p.project_id AS projectId, COALESCE(p.title, p.project_id) AS title
              FROM LipsSyncJob j LEFT JOIN Post p ON p.id = j.post_id`);
        const byPost = new Map();
        const heal = [];   // dòng cần chữa lại status trong DB cho lần sau
        for (const r of rows) {
            let st;
            if (!canReconcile) st = r.status || 'queued';
            else if (r.jobId && liveRunning.has(r.jobId)) st = 'running';
            else if (r.jobId && liveWaiting.has(r.jobId)) st = 'queued';
            else if (r.outputPath && fs.existsSync(r.outputPath)) st = 'done';
            else if (r.status === 'queued') st = 'cancelled';   // không còn trong hàng đợi, cũng không có file
            else st = r.status || 'queued';
            if (st !== r.status && st !== 'running' && r.jobId) heal.push([st, r.jobId]);
            let g = byPost.get(r.postId);
            if (!g) {
                g = { postId: r.postId, projectId: r.projectId, title: r.title,
                      total: 0, done: 0, queued: 0, running: 0, error: 0, cancelled: 0, updatedAt: 0 };
                byPost.set(r.postId, g);
            }
            g.total++;
            if (g[st] !== undefined) g[st]++;
            if ((r.updatedAt || 0) > g.updatedAt) g.updatedAt = r.updatedAt || 0;
        }
        const projects = [...byPost.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        // Ghi lại trạng thái đã đối chiếu để DB tự lành dần (bỏ qua 'running' vì nó đổi liên tục).
        for (const [st, jid] of heal) {
            await db.run('UPDATE LipsSyncJob SET status = ? WHERE job_id = ?', [st, jid]);
        }
        // Worker chỉ trả job_id trần (vd "d0156fa4f703") → tra ngược ra TÊN DỰ ÁN cho dễ nhận.
        if (queue) {
            const ids = [...(queue.running || []), ...(queue.waiting || [])].filter(Boolean);
            const byId = {};
            if (ids.length) {
                const ph = ids.map(() => '?').join(',');
                const rows = await db.all(
                    `SELECT j.job_id AS jobId, j.idx AS idx, j.post_id AS postId,
                            p.project_id AS projectId, COALESCE(p.title, p.project_id) AS title
                       FROM LipsSyncJob j LEFT JOIN Post p ON p.id = j.post_id
                      WHERE j.job_id IN (${ph})`, ids);
                for (const r of rows) byId[r.jobId] = r;
            }
            const info = (jid) => ({ jobId: jid, ...(byId[jid] || {}) });
            queue.runningInfo = (queue.running || []).map(info);
            queue.waitingInfo = (queue.waiting || []).map(info);
        }
        await db.close();
        res.json({ projects, queue });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Huỷ TOÀN BỘ job lips còn dang dở (mọi dự án). Job đang chạy để nó chạy nốt (không cắt giữa chừng).
app.post('/api/lips-sync/clear-all', async (req, res) => {
    try {
        const db = await getDb();
        const has = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='LipsSyncJob'");
        if (!has) { await db.close(); return res.json({ ok: true, cancelled: 0, running: [] }); }
        const rows = await db.all(
            "SELECT job_id AS jobId FROM LipsSyncJob WHERE job_id IS NOT NULL AND status NOT IN ('done','error','cancelled')"
        );
        // Hàng đợi worker có thể chứa job KHÔNG còn dấu vết trong DB (job mồ côi từ lần chạy trước,
        // đổi nhánh/reset DB...). Chỉ dựa vào DB thì xoá không sạch → gộp thêm id lấy thẳng từ worker.
        const fromDb = rows.map(r => r.jobId).filter(Boolean);
        let fromWorker = [];
        try {
            const qr = await globalThis.fetch(`${LIPS_SYNC_BASE}/queue`);
            if (qr.ok) {
                const q = await qr.json();
                fromWorker = [...(q.running || []), ...(q.waiting || [])].filter(Boolean);
            }
        } catch (_) {}
        const jobIds = [...new Set([...fromDb, ...fromWorker])];
        const orphans = fromWorker.filter(id => !fromDb.includes(id)).length;
        if (orphans) console.log(`[lips-sync/clear-all] ${orphans} job trong worker không có trong DB (mồ côi) — vẫn huỷ.`);
        let running = [];
        try {
            const r = await globalThis.fetch(`${LIPS_SYNC_BASE}/jobs/cancel`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_ids: jobIds }),
            });
            const data = await r.json().catch(() => ({}));
            running = Array.isArray(data.running) ? data.running : [];
        } catch (e) { console.warn('[lips-sync/clear-all] Không gọi được cancel :8010:', e.message); }
        const now = Date.now();
        let cancelled = 0;
        for (const jid of jobIds) {
            if (running.includes(jid)) continue;      // đang chạy → để chạy nốt
            await db.run("UPDATE LipsSyncJob SET status = 'cancelled', updated_at = ? WHERE job_id = ?", [now, jid]);
            cancelled++;
        }
        await db.close();
        console.log(`[lips-sync/clear-all] Đã huỷ ${cancelled} job, ${running.length} job đang chạy để chạy nốt.`);
        res.json({ ok: true, cancelled, running });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Xoá nền video lips: RVM matte → người trên NỀN XANH (N_green.mp4). Chạy nền. Sau đó export CapCut tự dùng bản này.
const matteRunning = new Set();
app.post('/api/lips-sync/matte', async (req, res) => {
    const { postId, force } = req.body || {};
    if (!postId) return res.status(400).json({ error: 'Thiếu postId' });
    if (matteRunning.has(postId)) return res.json({ ok: true, message: 'Đang xoá nền, chờ chút...' });
    try {
        const db = await getDb();
        const post = await db.get('SELECT project_id FROM Post WHERE id = ?', [postId]);
        await db.close();
        if (!post) return res.status(404).json({ error: 'Post not found' });
        const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
        const lipsDir = path.join(MEDIA_DIR, projectId, 'lips_sync');
        if (!fs.existsSync(lipsDir)) return res.status(400).json({ error: 'Chưa có lips_sync — chạy lips sync trước.' });
        const py = process.env.MATTE_PYTHON || '/home/gux/workspace/lips_sync/lips_sync/.venv/bin/python';
        const args = ['src/workers/matte_lips.py', lipsDir];
        if (force) args.push('--force');
        matteRunning.add(postId);
        const child = spawn(py, args, { cwd: __dirname, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => process.stdout.write(`[matte-lips] ${d}`));
        child.stderr.on('data', d => process.stderr.write(`[matte-lips] ${d}`));
        child.on('exit', code => { matteRunning.delete(postId); console.log(`[matte-lips] post ${postId} xong (code ${code})`); });
        child.on('error', e => { matteRunning.delete(postId); console.error('[matte-lips] spawn lỗi:', e.message); });
        res.json({ ok: true, message: 'Đang xoá nền lips (chạy nền, vài phút). Xong export CapCut sẽ tự dùng bản đã xoá nền — nhớ Chroma key màu xanh trong CapCut.' });
    } catch (e) { matteRunning.delete(postId); res.status(500).json({ error: e.message }); }
});

// Trạng thái xoá nền lips: đã có bao nhiêu N_green.mp4 / tổng N.mp4
app.get('/api/lips-sync/matte-status/:postId', async (req, res) => {
    try {
        const db = await getDb();
        const post = await db.get('SELECT project_id FROM Post WHERE id = ?', [req.params.postId]);
        await db.close();
        if (!post) return res.status(404).json({ error: 'Post not found' });
        const lipsDir = path.join(MEDIA_DIR, post.project_id.replace(/_[a-z]{2}$/, ''), 'lips_sync');
        let total = 0, green = 0;
        if (fs.existsSync(lipsDir)) {
            for (const f of fs.readdirSync(lipsDir)) {
                if (/^\d+\.mp4$/i.test(f)) total++;
                else if (/^\d+_green\.mp4$/i.test(f)) green++;
            }
        }
        res.json({ total, green, running: matteRunning.has(Number(req.params.postId)) || matteRunning.has(req.params.postId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Liệt kê file trong thư mục Downloads (kèm size + thời gian sửa + danh sách đuôi)
app.get('/api/media-files', (req, res) => {
    try {
        const entries = fs.readdirSync(MEDIA_UPLOAD_DIR, { withFileTypes: true });
        const files = [];
        const exts = new Set();
        for (const e of entries) {
            if (!e.isFile()) continue;
            const ext = path.extname(e.name).toLowerCase();
            let size = 0, mtime = 0;
            try { const st = fs.statSync(path.join(MEDIA_UPLOAD_DIR, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
            files.push({ name: e.name, ext: ext || '(khác)', size, mtime });
            exts.add(ext || '(khác)');
        }
        files.sort((a, b) => b.mtime - a.mtime);   // mới nhất lên đầu
        res.json({ dir: MEDIA_UPLOAD_DIR, files, exts: [...exts].sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload 1 hoặc nhiều file vào Downloads (giữ nguyên tên gốc, tránh ghi đè bằng hậu tố _1, _2...)
app.post('/api/media-files/upload', upload.array('files', 100), async (req, res) => {
    try {
        if (!req.files || !req.files.length) return res.status(400).json({ error: 'Không có file nào' });
        const saved = [];
        for (const file of req.files) {
            const name = safeMediaName(file.originalname);
            const ext = name ? path.extname(name).toLowerCase() : '';
            if (!name || !MEDIA_UPLOAD_EXTS.has(ext)) { try { fs.unlinkSync(file.path); } catch {} continue; }
            // Tránh ghi đè: nếu trùng tên thì thêm hậu tố
            let dest = path.join(MEDIA_UPLOAD_DIR, name);
            if (fs.existsSync(dest)) {
                const stem = name.slice(0, name.length - ext.length);
                let i = 1;
                do { dest = path.join(MEDIA_UPLOAD_DIR, `${stem}_${i}${ext}`); i++; } while (fs.existsSync(dest));
            }
            fs.renameSync(file.path, dest);
            saved.push(path.basename(dest));
        }
        res.json({ success: true, saved });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Xóa 1 file trong Downloads
app.delete('/api/media-files', (req, res) => {
    try {
        const name = safeMediaName(req.query.name || (req.body && req.body.name));
        if (!name) return res.status(400).json({ error: 'Tên file không hợp lệ' });
        const target = path.join(MEDIA_UPLOAD_DIR, name);
        if (!fs.existsSync(target)) return res.status(404).json({ error: 'File không tồn tại' });
        fs.unlinkSync(target);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// SSE clients
const sseClients = new Set();

export function pushCrawlStatus(postTitle, status) {
    const data = JSON.stringify({ postTitle, status });
    for (const client of sseClients) {
        client.write(`data: ${data}\n\n`);
    }
}

// Crawl xong 1 CẢNH (section/paragraph) → báo dashboard nạp lại assets để hiện DẦN, không đợi hết.
export function pushCrawlScene(postTitle) {
    const data = JSON.stringify({ postTitle, scene: true });
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

// Gửi thông báo Slack (Incoming Webhook). Không có SLACK_WEBHOOK_URL → im lặng bỏ qua.
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
async function postSlack(text) {
    if (!SLACK_WEBHOOK_URL) return;
    try {
        await globalThis.fetch(SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    } catch (e) { console.error('[slack] gửi lỗi:', e.message); }
}

// Bắn Slack "crawl xong" cho 1 project (tra tên bài cho đẹp). Dùng chung: notify endpoint + crawl-all.
// missingScenes: mảng số cảnh không lấy được ảnh → cảnh báo để bấm crawl bù.
async function announceSlack(postTitle, missingScenes) {
    let name = postTitle;
    try {
        const db = await getDb();
        const post = await db.get('SELECT COALESCE(title, project_id) AS title FROM Post WHERE project_id = ? OR title = ? ORDER BY id DESC LIMIT 1', [postTitle, postTitle]);
        await db.close();
        if (post?.title) name = post.title;
    } catch {}
    const url = `http://${getLanIp()}:${PORT}`;
    const warn = (Array.isArray(missingScenes) && missingScenes.length)
        ? `\n⚠️ ${missingScenes.length} cảnh thiếu ảnh: ${missingScenes.join(', ')} — nên bấm "crawl media" để cào bù.`
        : '';
    await postSlack(`✅ Dự án đã crawl xong: *${name}* (\`${postTitle}\`)${warn}\n🔗 Mở (cùng mạng LAN): ${url}`);
}

app.post('/api/crawl-status/notify', (req, res) => {
    const { postTitle, status, scene, missingScenes, silent } = req.body;
    // scene=true → crawl xong 1 cảnh, chỉ báo dashboard nạp lại assets (KHÔNG đổi status, KHÔNG Slack)
    if (scene) { pushCrawlScene(postTitle); return res.json({ success: true }); }
    pushCrawlStatus(postTitle, status);
    // status === null = pipeline crawl XONG → bắn Slack (kèm cảnh thiếu ảnh nếu có)
    // silent=true → chỉ xoá spinner trên dashboard (dự án lỗi/bị huỷ), KHÔNG báo "đã crawl xong"
    if (!silent && (status === null || status === 'done')) announceSlack(postTitle, missingScenes);
    res.json({ success: true });
});

// ============================================================
// GOOGLE SHEET → tự tạo dự án naze/drama (poll mỗi 2 phút, KHÔNG cần bấm tay)
// Tab 'naze_drama'. Cột: Trạng thái | genre | topic | targetLang | projectId | tweetUrls
//                        | speakerUuid | voiceContentType | dictionaryUuids | lipsVideo | lipsGuidance | note
// Dòng QUEUE → PROCESSING → tạo project (+auto voice nếu có speakerUuid) → DONE/ERROR. (Ô trống bị bỏ qua.)
// (Địa chính trị khác nhiều → làm sau, dùng tab riêng.)
// ============================================================
const SHEET_ID = process.env.NAZE_SHEET_ID || '1K596bCoqZcNx0hvZbJitwHhIYTANpgsI8KqrWsvkRSs';
const SHEET_TAB = 'naze_drama';
// Header TIẾNG VIỆT (thân thiện). Poller map giá trị tiếng Việt → nội bộ.
const SHEET_COL = {
    status: 'Trạng thái', genre: 'Thể loại', topic: 'Chủ đề / Nội dung', lang: 'Ngôn ngữ đích',
    projectId: 'Mã dự án', tweets: 'Link tweet (drama)',
    voiceOn: 'Tạo giọng đọc?', speaker: 'Giọng đọc', voiceType: 'Loại giọng', dict: 'Từ điển',
    lipsOn: 'Lips sync?', lipsVideo: 'Video khuôn mặt (lips)', lipsGuidance: 'Độ mạnh lips',
    srtSrc: 'File SRT (nguồn)', srtTgt: 'File SRT (đích)', note: 'Ghi chú',
    speakerVi: 'Giọng đọc (tiếng Việt)',   // TUỲ CHỌN: chọn → tạo thêm voice tiếng Việt (content_vi) song song voice chính
    speed: 'Tốc độ đọc',   // TUỲ CHỌN: tốc độ voice (ttsmin) — trống/không hợp lệ = 1 (bình thường), kẹp [0.5, 2]
};
// 'speed' đứng NGAY SAU 'Tạo giọng đọc?' (index 7) → các cột từ 'Giọng đọc' trở đi dịch phải +1:
// speaker=8, lipsVideo=12, srtSrc=14, srtTgt=15. speakerVi vẫn ở CUỐI.
const SHEET_HEADERS = [SHEET_COL.status, SHEET_COL.genre, SHEET_COL.topic, SHEET_COL.lang, SHEET_COL.projectId, SHEET_COL.tweets,
    SHEET_COL.voiceOn, SHEET_COL.speed, SHEET_COL.speaker, SHEET_COL.voiceType, SHEET_COL.dict,
    SHEET_COL.lipsOn, SHEET_COL.lipsVideo, SHEET_COL.lipsGuidance,
    SHEET_COL.srtSrc, SHEET_COL.srtTgt, SHEET_COL.note, SHEET_COL.speakerVi];
// Đọc tốc độ đọc từ 1 ô sheet: trống/không hợp lệ → 1; kẹp [0.5, 2].
function sheetParseSpeed(v) { const n = parseFloat(String(v || '').replace(',', '.')); return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1; }
const SHEET_COL_SPEAKER_VI_IDX = SHEET_HEADERS.indexOf(SHEET_COL.speakerVi);   // 0-index cột giọng Việt (cho dropdown)
const SHEET_POLL_MS = 2 * 60 * 1000;
const MAX_SHEET_JOBS = parseInt(process.env.MAX_SHEET_JOBS) || 1;   // số project naze/drama chạy đồng thời (mặc định 1 = tuần tự, từng dòng một)
const SHEET_FILE_DIR = process.env.SHEET_FILE_DIR || '/home/gux/Downloads';   // thư mục quét file mp4/srt cho dropdown
const SHEET_SPEAKER_LANGS = (process.env.SHEET_SPEAKER_LANGS || 'vi,ja').split(',').map(s => s.trim()).filter(Boolean);   // ngôn ngữ giọng đọc cho dropdown
let sheetSpeakerMap = {};   // TÊN giọng → UUID (đa ngôn ngữ), build khi refresh dropdown

// --- Map giá trị tiếng Việt (dropdown) → giá trị nội bộ ---
const SHEET_LANG_MAP = { 'tiếng việt': 'vi', 'việt': 'vi', 'tiếng anh': 'en', 'anh': 'en', 'tiếng nhật': 'ja', 'nhật': 'ja', 'tiếng hàn': 'ko', 'hàn': 'ko', 'tiếng trung': 'zh', 'trung': 'zh', 'tiếng pháp': 'fr', 'pháp': 'fr', 'tiếng tây ban nha': 'es', 'tây ban nha': 'es' };
function sheetMapLang(v, fallback = 'vi') { const t = (v || '').trim(); if (!t) return fallback; return SHEET_LANG_MAP[t.toLowerCase()] || t; }
function sheetMapGenre(v) { const t = (v || '').trim().toLowerCase(); if (t.includes('drama')) return 'drama'; if (t.includes('naze') || t.includes('tại sao') || t.includes('tai sao')) return 'naze'; return t; }
function sheetMapContentType(v) { const t = (v || '').trim().toLowerCase(); if (!t) return 'content'; if (t.includes('việt') || t.includes('viet') || t === 'content_vi') return 'content_vi'; return 'content'; }
// Placeholder dropdown '(không dùng...)' đều bắt đầu bằng '(' → chỉ strip đúng placeholder, không đụng path/tên thật.
function sheetCleanLips(v) { const t = (v || '').trim(); return (!t || t.startsWith('(')) ? '' : t; }
function sheetIsYes(v) { return ['có', 'co', 'yes', 'x', 'true', '1', 'on'].includes((v || '').trim().toLowerCase()); }
// "Giọng đọc" là TÊN giọng (dropdown) → tra UUID theo ngôn ngữ; nếu đã là UUID thì giữ nguyên; '(không...)'/trống = không voice
async function sheetResolveSpeaker(v, lang) {
    const t = (v || '').trim();
    if (!t || t.startsWith('(')) return '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(t)) return t;   // đã là UUID
    if (sheetSpeakerMap[t]) return sheetSpeakerMap[t];                 // map đa ngôn ngữ (build khi refresh)
    try { const r = await getReferenceSpeakers(lang); const m = (r?.data || []).find(s => (s.speaker_name || '').trim() === t); return m ? m.uuid : ''; }
    catch { return ''; }
}

let sheetAuth = null;
try {
    const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'google_sheet.json'), 'utf8'));
    sheetAuth = new JWT({ email: creds.client_email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
} catch (e) { console.warn('[naze-sheet] Không đọc được google_sheet.json → tắt sync sheet:', e.message); }

let sheetTickRunning = false;
let activeSheetJobs = 0;

// Chèn 1 CỘT TRỐNG vật lý vào tab (dịch dữ liệu các cột từ atIndex trở đi sang phải) → thêm cột GIỮA bảng
// mà KHÔNG lệch dữ liệu cột cũ. Phải làm trước setHeaderRow (setHeaderRow chỉ ghi lại nhãn dòng 1, không dời data).
async function insertSheetBlankColumn(sheetId, atIndex) {
    await sheetAuth.request({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
        method: 'POST',
        // inheritFromBefore=true: kế thừa từ cột TRÁI ('Tạo giọng đọc?'), KHÔNG phải cột phải ('Giọng đọc').
        // false sẽ kế thừa dropdown giọng đọc của cột phải → cột tốc độ hiện danh sách giọng (sai). Sau đó vẫn xoá DV.
        data: { requests: [{ insertDimension: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: atIndex, endIndex: atIndex + 1 },
            inheritFromBefore: true,
        } }] },
    });
}

// Xoá data-validation (dropdown) của 1 cột → cột 'Tốc độ đọc' là ô nhập số tự do, không dính dropdown cột kế bên.
async function clearColumnValidation(sheetId, colIndex) {
    if (colIndex < 0) return;
    await sheetAuth.request({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
        method: 'POST',
        data: { requests: [{ setDataValidation: {   // không kèm 'rule' → xoá mọi validation trong range
            range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
        } }] },
    });
}

// Dời 1 CỘT từ vị trí from → to (dùng khi cột 'Tốc độ đọc' lỡ được thêm ở cuối, cần đưa về sau 'Tạo giọng đọc?').
// destinationIndex tính theo toạ độ TRƯỚC khi dời; from>to (dời sang trái) → cột nằm đúng tại `to`.
async function moveSheetColumn(sheetId, from, to) {
    await sheetAuth.request({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
        method: 'POST',
        data: { requests: [{ moveDimension: {
            source: { sheetId, dimension: 'COLUMNS', startIndex: from, endIndex: from + 1 },
            destinationIndex: to,
        } }] },
    });
}

// Tạo project naze/drama + chờ pipeline xong rồi orchestrate auto voice. Trả về true nếu thành công.
// srt = { src, tgt } → chạy chế độ --srt (import phụ đề, không cần GPT sinh nội dung).
function createNazeProjectAndWait({ topic, projectId, targetLang, genre, tweetUrls, voice, srt }) {
    return new Promise((resolve) => {
        try {
            const targetDir = path.join(MEDIA_DIR, projectId);
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            if (voice && (voice.speakerUuid || voice.viSpeakerUuid)) {
                writeVoiceAutoConfig(projectId, { speakerUuid: voice.speakerUuid, contentType: voice.contentType, dictionaryUuids: voice.dictionaryUuids, lips: voice.lips, viSpeakerUuid: voice.viSpeakerUuid, speed: voice.speed });
            }
            let args;
            if (srt && srt.src) {
                // naze_content.js --srt <src> <projectId> [<srtĐích>] <lang> [--genre drama]
                // Thiếu --genre thì SRT luôn chạy như 'naze' → dòng drama trong sheet không cào X, lưu sai thể loại.
                args = ['src/workers/naze_content.js', '--srt', srt.src, projectId];
                if (srt.tgt) args.push(srt.tgt);
                args.push(targetLang || 'vi');
                if (genre === 'drama') args.push('--genre', 'drama');
            } else {
                args = ['src/workers/naze_content.js', topic.trim(), projectId, targetLang || 'vi', genre === 'drama' ? 'drama' : 'naze'];
            }
            const env = { ...process.env };
            if (genre === 'drama' && tweetUrls) env.NAZE_TWEET_URLS = tweetUrls;
            const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'], env });
            child.stdout.on('data', d => process.stdout.write(`[naze-sheet] ${d}`));
            child.stderr.on('data', d => process.stderr.write(`[naze-sheet] ${d}`));
            child.on('exit', async (code) => {
                if (code !== 0) return resolve(false);
                try { await orchestrateAutoVoice(projectId); } catch (e) { console.error('[naze-sheet] orchestrate lỗi:', e.message); }
                resolve(true);
            });
            child.on('error', (e) => { console.error('[naze-sheet] spawn lỗi:', e.message); resolve(false); });
        } catch (e) { console.error('[naze-sheet] createNaze lỗi:', e.message); resolve(false); }
    });
}

// Cập nhật trạng thái 1 dòng theo projectId (reload sheet để tránh row cũ lệch index sau vài phút)
async function setSheetRowStatus(projectId, status, note) {
    try {
        const doc = new GoogleSpreadsheet(SHEET_ID, sheetAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle[SHEET_TAB];
        if (!sheet) return;
        const rows = await sheet.getRows();
        const row = rows.find(r => (r.get(SHEET_COL.projectId) || '').trim() === projectId);
        if (!row) return;
        row.set(SHEET_COL.status, status);
        if (note !== undefined) row.set(SHEET_COL.note, note);
        await row.save();
    } catch (e) { console.error('[naze-sheet] update status lỗi:', e.message); }
}

// Làm mới dropdown (giọng đọc / video mp4 / file srt) cho CẢ tab naze lẫn geo — chỉ gọi API khi danh sách đổi.
let lastDropdownSig = '';
async function refreshSheetDropdowns(doc) {
    try {
        const scan = (ext) => { try { return fs.readdirSync(SHEET_FILE_DIR).filter(f => f.toLowerCase().endsWith(ext)).sort().slice(0, 50).map(f => path.join(SHEET_FILE_DIR, f)); } catch { return []; } };
        const mp4s = scan('.mp4');
        const srts = scan('.srt');
        // Giọng đọc đa ngôn ngữ (mặc định vi + ja) → tên duy nhất + map tên→UUID
        const speakers = [];
        const viSpeakers = [];   // riêng giọng tiếng Việt cho cột 'Giọng đọc (tiếng Việt)'
        const map = {};
        for (const lg of SHEET_SPEAKER_LANGS) {
            try {
                const r = await getReferenceSpeakers(lg);
                for (const s of (r?.data || [])) {
                    const nm = (s.speaker_name || '').trim();
                    if (nm && !map[nm]) { map[nm] = s.uuid; speakers.push(nm); }
                    if (lg === 'vi' && nm && !viSpeakers.includes(nm)) viSpeakers.push(nm);
                }
            } catch {}
        }
        if (speakers.length) sheetSpeakerMap = map;          // cập nhật map khi lấy được (kể cả khi sig chưa đổi)
        const sig = JSON.stringify({ mp4s, srts, speakers, viSpeakers });
        if (sig === lastDropdownSig) return;                 // không đổi → khỏi gọi API
        const dv = (sheetId, col, values) => ({ setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: col, endColumnIndex: col + 1 },
            rule: { condition: { type: 'ONE_OF_LIST', values: values.map(v => ({ userEnteredValue: String(v) })) }, strict: false, showCustomUi: true },
        } });
        const requests = [];
        // Tab naze — index TÍNH ĐỘNG theo SHEET_HEADERS (chèn cột 'Tốc độ đọc' làm các cột sau dịch phải,
        // nên hardcode index sẽ trỏ sai; indexOf luôn đúng dù đổi thứ tự cột).
        const nz = doc.sheetsByTitle[SHEET_TAB];
        if (nz) {
            const cLips = SHEET_HEADERS.indexOf(SHEET_COL.lipsVideo);
            const cSrtSrc = SHEET_HEADERS.indexOf(SHEET_COL.srtSrc);
            const cSrtTgt = SHEET_HEADERS.indexOf(SHEET_COL.srtTgt);
            const cSpk = SHEET_HEADERS.indexOf(SHEET_COL.speaker);
            if (cLips >= 0) requests.push(dv(nz.sheetId, cLips, [...mp4s, '(không dùng lips)']));
            if (cSrtSrc >= 0) requests.push(dv(nz.sheetId, cSrtSrc, [...srts, '(không dùng SRT)']));
            if (cSrtTgt >= 0) requests.push(dv(nz.sheetId, cSrtTgt, [...srts, '(không dùng SRT)']));
            if (cSpk >= 0 && speakers.length) requests.push(dv(nz.sheetId, cSpk, [...speakers, '(không tạo voice)']));
            if (viSpeakers.length && SHEET_COL_SPEAKER_VI_IDX >= 0) requests.push(dv(nz.sheetId, SHEET_COL_SPEAKER_VI_IDX, [...viSpeakers, '(không tạo voice VN)']));
        }
        // Tab geo — index TÍNH ĐỘNG theo GEO_SHEET_HEADERS (đã chèn 'Ngôn ngữ đích' ở cột C nên
        // các cột dịch phải; hardcode index cũ sẽ trỏ sai cột).
        const geo = doc.sheetsByTitle[GEO_SHEET_TAB];
        if (geo) {
            const cLips = GEO_SHEET_HEADERS.indexOf(SHEET_COL.lipsVideo);
            const cSpk = GEO_SHEET_HEADERS.indexOf(SHEET_COL.speaker);
            const cLang = GEO_SHEET_HEADERS.indexOf(GEO_COL.lang);
            if (cLips >= 0) requests.push(dv(geo.sheetId, cLips, [...mp4s, '(không dùng lips)']));
            if (cSpk >= 0 && speakers.length) requests.push(dv(geo.sheetId, cSpk, [...speakers, '(không tạo voice)']));
            if (cLang >= 0) requests.push(dv(geo.sheetId, cLang, GEO_LANG_CHOICES));   // dropdown ngôn ngữ (giống modal)
        }
        if (!requests.length) return;
        await sheetAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, method: 'POST', data: { requests } });
        lastDropdownSig = sig;
        console.log(`[sheet] Cập nhật dropdown (naze+geo) theo ${SHEET_FILE_DIR}: ${mp4s.length} mp4, ${srts.length} srt, ${speakers.length} giọng.`);
    } catch (e) { console.error('[sheet] refresh dropdown lỗi:', e.message); }
}

async function sheetPollTick() {
    if (!sheetAuth || sheetTickRunning) return;
    sheetTickRunning = true;
    try {
        const doc = new GoogleSpreadsheet(SHEET_ID, sheetAuth);
        await doc.loadInfo();
        let sheet = doc.sheetsByTitle[SHEET_TAB];
        if (!sheet) {
            sheet = await doc.addSheet({ title: SHEET_TAB, headerValues: SHEET_HEADERS });
            console.log(`[naze-sheet] Đã tạo tab '${SHEET_TAB}' — điền dữ liệu để tự tạo dự án.`);
        }
        // Tab cũ chưa có cột 'Giọng đọc (tiếng Việt)' → thêm header (append cuối, không đụng dữ liệu cột cũ)
        try {
            await sheet.loadHeaderRow();
            const hv = sheet.headerValues;
            // Cột 'Tốc độ đọc' nằm GIỮA bảng (ngay sau 'Tạo giọng đọc?') → phải chèn/dời cột VẬT LÝ để data cột cũ
            // dịch đúng, rồi mới setHeaderRow. Chỉ setHeaderRow sẽ dán nhãn đè lên data giọng/từ điển → lệch hết.
            const wantIdx = hv.indexOf(SHEET_COL.voiceOn) + 1;   // vị trí đích của 'Tốc độ đọc'
            const curIdx = hv.indexOf(SHEET_COL.speed);
            if (wantIdx > 0 && curIdx < 0) {
                try { await insertSheetBlankColumn(sheet.sheetId, wantIdx); } catch (e) { console.error('[naze-sheet] chèn cột tốc độ lỗi:', e.message); }
                await sheet.setHeaderRow(SHEET_HEADERS);
                console.log(`[naze-sheet] Đã chèn cột '${SHEET_COL.speed}' ngay sau '${SHEET_COL.voiceOn}' ở tab '${SHEET_TAB}'.`);
            } else if (wantIdx > 0 && curIdx >= 0 && curIdx !== wantIdx) {
                // Đã có nhưng sai chỗ (vd bản trước lỡ thêm ở cuối) → dời về đúng sau 'Tạo giọng đọc?'
                try { await moveSheetColumn(sheet.sheetId, curIdx, wantIdx); } catch (e) { console.error('[naze-sheet] dời cột tốc độ lỗi:', e.message); }
                await sheet.setHeaderRow(SHEET_HEADERS);
                console.log(`[naze-sheet] Đã dời cột '${SHEET_COL.speed}' về sau '${SHEET_COL.voiceOn}' ở tab '${SHEET_TAB}'.`);
            } else if (!hv.includes(SHEET_COL.speakerVi)) {
                await sheet.setHeaderRow(SHEET_HEADERS);
                console.log(`[naze-sheet] Đã thêm cột '${SHEET_COL.speakerVi}' vào tab '${SHEET_TAB}'.`);
            }
            // Cột tốc độ là ô nhập số → luôn xoá dropdown (kể cả cột đã lỡ kế thừa dropdown giọng của cột kế).
            await clearColumnValidation(sheet.sheetId, SHEET_HEADERS.indexOf(SHEET_COL.speed)).catch(() => {});
        } catch (e) { console.error('[naze-sheet] ensure header lỗi:', e.message); }
        await refreshSheetDropdowns(doc);                    // đồng bộ dropdown (naze+geo) với file hiện có mỗi nhịp
        const rows = await sheet.getRows();
        for (const row of rows) {
            if (activeSheetJobs >= MAX_SHEET_JOBS) break;
            const status = (row.get(SHEET_COL.status) || '').trim().toUpperCase();
            if (status !== 'QUEUE') continue;          // CHỈ xử lý đúng QUEUE (trống/MẪU/DONE/... bỏ qua)
            const topic = (row.get(SHEET_COL.topic) || '').trim();
            const srtSrc = sheetCleanLips(row.get(SHEET_COL.srtSrc));   // dùng chung cleaner ('(không...)'/trống → '')
            const srtTgt = sheetCleanLips(row.get(SHEET_COL.srtTgt));
            const isSrt = !!srtSrc;
            if (!isSrt && !topic) continue;                       // dòng trống thật → bỏ qua (cần topic HOẶC file SRT)
            // SRT dùng cho CẢ 'Tại sao' lẫn 'Drama' (drama giờ nhận 2 file SRT thay ô 'Chủ đề')
            // → luôn đọc cột Thể loại, kể cả dòng SRT. Trước đây dòng SRT bị ép cứng thành naze.
            const genre = sheetMapGenre(row.get(SHEET_COL.genre)) || 'naze';
            if (genre !== 'naze' && genre !== 'drama') {
                row.set(SHEET_COL.status, 'ERROR'); row.set(SHEET_COL.note, "Thể loại phải là 'Tại sao' hoặc 'Drama'"); await row.save(); continue;
            }
            if (isSrt) {
                if (!fs.existsSync(srtSrc)) {
                    row.set(SHEET_COL.status, 'ERROR'); row.set(SHEET_COL.note, 'File SRT (nguồn) không tồn tại: ' + srtSrc); await row.save(); continue;
                }
                if (srtTgt && !fs.existsSync(srtTgt)) {
                    row.set(SHEET_COL.status, 'ERROR'); row.set(SHEET_COL.note, 'File SRT (đích) không tồn tại: ' + srtTgt); await row.save(); continue;
                }
            } else if (genre === 'drama') {
                // Drama giờ chạy bằng 2 file SRT → dòng drama chỉ có 'Chủ đề' là thiếu đầu vào
                row.set(SHEET_COL.status, 'ERROR');
                row.set(SHEET_COL.note, 'Drama cần File SRT (nguồn) — ô Chủ đề không còn dùng cho drama');
                await row.save(); continue;
            }
            const projectId = (row.get(SHEET_COL.projectId) || '').trim() || stampId('naze_');
            const targetLang = sheetMapLang(row.get(SHEET_COL.lang));
            const tweetUrls = (row.get(SHEET_COL.tweets) || '').trim();
            // Giọng đọc & Lips sync là TUỲ CHỌN Có/Không — chỉ khi 'Có' mới đọc giá trị.
            const voiceOn = sheetIsYes(row.get(SHEET_COL.voiceOn));
            const lipsOn = sheetIsYes(row.get(SHEET_COL.lipsOn));
            const speed = sheetParseSpeed(row.get(SHEET_COL.speed));   // tốc độ đọc (áp dụng cho cả voice chính & voice VN)
            const errRow = async (msg) => { row.set(SHEET_COL.status, 'ERROR'); row.set(SHEET_COL.note, msg); await row.save(); };
            let voice = null;
            if (voiceOn) {
                const speakerUuid = await sheetResolveSpeaker(row.get(SHEET_COL.speaker), targetLang);
                if (!speakerUuid) { await errRow('Đã chọn Tạo giọng đọc = Có nhưng chưa chọn Giọng đọc hợp lệ'); continue; }
                const voiceContentType = sheetMapContentType(row.get(SHEET_COL.voiceType));
                const dictionaryUuids = (row.get(SHEET_COL.dict) || '').split(',').map(s => s.trim()).filter(Boolean);
                let lips = null;
                if (lipsOn) {
                    if (voiceContentType !== 'content') { await errRow('Lips sync chỉ chạy khi Loại giọng = Target (ngôn ngữ đích)'); continue; }
                    // Ô trống -> tự lấy video của THỨ hôm nay trong thư viện (theo thể loại của dòng)
                    const lipsVideo = resolveLipsVideo(sheetCleanLips(row.get(SHEET_COL.lipsVideo)), genre === 'drama' ? 'drama' : 'naze');
                    if (!lipsVideo) { await errRow('Bật Lips sync nhưng chưa chọn Video khuôn mặt và thư viện chưa có video cho thứ hôm nay'); continue; }
                    lips = { video: lipsVideo, guidanceScale: parseFloat(row.get(SHEET_COL.lipsGuidance)) || 2.2 };
                }
                voice = { speakerUuid, contentType: voiceContentType, dictionaryUuids, lips, speed };
            } else if (lipsOn) {
                await errRow('Muốn Lips sync thì phải bật Tạo giọng đọc = Có'); continue;
            }
            // Giọng đọc tiếng Việt (TUỲ CHỌN, ĐỘC LẬP với 'Tạo giọng đọc?') → tạo thêm 1 voice content_vi song song
            const viRaw = (row.get(SHEET_COL.speakerVi) || '').trim();
            if (viRaw && !viRaw.startsWith('(')) {
                const viSpeakerUuid = await sheetResolveSpeaker(viRaw, 'vi');
                if (!viSpeakerUuid) { await errRow('Đã chọn Giọng đọc (tiếng Việt) nhưng không hợp lệ'); continue; }
                if (!(voice && voice.contentType === 'content_vi')) {   // voice chính đã là VN thì khỏi tạo trùng
                    voice = voice || { speakerUuid: '', contentType: 'content', dictionaryUuids: [], lips: null, speed };
                    voice.viSpeakerUuid = viSpeakerUuid;
                }
            }
            // Đánh dấu đang triển khai + ghi projectId NGAY (để tick sau bỏ qua + tra cứu khi xong)
            row.set(SHEET_COL.projectId, projectId);
            row.set(SHEET_COL.status, 'PROCESSING');
            row.set(SHEET_COL.note, '');
            await row.save();
            console.log(`[naze-sheet] ▶ Tạo ${isSrt ? 'SRT' : genre} '${projectId}': ${isSrt ? srtSrc : topic.slice(0, 50)}`);
            activeSheetJobs++;
            createNazeProjectAndWait({ topic, projectId, targetLang, genre, tweetUrls, voice, srt: isSrt ? { src: srtSrc, tgt: srtTgt } : null })
                .then(ok => setSheetRowStatus(projectId, ok ? 'DONE' : 'ERROR', ok ? '' : 'Pipeline lỗi (xem log server)'))
                .catch(() => setSheetRowStatus(projectId, 'ERROR', 'Lỗi không xác định'))
                .finally(() => { activeSheetJobs--; });
        }
    } catch (e) { console.error('[naze-sheet] poll lỗi:', e.message); }
    finally { sheetTickRunning = false; }
}

if (sheetAuth && process.env.NAZE_SHEET_SYNC !== 'off') {
    setInterval(sheetPollTick, SHEET_POLL_MS);
    sheetPollTick();
    console.log(`[naze-sheet] Bật đồng bộ Google Sheet tab '${SHEET_TAB}' mỗi ${SHEET_POLL_MS / 1000}s (tắt: NAZE_SHEET_SYNC=off).`);
}

// ============================================================
// GOOGLE SHEET → monitor ĐỊA CHÍNH TRỊ (poll mỗi 2 phút)
// Tab 'dia_chinh_tri'. Mỗi dòng = 1 chủ đề theo dõi liên tục (KHÔNG đánh DONE).
// Cột: Chủ đề | Nguồn | Bật? | Lần chạy gần nhất | Tin mới lần gần nhất | Tổng tin đã lấy | Ghi chú
// Mỗi lần: crawl Google News RSS Nhật (gl=JP,hl=ja) when:1d, LỌC tin đã xử lý (rss_seen/<hash>.json),
// nếu có tin MỚI → xào 1 project (proj_<ts>) qua process_content.js; không có tin mới → bỏ qua.
// ============================================================
const GEO_SHEET_TAB = 'dia_chinh_tri';
const GEO_COL = { topic: 'Chủ đề', sources: 'Nguồn', on: 'Bật?', lang: 'Ngôn ngữ đích', xAccounts: 'Account X', lastRun: 'Lần chạy gần nhất', lastNew: 'Tin mới lần gần nhất', total: 'Tổng tin đã lấy', note: 'Ghi chú' };
// Chọn ngôn ngữ đích cho dropdown cột 'Ngôn ngữ đích' (giống modal). Tên khớp SHEET_LANG_MAP.
// Ô trống → 'ja' (mặc định geo). Đặt Tiếng Nhật đầu cho tiện.
const GEO_LANG_CHOICES = ['Tiếng Nhật', 'Tiếng Việt', 'Tiếng Anh', 'Tiếng Hàn', 'Tiếng Trung', 'Tiếng Pháp', 'Tiếng Tây Ban Nha'];
// Cột voice/lips DÙNG CHUNG header với tab naze (SHEET_COL) → tái dùng helper map/validate.
// 'Ngôn ngữ đích' ở cột C (index 2). 'Account X' để CUỐI. Thứ tự này PHẢI khớp thứ tự vật lý
// trên sheet — read theo tên header nên đọc không lệch, nhưng setHeaderRow (self-heal) ghi theo
// thứ tự mảng này, nên đổi thứ tự ở đây mà không dịch cột thật sẽ xô lệch dữ liệu.
const GEO_SHEET_HEADERS = [GEO_COL.topic, GEO_COL.sources, GEO_COL.lang, GEO_COL.on,
    SHEET_COL.voiceOn, SHEET_COL.speed, SHEET_COL.speaker, SHEET_COL.voiceType, SHEET_COL.dict,
    SHEET_COL.lipsOn, SHEET_COL.lipsVideo, SHEET_COL.lipsGuidance,
    GEO_COL.lastRun, GEO_COL.lastNew, GEO_COL.total, GEO_COL.note, GEO_COL.xAccounts];
// LỊCH CHẠY: 2 lần/ngày, mỗi lần tạo tối đa GEO_PROJECTS_PER_RUN dự án (mặc định 2) → 4 dự án/ngày.
// Tick mỗi phút chỉ để DÒ tới khung giờ; ngoài khung giờ thì không làm gì (budget = 0).
const GEO_POLL_MS = 60 * 1000;
const GEO_RUN_TIMES = (process.env.GEO_RUN_TIMES || '07:00,19:00')
    .split(',').map(s => s.trim()).filter(s => /^\d{1,2}:\d{2}$/.test(s));
const GEO_PROJECTS_PER_RUN = Math.max(1, parseInt(process.env.GEO_PROJECTS_PER_RUN, 10) || 2);
const MAX_GEO_JOBS = 1;                            // geo nặng (RSS+FlareSolverr+GPT) → chạy 1 lúc
const GEO_SEEN_DIR = path.join(__dirname, 'rss_seen');
let geoTickRunning = false;
let activeGeoJobs = 0;
// Số dự án CÒN PHẢI TẠO của khung giờ đang mở. 0 = ngoài giờ, không chạy gì.
// Đếm theo dự án THẬT SỰ tạo được (code 0), nên chủ đề nào không có tin mới sẽ không phí suất.
let geoSlotBudget = 0;
const geoFiredSlots = new Set();                   // 'YYYY-M-D 07:00' đã kích hoạt (chống bắn lại trong cùng phút)
const geoTriedThisSlot = new Set();                // chủ đề đã thử trong khung giờ này (hết thì đóng khung giờ)
const geoRunning = new Set();                      // key chủ đề đang chạy (chống chồng khi run > 2 phút)
// Lần chạy gần nhất theo chủ đề. Mỗi tick chỉ chạy được MAX_GEO_JOBS dòng, nên phải XOAY VÒNG:
// ưu tiên dòng lâu chưa chạy nhất (chưa chạy lần nào = 0 → chạy trước). Không có cái này thì tick nào
// cũng bắt đầu từ đầu sheet → dòng 1 chạy mãi, dòng 2 trở đi không bao giờ tới lượt.
const geoLastRun = new Map();
const geoSeenPath = (topic) => path.join(GEO_SEEN_DIR, crypto.createHash('md5').update(topic).digest('hex').slice(0, 12) + '.json');
const nowVN = () => new Date().toLocaleString('vi-VN');
// Đọc lại mốc chạy từ cột 'Lần chạy gần nhất' (do nowVN() ghi: "14:18:34 14/7/2026").
// Nhờ vậy restart server KHÔNG làm mất thứ tự xoay vòng — dòng crawl lâu rồi vẫn được ưu tiên.
// Chấp nhận cả kiểu ngày-trước ("14/7/2026 14:18:34") phòng khi Google Sheets định dạng lại ô.
function parseVN(s) {
    const t = String(s || '').trim();
    if (!t) return 0;
    let m = t.match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(+m[6], +m[5] - 1, +m[4], +m[1], +m[2], +m[3]).getTime() || 0;
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime() || 0;
    const d = Date.parse(t);
    return Number.isFinite(d) ? d : 0;   // không đọc được → coi như chưa chạy (được ưu tiên chạy trước)
}

// Chạy 1 lần monitor cho 1 chủ đề: spawn process_content.js (JP RSS, when:1d, dedup theo seenFile). Trả {code,new,projectId}.
function runGeoMonitor({ topic, sources, xAccounts, targetLang, voice }) {
    return new Promise((resolve) => {
        try {
            const projectId = stampId('proj_');   // process_content.js tự tạo thư mục project khi saveToDb (chỉ khi có tin mới)
            // Ô 'Chủ đề' có thể chứa NHIỀU keyword (mỗi dòng / phẩy 1 keyword) → tách ra để search TỪNG cái,
            // không dồn thành 1 query dài dính liền (dồn lại thì gần như 0 bài).
            const geoKeywords = topic.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
            const args = ['src/workers/process_content.js', '--projectId', projectId,
                '--keywords', JSON.stringify(geoKeywords.length ? geoKeywords : [topic]), '--sources', JSON.stringify(sources),
                '--country', 'JP', '--clang', 'ja', '--targetLang', targetLang || 'ja',
                '--days', '1', '--content', topic, '--seenFile', geoSeenPath(topic)];
            if (xAccounts && xAccounts.length) args.push('--xAccounts', JSON.stringify(xAccounts));
            let out = '';
            const child = spawn('node', args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', d => { out += d.toString(); process.stdout.write(`[geo-sheet] ${d}`); });
            child.stderr.on('data', d => process.stderr.write(`[geo-sheet] ${d}`));
            child.on('exit', (code) => {
                let res = { new: 0, projectId: null };
                const m = out.match(/\[geo-result\]\s*(\{.*\})/);
                if (m) { try { res = JSON.parse(m[1]); } catch {} }
                // Có tin mới (project vừa tạo) + bật voice → gen voice (+lips) như tab naze
                if (code === 0 && voice && voice.speakerUuid) {
                    try { writeVoiceAutoConfig(projectId, voice); } catch (e) { console.error('[geo-sheet] writeVoiceAutoConfig lỗi:', e.message); }
                    orchestrateAutoVoice(projectId).catch(e => console.error('[geo-sheet] orchestrate lỗi:', e.message));
                }
                resolve({ code, ...res });
            });
            child.on('error', (e) => { console.error('[geo-sheet] spawn lỗi:', e.message); resolve({ code: 1, new: 0, projectId: null }); });
        } catch (e) { console.error('[geo-sheet] run lỗi:', e.message); resolve({ code: 1, new: 0, projectId: null }); }
    });
}

// Cập nhật 1 dòng geo theo Chủ đề (reload để tránh row cũ lệch index)
async function setGeoRow(topic, fields) {
    try {
        const doc = new GoogleSpreadsheet(SHEET_ID, sheetAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle[GEO_SHEET_TAB];
        if (!sheet) return;
        const rows = await sheet.getRows();
        const row = rows.find(r => (r.get(GEO_COL.topic) || '').trim() === topic);
        if (!row) return;
        for (const [k, v] of Object.entries(fields)) row.set(k, v);
        await row.save();
    } catch (e) { console.error('[geo-sheet] update row lỗi:', e.message); }
}

// Tới khung giờ chạy chưa? Nếu tới thì MỞ khung giờ (cấp budget) — mỗi khung giờ chỉ mở 1 lần/ngày.
function geoOpenSlotIfDue() {
    const d = new Date();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    for (const t of GEO_RUN_TIMES) {
        const norm = t.padStart(5, '0');
        const key = `${day} ${norm}`;
        if (hhmm === norm && !geoFiredSlots.has(key)) {
            geoFiredSlots.add(key);
            geoSlotBudget = GEO_PROJECTS_PER_RUN;
            geoTriedThisSlot.clear();
            console.log(`[geo-sheet] ⏰ Khung giờ ${norm} — mở lượt, tạo tối đa ${GEO_PROJECTS_PER_RUN} dự án.`);
        }
    }
}

async function geoSheetTick() {
    if (!sheetAuth || geoTickRunning) return;
    geoOpenSlotIfDue();
    if (geoSlotBudget <= 0) return;              // ngoài khung giờ / đã đủ chỉ tiêu → nghỉ
    geoTickRunning = true;
    try {
        const doc = new GoogleSpreadsheet(SHEET_ID, sheetAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle[GEO_SHEET_TAB];
        if (!sheet) { await doc.addSheet({ title: GEO_SHEET_TAB, headerValues: GEO_SHEET_HEADERS }); console.log(`[geo-sheet] Đã tạo tab '${GEO_SHEET_TAB}'.`); return; }
        // Tab cũ thiếu cột mới → thêm header. Riêng 'Tốc độ đọc' nằm GIỮA bảng (sau 'Tạo giọng đọc?')
        // nên phải chèn cột vật lý trước để data cột cũ dịch phải, rồi setHeaderRow mới không lệch.
        try {
            await sheet.loadHeaderRow();
            const hv = sheet.headerValues;
            const wantIdx = hv.indexOf(SHEET_COL.voiceOn) + 1;   // vị trí đích của 'Tốc độ đọc'
            const curIdx = hv.indexOf(SHEET_COL.speed);
            if (wantIdx > 0 && curIdx < 0) {
                try { await insertSheetBlankColumn(sheet.sheetId, wantIdx); } catch (e) { console.error('[geo-sheet] chèn cột tốc độ lỗi:', e.message); }
            } else if (wantIdx > 0 && curIdx >= 0 && curIdx !== wantIdx) {
                try { await moveSheetColumn(sheet.sheetId, curIdx, wantIdx); } catch (e) { console.error('[geo-sheet] dời cột tốc độ lỗi:', e.message); }
            }
            if (!GEO_SHEET_HEADERS.every(h => hv.includes(h)) || (curIdx >= 0 && curIdx !== wantIdx)) {
                const miss = GEO_SHEET_HEADERS.filter(h => !hv.includes(h));
                await sheet.setHeaderRow(GEO_SHEET_HEADERS);
                console.log(`[geo-sheet] Đã đồng bộ header${miss.length ? ' (thêm [' + miss.join(', ') + '])' : ''} ở tab '${GEO_SHEET_TAB}'.`);
            }
            // Cột tốc độ là ô nhập số → luôn xoá dropdown (kể cả cột đã lỡ kế thừa dropdown giọng của cột kế).
            await clearColumnValidation(sheet.sheetId, GEO_SHEET_HEADERS.indexOf(SHEET_COL.speed)).catch(() => {});
        } catch (e) { console.error('[geo-sheet] ensure header lỗi:', e.message); }
        const rows = await sheet.getRows();

        // Xếp hàng CHỜ: bỏ dòng trống / tắt / đang chạy, rồi sắp theo lần chạy gần nhất (cũ nhất trước).
        // Dòng chưa chạy lần nào có mốc 0 → luôn được ưu tiên, nên hết 1 lượt từ trên xuống dưới rồi mới quay lại dòng 1.
        const queue = rows
            .map((row, i) => {
                const topic = (row.get(GEO_COL.topic) || '').trim();
                // Chưa có mốc trong RAM (server vừa restart) → lấy từ cột 'Lần chạy gần nhất' của sheet
                if (topic && !geoLastRun.has(topic)) {
                    const ts = parseVN(row.get(GEO_COL.lastRun));
                    if (ts) geoLastRun.set(topic, ts);
                }
                return { row, i, topic };
            })
            .filter(({ row, topic }) => {
                if (!topic) return false;
                const on = (row.get(GEO_COL.on) || '').trim().toLowerCase();
                if (['không', 'khong', 'no', 'off', 'tắt', 'tat'].includes(on)) return false;   // tạm dừng (trống = bật)
                if (geoRunning.has(geoSeenPath(topic))) return false;                            // đang chạy dở → bỏ qua nhịp này
                return !geoTriedThisSlot.has(topic);                                             // đã thử trong lượt này → không thử lại
            })
            .sort((a, b) => ((geoLastRun.get(a.topic) || 0) - (geoLastRun.get(b.topic) || 0)) || (a.i - b.i));

        // Hết chủ đề để thử mà chưa đủ chỉ tiêu → đóng lượt, chờ khung giờ sau (tránh quay vòng vô ích)
        if (!queue.length && !activeGeoJobs) {
            if (geoSlotBudget > 0) console.log(`[geo-sheet] Hết chủ đề để thử, còn thiếu ${geoSlotBudget} dự án → đóng lượt, chờ khung giờ sau.`);
            geoSlotBudget = 0;
            return;
        }
        if (queue.length) {
            const waiting = queue.filter(q => !geoLastRun.has(q.topic)).length;
            console.log(`[geo-sheet] ${queue.length} dòng sẵn sàng (${waiting} chưa chạy lần nào) — còn cần ${geoSlotBudget} dự án`);
        }

        for (const { row, topic } of queue) {
            if (activeGeoJobs >= MAX_GEO_JOBS || geoSlotBudget <= 0) break;
            geoTriedThisSlot.add(topic);
            await startGeoRow(row, topic, { countsToBudget: true });
        }
    } catch (e) { console.error('[geo-sheet] poll lỗi:', e.message); }
    finally { geoTickRunning = false; }
}

// Chạy 1 DÒNG sheet địa chính trị. Dùng chung cho lịch tự động và nút bấm tay (/api/geo-sheet/run).
// countsToBudget=false → chạy tay, KHÔNG ăn vào chỉ tiêu 2 dự án/lượt của lịch.
async function startGeoRow(row, topic, { countsToBudget = false } = {}) {
    const key = geoSeenPath(topic);
    if (geoRunning.has(key)) return { started: false, reason: 'Chủ đề này đang chạy dở' };
    // Nhiều nguồn: mỗi nguồn 1 dòng (hoặc phẩy). Bỏ http/path/www → domain thuần cho site: filter.
    const sources = (row.get(GEO_COL.sources) || '').split(/[\n,]/).map(s => s.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
    // Account X: mỗi dòng/phẩy 1 account (bỏ @ và URL x.com/twitter.com → username thuần).
    const xAccounts = (row.get(GEO_COL.xAccounts) || '').split(/[\n,]/).map(s => s.trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?]/)[0]).filter(Boolean);
    // Ngôn ngữ đích: ô trống → tiếng Nhật (ja). Điền 'Tiếng Việt'/vi... → theo đó.
    const targetLang = sheetMapLang(row.get(GEO_COL.lang), 'ja');
    const prevTotal = parseInt(row.get(GEO_COL.total)) || 0;
    // Voice + lips (tuỳ chọn, giống tab naze). Bật voice mà chưa chọn giọng hợp lệ → vẫn crawl, chỉ bỏ voice.
    let voice = null;
    if (sheetIsYes(row.get(SHEET_COL.voiceOn))) {
        const speakerUuid = await sheetResolveSpeaker(row.get(SHEET_COL.speaker), 'vi');
        if (speakerUuid) {
            const voiceContentType = sheetMapContentType(row.get(SHEET_COL.voiceType));
            const dictionaryUuids = (row.get(SHEET_COL.dict) || '').split(',').map(s => s.trim()).filter(Boolean);
            const speed = sheetParseSpeed(row.get(SHEET_COL.speed));   // tốc độ đọc (ttsmin)
            let lips = null;
            if (sheetIsYes(row.get(SHEET_COL.lipsOn)) && voiceContentType === 'content') {
                // Ô trống -> tự lấy video của THỨ hôm nay trong thư viện geo
                const lipsVideo = resolveLipsVideo(sheetCleanLips(row.get(SHEET_COL.lipsVideo)), 'geo');
                if (lipsVideo) lips = { video: lipsVideo, guidanceScale: parseFloat(row.get(SHEET_COL.lipsGuidance)) || 2.2 };
            }
            voice = { speakerUuid, contentType: voiceContentType, dictionaryUuids, lips, speed };
        } else {
            console.warn(`[geo-sheet] '${topic}': bật Tạo giọng đọc nhưng chưa chọn Giọng đọc hợp lệ → bỏ qua voice.`);
        }
    }
    geoRunning.add(key); activeGeoJobs++;
    geoLastRun.set(topic, Date.now());   // đánh dấu NGAY để dòng này lùi xuống cuối hàng, nhường lượt dòng sau
    setGeoRow(topic, { [GEO_COL.note]: '⏳ Đang crawl...', [GEO_COL.lastRun]: nowVN() });
    console.log(`[geo-sheet] ▶ '${topic}'${countsToBudget ? '' : ' (chạy tay)'} (nguồn: ${sources.join(',') || 'tất cả'}${voice ? ', +voice' + (voice.lips ? '+lips' : '') : ''})`);
    runGeoMonitor({ topic, sources, xAccounts, targetLang, voice })
        .then(res => {
            // Chỉ trừ chỉ tiêu khi THẬT SỰ tạo được dự án — chủ đề không có tin mới không phí suất.
            if (res.code === 0 && countsToBudget) {
                geoSlotBudget = Math.max(0, geoSlotBudget - 1);
                console.log(`[geo-sheet] ✅ '${topic}' xong — còn cần ${geoSlotBudget} dự án cho lượt này.`);
            }
            if (res.code === 0) setGeoRow(topic, { [GEO_COL.lastRun]: nowVN(), [GEO_COL.lastNew]: res.new, [GEO_COL.total]: prevTotal + (res.new || 0), [GEO_COL.note]: `✅ ${res.new} tin mới → ${res.projectId || ''}` });
            else if (res.code === 2) setGeoRow(topic, { [GEO_COL.lastRun]: nowVN(), [GEO_COL.lastNew]: 0, [GEO_COL.note]: 'Không có tin mới' });
            else setGeoRow(topic, { [GEO_COL.lastRun]: nowVN(), [GEO_COL.note]: '❌ Lỗi (xem log server)' });
        })
        .finally(() => { geoRunning.delete(key); activeGeoJobs--; geoLastRun.set(topic, Date.now()); });
    return { started: true };
}

// ---- Xem + chạy tay 1 dòng sheet Địa chính trị (không cần chờ khung giờ) ----
app.get('/api/geo-sheet/rows', async (req, res) => {
    if (!sheetAuth) return res.status(503).json({ error: 'Chưa cấu hình Google Sheet' });
    try {
        const doc = new GoogleSpreadsheet(SHEET_ID, sheetAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle[GEO_SHEET_TAB];
        if (!sheet) return res.json({ rows: [], runTimes: GEO_RUN_TIMES, perRun: GEO_PROJECTS_PER_RUN });
        const rows = await sheet.getRows();
        const out = rows.map((row, i) => {
            const topic = (row.get(GEO_COL.topic) || '').trim();
            if (!topic) return null;
            const on = (row.get(GEO_COL.on) || '').trim().toLowerCase();
            return {
                index: i, topic, onRaw: (row.get(GEO_COL.on) || ''),
                enabled: !['không', 'khong', 'no', 'off', 'tắt', 'tat'].includes(on),
                sources: (row.get(GEO_COL.sources) || '').trim(),
                lang: (row.get(GEO_COL.lang) || '').trim(),
                xAccounts: (row.get(GEO_COL.xAccounts) || '').trim(),
                lastRun: (row.get(GEO_COL.lastRun) || '').trim(),
                lastNew: (row.get(GEO_COL.lastNew) || '').trim(),
                total: (row.get(GEO_COL.total) || '').trim(),
                note: (row.get(GEO_COL.note) || '').trim(),
                voiceOn: sheetIsYes(row.get(SHEET_COL.voiceOn)),
                lipsOn: sheetIsYes(row.get(SHEET_COL.lipsOn)),
                running: geoRunning.has(geoSeenPath(topic)),
            };
        }).filter(Boolean);
        res.json({ rows: out, runTimes: GEO_RUN_TIMES, perRun: GEO_PROJECTS_PER_RUN, activeJobs: activeGeoJobs, maxJobs: MAX_GEO_JOBS });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/geo-sheet/run', async (req, res) => {
    if (!sheetAuth) return res.status(503).json({ error: 'Chưa cấu hình Google Sheet' });
    const { topic } = req.body || {};
    if (!topic) return res.status(400).json({ error: 'Thiếu topic' });
    if (activeGeoJobs >= MAX_GEO_JOBS) return res.status(409).json({ error: `Đang có ${activeGeoJobs} job geo chạy (tối đa ${MAX_GEO_JOBS}) — thử lại sau` });
    try {
        const doc = new GoogleSpreadsheet(SHEET_ID, sheetAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle[GEO_SHEET_TAB];
        if (!sheet) return res.status(404).json({ error: `Không thấy tab '${GEO_SHEET_TAB}'` });
        const rows = await sheet.getRows();
        const row = rows.find(r => (r.get(GEO_COL.topic) || '').trim() === String(topic).trim());
        if (!row) return res.status(404).json({ error: 'Không thấy chủ đề trong sheet' });
        const r = await startGeoRow(row, String(topic).trim(), { countsToBudget: false });
        if (!r.started) return res.status(409).json({ error: r.reason || 'Không khởi chạy được' });
        res.json({ success: true, topic });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

if (sheetAuth && process.env.GEO_SHEET_SYNC !== 'off') {
    setInterval(geoSheetTick, GEO_POLL_MS);
    console.log(`[geo-sheet] Bật monitor Địa chính trị tab '${GEO_SHEET_TAB}': chạy lúc ${GEO_RUN_TIMES.join(' & ')} mỗi ngày, `
        + `${GEO_PROJECTS_PER_RUN} dự án/lượt (tổng ${GEO_RUN_TIMES.length * GEO_PROJECTS_PER_RUN}/ngày).`);
}

// Dọn row kẹt status='crawling' từ lần chạy trước: restart server giết mọi crawl con (spawn từ server),
// nên khi server khởi động lại thì không còn crawl nào thật sự chạy → mọi 'crawling' đều là rác.
// Không xoá thì loadPosts() đọc lại DB sẽ hiện spinner "ma" trên dự án đã xong. (sync-assets chỉ đẩy SSE,
// không ghi cột status nên không ảnh hưởng.)
(async () => {
    try {
        const d = await getDb();
        const r = await d.run("UPDATE Post SET status = NULL WHERE status = 'crawling'");
        // Self-heal cột điểm chấm nội dung (địa chính trị) — để API SELECT không lỗi trên DB cũ chưa có cột.
        await d.run('ALTER TABLE Post ADD COLUMN content_score INTEGER DEFAULT NULL').catch(() => {});
        await d.run('ALTER TABLE Post ADD COLUMN content_score_reason TEXT DEFAULT NULL').catch(() => {});
        await d.run('ALTER TABLE Post ADD COLUMN content_score_detail TEXT DEFAULT NULL').catch(() => {});
        await d.run('ALTER TABLE Post ADD COLUMN content_score_history TEXT DEFAULT NULL').catch(() => {});
        await d.close();
        if (r?.changes) console.log(`[startup] Dọn ${r.changes} post kẹt status='crawling' từ lần chạy trước.`);
    } catch (e) { console.error('[startup] dọn crawling lỗi:', e.message); }
    // Dọn file rác trong _tmp_uploads (multer tạm) cũ hơn 1 giờ — upload lỗi/hỏng để lại, tích dần tốn đĩa.
    try {
        const tmpDir = path.join(MEDIA_DIR, '_tmp_uploads');
        if (fs.existsSync(tmpDir)) {
            const cutoff = Date.now() - 60 * 60 * 1000;
            let n = 0;
            for (const f of fs.readdirSync(tmpDir)) {
                const fp = path.join(tmpDir, f);
                try { if (fs.statSync(fp).isFile() && fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); n++; } } catch (_) {}
            }
            if (n) console.log(`[startup] Dọn ${n} file rác trong _tmp_uploads.`);
        }
    } catch (e) { console.error('[startup] dọn _tmp_uploads lỗi:', e.message); }
})();

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
