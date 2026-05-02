import 'dotenv/config';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import path from 'path';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import Parser from 'srt-parser-2';
import { execSync } from 'child_process';
import crypto from 'crypto';
import OpenAI from 'openai';
import { initDB } from './migrate.js';
import { fetchFromDvidsBot } from './dvidsCrawler.js';
import { fetchFromBellingcatBot } from './bellingcatCrawler.js';
import { fetchFromReutersBot } from './reutersCrawler.js';
import { fetchFromApnewsBot } from './apnewsCrawler.js';
import { fetchFromAlJazeeraBot } from './aljazeeraCrawler.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 1. CẤU HÌNH API KEYS VÀ ĐƯỜNG DẪN
// ==========================================
const BASE_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1K596bCoqZcNx0hvZbJitwHhIYTANpgsI8KqrWsvkRSs';

const OPENAI_KEY = process.env.OPENAI_KEY; 
const PUBLIC_KEY = process.env.STORYBLOCKS_PUBLIC_KEY;
const PRIVATE_KEY = process.env.STORYBLOCKS_PRIVATE_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY; 
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_KEY });
const parser = new Parser();
const creds = JSON.parse(fs.readFileSync('./google_sheet.json', 'utf8'));

const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ==========================================
// 2. HÀM TẢI STOCK (ĐA NGUỒN)
// ==========================================
async function downloadFileHelper(url, targetDir, ext) {
    const existingFiles = fs.readdirSync(targetDir).filter(f => f.startsWith('stock_') && f.endsWith(ext));
    const nextIndex = existingFiles.length + 1;
    const savePath = path.join(targetDir, `stock_${nextIndex}.${ext}`);

    if (!fs.existsSync(savePath)) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (res.ok) {
                const buffer = await res.arrayBuffer();
                fs.writeFileSync(savePath, Buffer.from(buffer));
                return true;
            }
        } catch (error) { console.error("Lỗi tải file:", error.message); }
    }
    return false;
}

function buildStoryblocksUrlV2(resource, params = {}) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const hmacKey = PRIVATE_KEY + expires;
    const hmac = crypto.createHmac('sha256', hmacKey).update(resource).digest('hex');
    const queryParams = new URLSearchParams({ ...params, APIKEY: PUBLIC_KEY, EXPIRES: expires, HMAC: hmac, project_id: 'cory_corner_auto', user_id: 'khaitm_dev' });
    return `https://api.storyblocks.com${resource}?${queryParams.toString()}`;
}

async function fetchFromStoryblocks(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    const existing = fs.readdirSync(targetDir).filter(f => f.startsWith('stock_') && f.endsWith(ext)).length;
    const resource = type === 'video' ? '/api/v2/videos/search' : '/api/v2/images/search';
    const url = buildStoryblocksUrlV2(resource, { keywords: keyword, results_per_page: neededCount * 2, sort: 'most_downloaded' });
    try {
        const response = await fetch(url);
        if (!response.ok) return 0;
        const data = await response.json();
        for (const item of (data.results || [])) {
            if (downloaded >= neededCount) break;
            let downloadUrl = type === 'video' ? (item.preview_url || (item.preview_urls && (item.preview_urls.mp4 || Object.values(item.preview_urls)[0]))) : (item.preview_url || item.thumbnail_url);
            if (downloadUrl) {
                const savePath = path.join(targetDir, `stock_${existing + downloaded + 1}.${ext}`);
                try {
                    const res = await fetch(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    if (res.ok) { fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer())); downloaded++; }
                } catch (e) { console.error('Lỗi tải Storyblocks:', e.message); }
            }
        }
    } catch (e) { console.log('Lỗi Storyblocks:', e.message); }
    return downloaded;
}

