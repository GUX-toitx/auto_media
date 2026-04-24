import 'dotenv/config';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import path from 'path';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import Parser from 'srt-parser-2';
import { execSync } from 'child_process';
import crypto from 'crypto';
import OpenAI from 'openai';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 1. CẤU HÌNH API KEYS VÀ ĐƯỜNG DẪN
// ==========================================
const BASE_DIR = '/usr/gux/media-team';
const SPREADSHEET_ID = '1K596bCoqZcNx0hvZbJitwHhIYTANpgsI8KqrWsvkRSs';

// OpenAI Key
const OPENAI_KEY = process.env.OPENAI_KEY;

// Storyblocks Key
const PUBLIC_KEY = process.env.STORYBLOCKS_PUBLIC_KEY;
const PRIVATE_KEY = process.env.STORYBLOCKS_PRIVATE_KEY;

// Pexels & Pixabay Key (Lấy miễn phí từ trang chủ của họ)
const PEXELS_API_KEY = process.env.PEXELS_API_KEY; 
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_KEY });
const parser = new Parser();
const creds = JSON.parse(fs.readFileSync('./khai-dev-eb5089179f46.json', 'utf8'));

const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ==========================================
// 2. HÀM TẢI STOCK (ĐA NGUỒN: STORYBLOCKS, PEXELS, PIXABAY)
// ==========================================

// Hàm tải và lưu file vật lý vào ổ cứng (Dùng chung cho mọi nguồn)
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

// ---- NGUỒN 1: STORYBLOCKS ----
function buildStoryblocksUrlV2(resource, params = {}) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const hmacKey = PRIVATE_KEY + expires;
    const hmac = crypto.createHmac('sha256', hmacKey).update(resource).digest('hex');
    const queryParams = new URLSearchParams({ ...params, APIKEY: PUBLIC_KEY, EXPIRES: expires, HMAC: hmac, project_id: 'cory_corner_auto', user_id: 'khaitm_dev' });
    return `https://api.storyblocks.com${resource}?${queryParams.toString()}`;
}

async function fetchFromStoryblocks(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const resource = type === 'video' ? '/api/v2/videos/search' : '/api/v2/images/search';
    const url = buildStoryblocksUrlV2(resource, { keywords: keyword, results_per_page: neededCount * 2, sort: 'most_downloaded' });

    try {
        const response = await fetch(url);
        if (!response.ok) return 0;
        const data = await response.json();
        const results = data.results || [];

        for (const item of results) {
            if (downloaded >= neededCount) break;
            let downloadUrl = type === 'video' ? 
                (item.preview_url || (item.preview_urls && (item.preview_urls.mp4 || Object.values(item.preview_urls)[0]))) : 
                (item.preview_url || item.thumbnail_url);

            if (downloadUrl) {
                const ext = type === 'video' ? 'mp4' : 'jpg';
                if (await downloadFileHelper(downloadUrl, targetDir, ext)) downloaded++;
            }
        }
    } catch (e) { console.log("Lỗi Storyblocks:", e.message); }
    return downloaded;
}