async function fetchFromPexels(keyword, type, targetDir, neededCount) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('ĐIỀN_KEY')) return 0;
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    const existing = fs.readdirSync(targetDir).filter(f => f.startsWith('stock_') && f.endsWith(ext)).length;
    const url = type === 'video' ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&per_page=${neededCount * 2}` : `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${neededCount * 2}`;
    try {
        const response = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
        if (!response.ok) return 0;
        const data = await response.json();
        const results = type === 'video' ? data.videos : data.photos;
        for (const item of (results || [])) {
            if (downloaded >= neededCount) break;
            let downloadUrl = null;
            if (type === 'video') {
                const hdVideo = item.video_files.sort((a, b) => (b.width || 0) - (a.width || 0)).find(v => (v.width || 0) <= 1920) || item.video_files[0];
                downloadUrl = hdVideo ? hdVideo.link : null;
            } else {
                downloadUrl = item.src.large;
            }
            if (downloadUrl) {
                const savePath = path.join(targetDir, `stock_${existing + downloaded + 1}.${ext}`);
                try {
                    const res = await fetch(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    if (res.ok) { fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer())); downloaded++; }
                } catch (e) { console.error('Lỗi tải Pexels:', e.message); }
            }
        }
    } catch (e) { console.log('Lỗi Pexels:', e.message); }
    return downloaded;
}

async function fetchFromPixabay(keyword, type, targetDir, neededCount) {
    if (!PIXABAY_API_KEY || PIXABAY_API_KEY.includes('ĐIỀN_KEY')) return 0;
    let downloaded = 0;
    const mediaType = type === 'video' ? 'videos/' : '';
    const url = `https://pixabay.com/api/${mediaType}?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(keyword)}&per_page=${Math.max(3, neededCount * 2)}&safesearch=true`;

    try {
        const response = await fetch(url);
        if (!response.ok) return 0;
        const data = await response.json();
        for (const item of (data.hits || [])) {
            if (downloaded >= neededCount) break;
            let downloadUrl = type === 'video' && item.videos ? (item.videos.large.url || item.videos.medium.url) : item.largeImageURL;
            if (downloadUrl && await downloadFileHelper(downloadUrl, targetDir, type === 'video' ? 'mp4' : 'jpg')) downloaded++;
        }
    } catch (e) { console.log("Lỗi Pixabay:", e.message); }
    return downloaded;
}

async function fetchAndDownloadStock(keyword, type, targetDir, countPerSource = 5) {
    if (!keyword) return 0;
    let totalDownloaded = 0;
    
    // Đã nạp thêm thợ săn DVIDS vào danh sách
    const providers = [
        // { name: 'Storyblocks', fetcher: fetchFromStoryblocks },
        // { name: 'Pexels', fetcher: fetchFromPexels },
        // { name: 'DVIDS (Bot)', fetcher: fetchFromDvidsBot },
        // { name: 'Bellingcat (Bot)', fetcher: fetchFromBellingcatBot },
        // { name: 'Reuters (Bot)', fetcher: fetchFromReutersBot },
        // { name: 'AP News (Bot)', fetcher: fetchFromApnewsBot },
        { name: 'Al Jazeera (Bot)', fetcher: fetchFromAlJazeeraBot }
    ];
    
    console.log(`   -> [${type.toUpperCase()}] Tìm "${keyword}" | Mỗi nguồn: ${countPerSource}`);
    
    for (const provider of providers) {
        const got = await provider.fetcher(keyword, type, targetDir, countPerSource);
        console.log(`      [${provider.name}] Tải được: ${got}/${countPerSource} ${type}`);
        totalDownloaded += got;
    }
    
    console.log(`   -> [${type.toUpperCase()}] "${keyword}" xong: ${totalDownloaded} ${type}`);
    return totalDownloaded;
}

// ==========================================
// 3. HÀM XỬ LÝ AI 
// ==========================================
async function enhanceContent(rawText, targetLang = null) {
    try {
        const langInstruction = targetLang ? `Viết lại bằng ngôn ngữ: ${targetLang}.` : 'Giữ nguyên ngôn ngữ gốc.';
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: `Bạn là một Copywriter xuất sắc. Viết lại nội dung cho bay bổng, tự nhiên, phù hợp làm Voice-over. ${langInstruction} KHÔNG thêm tiêu đề, chỉ trả về nội dung.` }, { role: "user", content: rawText }],
            temperature: 0.7 
        });
        return response.choices[0].message.content.trim();
    } catch (e) { return rawText; }
}

async function getGlobalTheme(fullText) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: `Bạn là Video Editor. Đọc kịch bản và trả về DUY NHẤT 1 CỤM TỪ (2-3 từ tiếng Anh) làm CHỦ ĐỀ CHÍNH. Không dùng từ trừu tượng.` }, { role: "user", content: fullText.slice(0, 2000) }],
            temperature: 0.1
        });
        return response.choices[0].message.content.replace(/[.,"'!]/g, '').trim();
    } catch (e) { return "cinematic b-roll"; }
}

function chunkTextToParagraphs(rawText, maxChars = 3000) {
    const sentences = rawText.split(/(?<=\.)/); 
    const chunks = [];
    let currentChunk = "";
    for (let s of sentences) {
        if ((currentChunk.length + s.length) > maxChars) {
            chunks.push(currentChunk.trim()); currentChunk = s;
        } else { currentChunk += " " + s; }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

async function analyzeAndGroupScenes(textChunk, globalTheme, targetLang = null) {
    const langInstruction = targetLang
        ? `Viết "text" bằng ngôn ngữ: ${targetLang}. Viết "original_text" bằng tiếng Việt.`
        : 'Viết cả "text" và "original_text" bằng tiếng Việt.';
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `Bạn là Đạo diễn Hình ảnh. Kịch bản có chủ đề chung là: "${globalTheme}".
Nhiệm vụ:
1. ĐỌC HIỂU toàn bộ nội dung, sau đó TỰ ĐỘNG CHIA thành các "Cảnh" dựa theo ngữ cảnh và ý nghĩa (mỗi cảnh 2-4 câu liên quan).
2. Làm mịn từng cảnh cho tự nhiên, phù hợp Voice-over.
3. ${langInstruction}
4. Cấp cho MỖI CẢNH đúng 3 từ khóa tiếng Anh (3-5 từ/khóa) để tìm Video Stock.

🔥 ĐỊA DANH ƯU TIÊN SỐ 1: Nếu có địa danh (Trung Đông, Mỹ...), BẮT BUỘC dịch sang tiếng Anh và đưa vào Keyword.
🔥 "ĐỘNG TỪ HÓA": Dùng V-ing hoặc tính từ sự kiện (vd: "stock market crashing", "military helicopter flying").
🔥 VIẾT TẮT: KHÔNG thêm space vào giữa các chữ viết tắt. Ví dụ: U.S.A không phải U. S. A, U.K không phải U. K. KHÔNG dùng dạng có dấu chấm cuối như U.S. hay U.K.
🔥 TÊN QUỐC GIA: KHÔNG viết tắt tên quốc gia, viết rõ tên đầy đủ. Ví dụ: America hoặc United States thay vì US/USA, United Kingdom thay vì UK.

BẮT BUỘC trả về JSON:
{
  "scenes": [
    {
      "original_text": "Đoạn đã làm mịn bằng tiếng Việt...",
      "text": "Đoạn đã làm mịn theo ngôn ngữ đích...",
      "keywords": ["keyword 1", "keyword 2", "keyword 3"]
    }
  ]
}`
                },
                { role: "user", content: textChunk }
            ],
            temperature: 0.5
        });
        return JSON.parse(response.choices[0].message.content).scenes || [];
    } catch (e) { return [{ original_text: textChunk, text: textChunk, keywords: ["cinematic b-roll", "professional background", "slow motion footage"] }]; }
}

async function translateText(text, targetLang) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: `You are a translator. Translate to '${targetLang}'. Return ONLY translated text.` }, { role: "user", content: text }],
            temperature: 0.2
        });
        return response.choices[0].message.content.trim();
    } catch (e) { return text; }
}