// ---- NGUỒN 2: PEXELS ----
async function fetchFromPexels(keyword, type, targetDir, neededCount) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('ĐIỀN_KEY')) return 0; 
    let downloaded = 0;
    const url = type === 'video' 
        ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&per_page=${neededCount * 2}`
        : `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${neededCount * 2}`;

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
                const ext = type === 'video' ? 'mp4' : 'jpg';
                if (await downloadFileHelper(downloadUrl, targetDir, ext)) downloaded++;
            }
        }
    } catch (e) { console.log("Lỗi Pexels:", e.message); }
    return downloaded;
}

// ---- NGUỒN 3: PIXABAY ----
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
            let downloadUrl = null;
            if (type === 'video' && item.videos) {
                downloadUrl = item.videos.large.url || item.videos.medium.url;
            } else {
                downloadUrl = item.largeImageURL;
            }

            if (downloadUrl) {
                const ext = type === 'video' ? 'mp4' : 'jpg';
                if (await downloadFileHelper(downloadUrl, targetDir, ext)) downloaded++;
            }
        }
    } catch (e) { console.log("Lỗi Pixabay:", e.message); }
    return downloaded;
}

// ---- MASTER FETCHER: GOM TÀI NGUYÊN TỪ MỌI NGUỒN ----
async function fetchAndDownloadStock(keyword, type, targetDir, countPerSource = 5) {
    if (!keyword) return 0;
    let totalDownloaded = 0;
    
    // Danh sách các nguồn cung cấp
    const providers = [
        { name: 'Storyblocks', fetcher: fetchFromStoryblocks },
        { name: 'Pexels', fetcher: fetchFromPexels },
        { name: 'Pixabay', fetcher: fetchFromPixabay }
    ];

    console.log(`   -> Bắt đầu tìm "${keyword}" trên 3 nguồn...`);

    // Duyệt qua TỪNG nguồn, và yêu cầu TỪNG nguồn lấy đủ 5 file
    for (const provider of providers) {
        const successCount = await provider.fetcher(keyword, type, targetDir, countPerSource);
        
        if (successCount > 0) {
            console.log(`      [+] ${provider.name} đóng góp ${successCount} ${type}`);
        }
        totalDownloaded += successCount;
    }

    return totalDownloaded;
}

// ==========================================
// 3. HÀM XỬ LÝ AI (COPYWRITER, CHIA CẢNH & DỊCH)
// ==========================================

async function enhanceContent(rawText) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: `Bạn là một Biên tập viên kịch bản video (Copywriter) xuất sắc. 
Nhiệm vụ: Viết lại (xào lại) đoạn nội dung người dùng cung cấp sao cho bay bổng, hấp dẫn, thu hút người xem nhưng vẫn giữ nguyên ý nghĩa cốt lõi. Văn phong tự nhiên, phù hợp làm lời thoại video (Voice-over).
KHÔNG thêm các tiêu đề như "Kịch bản:", "Giọng đọc:". Chỉ trả về DUY NHẤT nội dung kịch bản đã viết lại.` 
                },
                { role: "user", content: rawText }
            ],
            temperature: 0.7 
        });
        return response.choices[0].message.content.trim();
    } catch (e) {
        console.error("[!] Lỗi khi xào lại nội dung:", e.message);
        return rawText; 
    }
}

async function getGlobalTheme(fullText) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: `Bạn là Video Editor và Chuyên gia tìm kiếm Stock Footage chuyên nghiệp. Nhiệm vụ: Đọc toàn bộ kịch bản và trả về DUY NHẤT 1 CỤM TỪ (2-3 từ tiếng Anh) làm CHỦ ĐỀ CHÍNH BAO QUÁT. Không dùng từ trừu tượng.` }, { role: "user", content: fullText.slice(0, 2000) }],
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
            chunks.push(currentChunk.trim());
            currentChunk = s;
        } else {
            currentChunk += " " + s;
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

// AI tự quyết định cắt cảnh, TẠO GÓC QUAY ĐỘNG VÀ BẮT BUỘC BÁM SÁT ĐỊA DANH
async function analyzeAndGroupScenes(textChunk, globalTheme) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
                { 
                    role: "system", 
                    content: `Bạn là một Đạo diễn Hình ảnh (Visual Director) xuất sắc. Kịch bản có chủ đề chung là: "${globalTheme}".
Nhiệm vụ: 
1. Làm mịn văn bản tiếng Việt.
2. TỰ ĐỘNG CHIA đoạn văn bản thành các "Cảnh" (Scenes) sao cho hợp lý.
3. Cấp cho MỖI CẢNH đúng 3 từ khóa tiếng Anh (mỗi từ khóa 3-5 từ) để tìm Video Stock.

🔥 QUY TẮC 1: ĐỊA DANH LÀ ƯU TIÊN SỐ 1 (LOCATION FIRST):
- Nếu kịch bản nhắc đến BẤT KỲ địa danh, quốc gia, hoặc khu vực nào (Ví dụ: Trung Đông, Mỹ, Biển Đỏ, Châu Á...), BẮT BUỘC phải dịch địa danh đó sang tiếng Anh (Middle East, USA, Red Sea, Asia...) và đưa vào Keywords. KHÔNG được khái quát hóa thành "geopolitical" hay "global".

🔥 QUY TẮC 2: "ĐỘNG TỪ HÓA" CÙNG BỐI CẢNH (ACTION + LOCATION):
- Tuyệt đối không dùng các từ khóa chỉ có danh từ tĩnh (như: "middle east map").
- Keyword phải chứa ĐỘNG TỪ (V-ing) hoặc tính từ chỉ sự kiện, ghép cùng với Địa danh.

HƯỚNG DẪN TẠO 3 GÓC MÁY CHO VÍ DỤ: "Bất ổn địa chính trị tại Trung Đông, dòng tiền điều chỉnh"
- Góc 1 (Bối cảnh + Địa danh + Tình trạng): "middle east desert military conflict", "middle east city protest riot".
- Góc 2 (Sự kiện + Vật thể): "financial graph falling sharply", "stock market screen red numbers".
- Góc 3 (Hành động + Bối cảnh): "investors analyzing middle east map", "businessmen discussing investment strategy".