// ==========================================
// 4. CHẾ ĐỘ CHẠY LẺ (SINGLE MODE) TỪ DASHBOARD
// ==========================================
async function runSingleCrawl(videoId, paragraphId, keywordsArray) {
    console.log(`\n[SINGLE MODE] Project: ${videoId} | Paragraph: ${paragraphId} | Keywords: ${keywordsArray.join(', ')}`);
    const db = await initDB();

    // Lấy vị trí paragraph trong post để xác định gid (thứ tự trong post)
    const para = await db.get('SELECT id, post_id FROM Paragraph WHERE id = ?', [paragraphId]);
    if (!para) { console.error('[SINGLE MODE] Không tìm thấy paragraph'); process.exit(1); }

    const paras = await db.all('SELECT id FROM Paragraph WHERE post_id = ? ORDER BY id', [para.post_id]);
    const gid = String(paras.findIndex(p => p.id === para.id) + 1);

    const vFolder = path.join(BASE_DIR, videoId, 'assets', '_raw_videos', gid);
    const iFolder = path.join(BASE_DIR, videoId, 'assets', '_raw_images', gid);
    [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

    // Lưu keyword mới vào DB
    for (const kw of keywordsArray) {
        const exists = await db.get('SELECT id FROM Keyword WHERE paragraph_id = ? AND content = ?', [paragraphId, kw]);
        if (!exists) await db.run('INSERT INTO Keyword (paragraph_id, content) VALUES (?, ?)', [paragraphId, kw]);
    }

    // Tải media
    for (const kw of keywordsArray) { await fetchAndDownloadStock(kw, 'video', vFolder, 5); }
    for (const kw of keywordsArray) { await fetchAndDownloadStock(kw, 'image', iFolder, 5); }

    // Sync asset mới vào DB
    const syncAssets = async (folderPath, assetType) => {
        const ext = assetType === 'video' ? '.mp4' : '.jpg';
        const files = fs.readdirSync(folderPath).filter(f => f.startsWith('stock_') && f.endsWith(ext));
        for (const file of files) {
            const relativePath = path.join(videoId, 'assets', assetType === 'video' ? '_raw_videos' : '_raw_images', gid, file);
            const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [relativePath]);
            if (!exists) await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [paragraphId, assetType, relativePath]);
        }
    };
    await syncAssets(vFolder, 'video');
    await syncAssets(iFolder, 'image');

    await db.close();
    console.log(`[SUCCESS] Xong paragraph ${paragraphId}.`);
    process.exit(0);
}

// ==========================================
// 5. HỆ THỐNG QUẢN LÝ HÀNG ĐỢI (SERIAL QUEUE MANAGER)
// ==========================================

async function processNextInQueue() {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const rows = await doc.sheetsByIndex[0].getRows();

    const targetRow = rows.find(row => row.get('Trạng thái') === 'QUEUE');
    if (!targetRow) return false; 

    const projectId = targetRow.get('Video ID'); 
    const lang = targetRow.get('Ngôn ngữ Gốc') || 'vi';
    const crawlType = targetRow.get('Loại craw') || 'Video ID'; 
    const rawInputContent = targetRow.get('Nội dung') || '';
    
    const targetLangs = (targetRow.get('Ngôn ngữ Đích') || '').split(',').map(l => l.trim()).filter(l => l);
    const targetDir = path.join(BASE_DIR, projectId);
    
    // --- KHỞI TẠO DB ---
    const db = await initDB();
    
    console.log(`\n===========================================`);
    console.log(`[${new Date().toLocaleTimeString()}] >>> BẮT ĐẦU DỰ ÁN: ${projectId}`);
    console.log(`===========================================`);

    targetRow.set('Trạng thái', 'PROCESSING'); 
    await targetRow.save();

    try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        let fullRawText = "";
        let dbPostTitle = "";

        if (crawlType === 'Video ID') {
            dbPostTitle = projectId;
            execSync(`yt-dlp --cookies ./youtube.com_cookies.txt -f "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/mp4" -o "${targetDir}/original.%(ext)s" "${projectId}"`, { stdio: 'inherit' });
            execSync(`yt-dlp --cookies ./youtube.com_cookies.txt --write-sub --write-auto-subs --sub-lang ${lang} --convert-subs srt --skip-download -o "${targetDir}/original.%(ext)s" "${projectId}" --ignore-errors`, { stdio: 'inherit' });

            const srtFile = fs.readdirSync(targetDir).find(f => f.endsWith('.srt') && f.includes(`.${lang.toLowerCase()}.`));
            if (srtFile) fs.renameSync(path.join(targetDir, srtFile), path.join(targetDir, 'sub.srt'));

            if (fs.existsSync(path.join(targetDir, 'sub.srt'))) {
                const rawBlocks = parser.fromSrt(fs.readFileSync(path.join(targetDir, 'sub.srt'), 'utf8'));
                fullRawText = rawBlocks.map(b => b.text.replace(/\n/g, ' ')).join(' ');
            } else { throw new Error("Không lấy được Subtitle từ YouTube."); }
        } else {
            if (!rawInputContent) throw new Error("Cột 'Nội dung' trống.");
            dbPostTitle = projectId;
            fullRawText = rawInputContent;
            fs.writeFileSync(path.join(targetDir, 'original_content.txt'), rawInputContent);
        }

        const globalTheme = await getGlobalTheme(fullRawText);
        const textChunks = chunkTextToParagraphs(fullRawText);

        // Xử lý từng ngôn ngữ đích (hoặc ngôn ngữ gốc nếu không có ngôn ngữ đích)
        const langsToProcess = targetLangs.length > 0 ? targetLangs : [null];

        for (const processLang of langsToProcess) {
            const postTitle = processLang ? `${dbPostTitle}_${processLang}` : dbPostTitle;
            console.log(`\n   [LANG] Xử lý ngôn ngữ: ${processLang || lang}`);

            // 🟢 LƯU DATABASE: Tạo Post riêng cho từng ngôn ngữ
            await db.run('INSERT OR IGNORE INTO Post (title) VALUES (?)', [postTitle]);
            await db.run('UPDATE Post SET status = ? WHERE title = ?', ['crawling', postTitle]);
            // Notify dashboard
            fetch(`http://localhost:${PORT}/api/crawl-status/notify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ postTitle, status: 'crawling' })
            }).catch(() => {});
            const postRecord = await db.get('SELECT id FROM Post WHERE title = ?', [postTitle]);
            const dbPostId = postRecord.id;

            let allScenes = [];
            for (const chunk of textChunks) {
                allScenes = allScenes.concat(await analyzeAndGroupScenes(chunk, globalTheme, processLang));
            }

            let sentenceOrder = 0;
            for (let i = 0; i < allScenes.length; i++) {
                const scene = allScenes[i];
                const gid = String(i + 1);

                const vFolder = path.join(targetDir, 'assets', '_raw_videos', gid);
                const iFolder = path.join(targetDir, 'assets', '_raw_images', gid);
                [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

                const kws = scene.keywords && scene.keywords.length > 0 ? scene.keywords : ["cinematic b-roll footage"];

                // LƯU CÁC FILE CONTEXT
                const ctxLang = processLang || lang;
                fs.writeFileSync(path.join(vFolder, 'keywords.txt'), kws.join(', '));
                fs.writeFileSync(path.join(iFolder, 'keywords.txt'), kws.join(', '));
                fs.writeFileSync(path.join(vFolder, `${ctxLang}.context.txt`), scene.text);
                fs.writeFileSync(path.join(iFolder, `${ctxLang}.context.txt`), scene.text);
                // context.txt luôn là nội dung gốc
                if (!processLang) {
                    fs.writeFileSync(path.join(vFolder, 'context.txt'), scene.text);
                    fs.writeFileSync(path.join(iFolder, 'context.txt'), scene.text);
                    fs.writeFileSync(path.join(vFolder, 'original_content.txt'), fullRawText);
                    fs.writeFileSync(path.join(iFolder, 'original_content.txt'), fullRawText);
                }

                // 🟢 LƯU DATABASE: Tạo Paragraph với original_content
                const maxOrder = await db.get(
                    'SELECT COALESCE(MAX("order"), 0) as max FROM Paragraph WHERE post_id = ?', [dbPostId]
                );
                const paraRes = await db.run(
                    'INSERT INTO Paragraph (post_id, content, original_content, "order") VALUES (?, ?, ?, ?)',
                    [dbPostId, scene.text, scene.original_text || scene.text, maxOrder.max + 1]
                );
                const dbParagraphId = paraRes.lastID;

                for (const kw of kws) {
                    await db.run('INSERT INTO Keyword (paragraph_id, content) VALUES (?, ?)', [dbParagraphId, kw]);
                }

                const sentences = scene.text.split(/(?<=\.{1,3} )|(?<=[!?] )|(?<=[。！？])|\n+/).map(s => s.trim()).filter(Boolean);
                const originalSentences = (scene.original_text || scene.text).split(/(?<=\.{1,3} )|(?<=[!?] )|(?<=[。！？])|\n+/).map(s => s.trim()).filter(Boolean);
                for (let si = 0; si < sentences.length; si++) {
                    sentenceOrder++;
                    await db.run('INSERT INTO Sentence (paragraph_id, content, original_content, "order") VALUES (?, ?, ?, ?)', [dbParagraphId, sentences[si], originalSentences[si] || scene.original_text || sentences[si], sentenceOrder]);
                }

                // Chỉ tải media 1 lần (theo ngôn ngữ đầu tiên)
                if (processLang === langsToProcess[0]) {
                    console.log(`   - [Cảnh ${gid}] Đang tải media...`);
                    for (const kw of kws) { await fetchAndDownloadStock(kw, 'video', vFolder, 5); }
                    for (const kw of kws) { await fetchAndDownloadStock(kw, 'image', iFolder, 5); }

                    const syncAssetsToDB = async (folderPath, assetType) => {
                        const files = fs.readdirSync(folderPath).filter(f => f.startsWith('stock_') && (f.endsWith('.mp4') || f.endsWith('.jpg')));
                        for (const file of files) {
                            const relativePath = path.join(projectId, 'assets', folderPath.includes('_raw_videos') ? '_raw_videos' : '_raw_images', gid, file);
                            const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [relativePath]);
                            if (!exists) {
                                await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, NULL, ?, ?)', [dbParagraphId, assetType, relativePath]);
                            }
                        }
                    };
                    await syncAssetsToDB(vFolder, 'video');
                    await syncAssetsToDB(iFolder, 'image');
                }

                await sleep(2000);
            }
        }

        targetRow.set('Trạng thái', 'DONE');
        targetRow.set('Thư mục Lưu trữ', targetDir);
        await db.run('UPDATE Post SET status = NULL WHERE title LIKE ?', [`${projectId}%`]);
        // Notify dashboard
        fetch(`http://localhost:${PORT}/api/crawl-status/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postTitle: projectId, status: null })
        }).catch(() => {});
    } catch (e) {
        console.error(`[LỖI] ${projectId}:`, e.message);
        targetRow.set('Trạng thái', 'ERROR');
        targetRow.set('Ghi chú', e.message);
        await db.run('UPDATE Post SET status = NULL WHERE title LIKE ?', [`${projectId}%`]);
        fetch(`http://localhost:${PORT}/api/crawl-status/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postTitle: projectId, status: null })
        }).catch(() => {});
    }
    await targetRow.save();
    return true; 
}

// ==========================================
// 5. KHỞI CHẠY HỆ THỐNG
// ==========================================
async function startQueueManager() {
    console.log("=== HỆ THỐNG QUẢN LÝ HÀNG ĐỢI (CÓ SYNC DATABASE) ĐÃ CHẠY ===");
    while (true) {
        const hasWork = await processNextInQueue();
        if (hasWork) {
            console.log("[HỆ THỐNG] Nghỉ 5 giây rồi kiểm tra mục tiếp theo...");
            await sleep(5000);
        } else {
            console.log(`[${new Date().toLocaleTimeString()}] Hàng đợi trống. Nghỉ 5 phút...`);
            await sleep(5 * 60 * 1000); 
        }
    }
}

// KHỞI CHẠY
const args = process.argv.slice(2);
if (args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'single') {
    const videoId = args[args.indexOf('--videoId') + 1];
    const paragraphId = parseInt(args[args.indexOf('--paragraphId') + 1]);
    const keywords = args[args.indexOf('--keywords') + 1].split(',').map(k => k.trim()).filter(k => k);
    runSingleCrawl(videoId, paragraphId, keywords);
} else {
    startQueueManager();
}