BẮT BUỘC trả về định dạng JSON:
{
  "scenes": [
    { 
      "text": "Đoạn thoại tiếng Việt đã làm mịn...", 
      "keywords": ["keyword 1", "keyword 2", "keyword 3"] 
    }
  ]
}` 
                },
                { role: "user", content: textChunk }
            ],
            temperature: 0.5 // Giữ mức 0.5 để AI ngoan ngoãn tuân thủ luật Địa danh nhưng vẫn sáng tạo góc máy
        });

        const data = JSON.parse(response.choices[0].message.content);
        return data.scenes || [];
    } catch (e) {
        console.error("Lỗi AI phân cảnh:", e.message);
        return [{ text: textChunk, keywords: ["cinematic b-roll", "professional background", "slow motion footage"] }];
    }
}

async function translateText(text, targetLang) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: `You are a professional native translator. Translate the given text into the language code: '${targetLang}'. Return ONLY the translated text, preserving the original tone and context. Do NOT add quotes or explanations.` },
                { role: "user", content: text }
            ],
            temperature: 0.2
        });
        return response.choices[0].message.content.trim();
    } catch (e) {
        return text;
    }
}

// ==========================================
// 4. CHẾ ĐỘ CHẠY LẺ (SINGLE MODE) TỪ DASHBOARD
// ==========================================
async function runSingleCrawl(videoId, groupId, keywordsArray) {
    console.log(`\n[SINGLE MODE - APPEND] Đang xử lý: ${videoId} | Nhóm: ${groupId}`);
    const vFolder = path.join(BASE_DIR, videoId, 'assets', '_raw_videos', groupId);
    const iFolder = path.join(BASE_DIR, videoId, 'assets', '_raw_images', groupId);

    [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

    const kwFilePath = path.join(vFolder, 'keywords.txt');
    let finalKeywords = [...keywordsArray]; 

    if (fs.existsSync(kwFilePath)) {
        const oldKwRaw = fs.readFileSync(kwFilePath, 'utf-8');
        const oldKeywords = oldKwRaw.split(',').map(k => k.trim()).filter(k => k);
        finalKeywords = [...new Set([...oldKeywords, ...keywordsArray])];
    }

    const kwString = finalKeywords.join(', ');
    fs.writeFileSync(kwFilePath, kwString, 'utf-8');
    fs.writeFileSync(path.join(iFolder, 'keywords.txt'), kwString, 'utf-8');

    for (const kw of keywordsArray) { if (await fetchAndDownloadStock(kw, 'video', vFolder, 5) >= 5) break; }
    for (const kw of keywordsArray) { if (await fetchAndDownloadStock(kw, 'image', iFolder, 5) >= 5) break; }

    console.log(`[SUCCESS] Đã cập nhật Keywords và thêm Media mới cho nhóm ${groupId}.`);
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
    
    const rawTargetLangs = targetRow.get('Ngôn ngữ Đích') || '';
    const targetLangs = rawTargetLangs.split(',').map(l => l.trim()).filter(l => l);

    const targetDir = path.join(BASE_DIR, projectId);
    
    console.log(`\n===========================================`);
    console.log(`[${new Date().toLocaleTimeString()}] >>> BẮT ĐẦU DỰ ÁN: ${projectId}`);
    console.log(`[*] Loại Crawl: ${crawlType}`);
    if (targetLangs.length > 0) console.log(`[+] Cần dịch sang: ${targetLangs.join(', ')}`);
    console.log(`===========================================`);

    targetRow.set('Trạng thái', 'PROCESSING'); 
    await targetRow.save();

    try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        let fullRawText = "";

        // --- RẼ NHÁNH: "VIDEO ID" HOẶC "NỘI DUNG" ---
        if (crawlType === 'Video ID') {
            console.log("[*] Đang tải YouTube Video và Subtitle...");
            execSync(`yt-dlp --cookies ./youtube.com_cookies.txt -f "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/mp4" -o "${targetDir}/original.%(ext)s" "${projectId}"`, { stdio: 'inherit' });
            execSync(`yt-dlp --cookies ./youtube.com_cookies.txt --write-sub --write-auto-subs --sub-lang ${lang} --convert-subs srt --skip-download -o "${targetDir}/original.%(ext)s" "${projectId}" --ignore-errors`, { stdio: 'inherit' });

            const srtFile = fs.readdirSync(targetDir).find(f => f.endsWith('.srt') && f.includes(`.${lang.toLowerCase()}.`));
            if (srtFile) fs.renameSync(path.join(targetDir, srtFile), path.join(targetDir, 'sub.srt'));

            if (fs.existsSync(path.join(targetDir, 'sub.srt'))) {
                const rawBlocks = parser.fromSrt(fs.readFileSync(path.join(targetDir, 'sub.srt'), 'utf8'));
                fullRawText = rawBlocks.map(b => b.text.replace(/\n/g, ' ')).join(' ');
            } else {
                throw new Error("Không lấy được Subtitle từ YouTube.");
            }
        } 
        else if (crawlType === 'Nội dung' || crawlType === 'Nội Dung') {
            if (!rawInputContent) throw new Error("Cột 'Nội dung' trống, không có gì để xử lý.");
            
            console.log("[*] Đang nhờ AI Copywriter 'xào' lại kịch bản cho bay bổng...");
            fullRawText = await enhanceContent(rawInputContent);
            
            fs.writeFileSync(path.join(targetDir, 'original_content.txt'), rawInputContent);
            fs.writeFileSync(path.join(targetDir, 'enhanced_content.txt'), fullRawText);
            console.log("[+] Xào kịch bản thành công!");
        } 
        else {
            throw new Error(`Loại craw "${crawlType}" không hợp lệ.`);
        }

        // --- TIẾP TỤC LUỒNG XỬ LÝ CHUNG ---
        const globalTheme = await getGlobalTheme(fullRawText);
        const textChunks = chunkTextToParagraphs(fullRawText);
        let allScenes = [];
        
        console.log(`[*] Đang nhờ AI phân tích và băm nhỏ kịch bản...`);
        for (const chunk of textChunks) {
            const scenes = await analyzeAndGroupScenes(chunk, globalTheme);
            allScenes = allScenes.concat(scenes);
        }

        console.log(`[*] Kịch bản đã được AI chia thành ${allScenes.length} nhóm cảnh.`);

        // 4. Tải Assets và Dịch theo từng Cảnh
        for (let i = 0; i < allScenes.length; i++) {
            const scene = allScenes[i];
            const gid = String(i + 1);
            
            const vFolder = path.join(targetDir, 'assets', '_raw_videos', gid);
            const iFolder = path.join(targetDir, 'assets', '_raw_images', gid);
            [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

            const kws = scene.keywords && scene.keywords.length > 0 ? scene.keywords : ["cinematic b-roll footage"];
            
            fs.writeFileSync(path.join(vFolder, 'keywords.txt'), kws.join(', '));
            fs.writeFileSync(path.join(iFolder, 'keywords.txt'), kws.join(', '));

            // Lưu file gốc (context.txt) cho hệ thống đọc mặc định
            fs.writeFileSync(path.join(vFolder, 'context.txt'), scene.text);
            fs.writeFileSync(path.join(iFolder, 'context.txt'), scene.text);

            // LƯU THÊM FILE ĐỊNH DANH NGÔN NGỮ GỐC (ví dụ: vi.context.txt)
            fs.writeFileSync(path.join(vFolder, `${lang}.context.txt`), scene.text);
            fs.writeFileSync(path.join(iFolder, `${lang}.context.txt`), scene.text);

            if (targetLangs.length > 0) {
                console.log(`   - [Cảnh ${gid}] Đang dịch sang ${targetLangs.length} ngôn ngữ...`);
                for (const targetLang of targetLangs) {
                    const translatedText = await translateText(scene.text, targetLang);
                    fs.writeFileSync(path.join(vFolder, `${targetLang}.context.txt`), translatedText);
                    fs.writeFileSync(path.join(iFolder, `${targetLang}.context.txt`), translatedText);
                }
            }

            console.log(`   - [Cảnh ${gid}] Đang tải media cho: "${scene.keyword}"`);
            for (const kw of kws) { if (await fetchAndDownloadStock(kw, 'video', vFolder, 5) >= 5) break; }
            for (const kw of kws) { if (await fetchAndDownloadStock(kw, 'image', iFolder, 5) >= 5) break; }
            
            await sleep(2000);
        }

        targetRow.set('Trạng thái', 'DONE');
        targetRow.set('Thư mục Lưu trữ', targetDir);
    } catch (e) {
        console.error(`[LỖI] ${projectId}:`, e.message);
        targetRow.set('Trạng thái', 'ERROR');
        targetRow.set('Ghi chú', e.message);
    }
    await targetRow.save();
    return true; 
}

// ==========================================
// 6. KHỞI CHẠY HỆ THỐNG
// ==========================================
async function startQueueManager() {
    console.log("=== HỆ THỐNG QUẢN LÝ HÀNG ĐỢI TỰ ĐỘNG ĐÃ CHẠY ===");
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

const args = process.argv.slice(2);
const modeIndex = args.indexOf('--mode');

if (modeIndex !== -1 && args[modeIndex + 1] === 'single') {
    const vId = args[args.indexOf('--videoId') + 1];
    const gId = args[args.indexOf('--groupId') + 1];
    const kws = args[args.indexOf('--keywords') + 1].split(',').map(k => k.trim());
    runSingleCrawl(vId, gId, kws);
} else {
    startQueueManager();
}
