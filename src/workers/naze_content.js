import 'dotenv/config';
import path from 'path';
import https from 'https';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fetchFromStoryblocksBot } from '../crawlers/storyblocksCrawler.js';
import { fetchFromGoogleImageBot } from '../crawlers/googleImageCrawler.js';
import { crawlKeywordImageRotate } from '../crawlers/imageCrawlRotate.js';   // xen kẽ Bing/Google + thử nốt nguồn kia
import { crawlX } from '../x/x_crawler.js';
import { fetchIPv4 as fetch } from '../lib/fetchIPv4.js';
import { claimNextStockPath } from '../lib/stockNaming.js';
import { aiChat, aiStructured, aiProviderName, modelFor, logUsage } from '../lib/ai.js';
import fs from 'fs';

const OPENAI_KEY = process.env.OPENAI_KEY;
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });
const IMAGES_PER_KEYWORD = 8;

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

async function downloadFile(url, targetDir) {
    const savePath = claimNextStockPath(targetDir, 'jpg');
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) { fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer())); return true; }
    } catch (_) {}
    try { fs.unlinkSync(savePath); } catch (_) {}
    return false;
}

async function fetchFromPexels(keyword, targetDir, count) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('DIEN')) return 0;
    let n = 0;
    try {
        const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${count * 2}`, { headers: { Authorization: PEXELS_API_KEY } });
        if (!res.ok) return 0;
        const data = await res.json();
        for (const item of (data.photos || [])) {
            if (n >= count) break;
            if (await downloadFile(item.src.large, targetDir)) n++;
        }
    } catch (e) { console.log('Pexels loi:', e.message); }
    return n;
}

// Tải video Pexels (chọn bản mp4 độ phân giải cao nhất mỗi video, cap 720p cho nhẹ)
async function fetchFromPexelsVideo(keyword, targetDir, count) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('DIEN')) return 0;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    let n = 0;
    try {
        const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&per_page=${count * 2}`, { headers: { Authorization: PEXELS_API_KEY } });
        if (!res.ok) return 0;
        const data = await res.json();
        for (const v of (data.videos || [])) {
            if (n >= count) break;
            // mp4, cao nhất nhưng <= 720p; không có thì lấy nhỏ nhất
            const mp4 = (v.video_files || []).filter(f => (f.file_type === 'video/mp4') && f.link);
            if (!mp4.length) continue;
            const under720 = mp4.filter(f => (f.height || 0) <= 720).sort((a, b) => (b.height || 0) - (a.height || 0));
            const pick = under720[0] || mp4.sort((a, b) => (a.height || 0) - (b.height || 0))[0];
            const savePath = claimNextStockPath(targetDir, 'mp4');
            try {
                const r2 = await fetch(pick.link, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (r2.ok) { fs.writeFileSync(savePath, Buffer.from(await r2.arrayBuffer())); n++; }
                else { try { fs.unlinkSync(savePath); } catch (_) {} }
            } catch (_) { try { fs.unlinkSync(savePath); } catch (_) {} }
        }
    } catch (e) { console.log('Pexels video lỗi:', e.message); }
    return n;
}

async function fetchFromPixabay(keyword, targetDir, count) {
    if (!PIXABAY_API_KEY || PIXABAY_API_KEY.includes('DIEN')) return 0;
    let n = 0;
    try {
        const res = await fetch(`https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(keyword)}&per_page=${Math.max(3, count * 2)}&safesearch=true`);
        if (!res.ok) return 0;
        const data = await res.json();
        for (const item of (data.hits || [])) {
            if (n >= count) break;
            if (await downloadFile(item.largeImageURL, targetDir)) n++;
        }
    } catch (e) { console.log('Pixabay loi:', e.message); }
    return n;
}

async function fetchImages(keyword, targetDir, count) {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const results = await Promise.allSettled([
        fetchFromPexels(keyword, targetDir, count),
        fetchFromPixabay(keyword, targetDir, count),
        fetchFromStoryblocksBot(keyword, 'image', targetDir, count),
        fetchFromGoogleImageBot(keyword, 'image', targetDir, count),
    ]);
    return results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? (r.value || 0) : 0), 0);
}

// Đếm số keyword đã cào để XOAY VÒNG nguồn (idx chẵn: Bing trước; idx lẻ: Google trước) → cân tải, tránh 1 nguồn bị chặn cả loạt.
let imgRotateIdx = 0;

// Cào ảnh cho 1 keyword: Bing/Google (xen kẽ) + Pexels LUÔN chạy song song.
// Cả Bing lẫn Google về 0 (bị chặn) thì thêm Pixabay để cảnh không trống.
async function crawlImagesForKeyword(kw, dir, count) {
    let got = 0;
    // Pexels chạy SONG SONG (không chờ fallback) — nguồn ảnh stock ổn định, ít bị chặn
    const pexelsP = fetchFromPexels(kw, dir, count).catch(e => { console.error(`      [${kw}] Pexels lỗi: ${e.message}`); return 0; });
    try { got = await crawlKeywordImageRotate(kw, dir, imgRotateIdx++, count); }
    catch (e) { console.error(`      [${kw}] rotate img lỗi: ${e.message}`); }
    const pexels = await pexelsP;
    console.log(`      [${kw}] Bing/Google ${got} + Pexels ${pexels} ảnh`);
    if (got + pexels > 0) return got + pexels;
    // Tất cả về 0 → Pixabay dự phòng cuối
    console.log(`      [${kw}] mọi nguồn 0 ảnh → fallback Pixabay`);
    let fb = 0;
    try { fb += await fetchFromPixabay(kw, dir, count); } catch (e) { console.error(`      [${kw}] Pixabay lỗi: ${e.message}`); }
    return fb;
}



function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const data = JSON.stringify(body);
        const req = https.request(
            { hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', family: 4, headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
            (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, body: raw })); }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function generateContent(topic, targetLang) {
    const langName = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish', th: 'Thai', id: 'Bahasa Indonesia' }[targetLang] || targetLang;
    const schema = {
        type: 'object',
        properties: {
            title: { type: 'string' },
            title_vi: { type: 'string' },
            sentences: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        vi: { type: 'string' },
                        target: { type: 'string' }
                    },
                    required: ['vi', 'target'],
                    additionalProperties: false
                }
            }
        },
        required: ['title', 'title_vi', 'sentences'],
        additionalProperties: false
    };

    const systemPrompt = `You are a professional science and knowledge YouTube narrator in the style of Vsauce, Kurzgesagt, and SciShow.
Task:
1. Write engaging educational content about the given topic in BOTH Vietnamese AND ${langName} simultaneously.
2. Style: conversational, curious, mind-blowing facts, build-up from simple to complex.
3. Structure: Hook (why this question matters) → Simple explanation → Deeper science → Surprising facts → Conclusion.
4. Target length: 8-10 minutes of voice-over (approximately 2400-3500 words per language). Divide into paragraphs of 3-5 sentences each. Each "sentence" in the JSON output should be a FULL PARAGRAPH (multiple sentences combined), not a single short sentence. Group related ideas into one cohesive paragraph.
5. Use analogies and relatable examples to explain complex concepts.
6. NEVER cite sources, never add URLs, never add footnotes or references.
7. Output clean sentences only with no citations whatsoever.`;

    console.log(`[naze] Gọi ${aiProviderName()} (${modelFor('main')}) sinh nội dung: ${topic}`);
    const { outputText, usage } = await aiStructured({
        schema,
        schemaName: 'naze_content',
        input: systemPrompt + '\n\nTopic: ' + topic,
        effort: 'high',
        maxTokens: 32000,
        webSearch: true,      // OpenAI dùng web_search_preview; DeepSeek tự bỏ qua
    });
    logUsage('naze', usage);

    const parsed = JSON.parse(outputText);
    const stripCitations = s => s.replace(/\s*\([^)]*\(https?:[^)]+\)[^)]*\)/g, '').replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();
    parsed.sentences = (parsed.sentences || []).map(s => ({ vi: stripCitations(s.vi), target: stripCitations(s.target) }));

    console.log('[GPT-5] === OUTPUT ===');
    console.log('Title VI:', parsed.title_vi);
    console.log('Title:', parsed.title);
    (parsed.sentences || []).forEach((s, i) => console.log(`  [${i+1}] VI: ${s.vi} | TARGET: ${s.target}`));
    console.log('[GPT-5] === END OUTPUT ===');

    return { title: parsed.title || '', title_vi: parsed.title_vi || '', sentences: parsed.sentences || [] };
}

async function generateDramaContent(info, targetLang) {
    const langName = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish', th: 'Thai', id: 'Bahasa Indonesia' }[targetLang] || targetLang;
    const schema = {
        type: 'object',
        properties: {
            title: { type: 'string' },
            title_vi: { type: 'string' },
            sentences: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        vi: { type: 'string' },
                        target: { type: 'string' }
                    },
                    required: ['vi', 'target'],
                    additionalProperties: false
                }
            }
        },
        required: ['title', 'title_vi', 'sentences'],
        additionalProperties: false
    };

    const systemPrompt = `You are a professional true-crime / drama storytelling YouTube narrator.
Task:
1. You are given RAW CASE INFORMATION (real incidents, crime cases, scandals — names, dates, events, legal outcomes, public reactions). Rework ("xào") this information into a gripping narrated script.
2. Write the script in BOTH Vietnamese AND ${langName} simultaneously.
3. Style: suspenseful, dramatic, cinematic storytelling. Build tension, dramatize the sequence of events, use vivid pacing. NOT a dry news report — tell it like a true-crime story.
4. Structure: Hook (a striking opening that grabs attention) → Set the scene / background → Escalating events (chi tiết diễn biến, phương thức) → Climax / turning point → Aftermath (hậu quả pháp lý, phản ứng dư luận) → Reflective conclusion.
5. If MULTIPLE cases are provided, weave them into one cohesive episode with smooth transitions between stories (or treat them as connected chapters).
6. Target length: 8-10 minutes of voice-over (approximately 2400-3500 words per language). Divide into paragraphs of 3-5 sentences each. Each "sentence" in the JSON output should be a FULL PARAGRAPH (multiple sentences combined), not a single short sentence.
7. Stay faithful to the facts given (names, dates, outcomes) — do NOT invent contradicting facts, but you MAY add atmospheric narration and natural dramatic framing.
8. NEVER cite sources, never add URLs, never add footnotes or references.
9. Output clean narration only with no citations whatsoever.`;

    console.log(`[drama] Gọi ${aiProviderName()} (${modelFor('main')}) sinh nội dung`);
    const { outputText, usage } = await aiStructured({
        schema,
        schemaName: 'drama_content',
        input: systemPrompt + '\n\nCase information:\n' + info,
        effort: 'high',
        maxTokens: 32000,
    });
    logUsage('drama', usage);

    const parsed = JSON.parse(outputText);
    const stripCitations = s => s.replace(/\s*\([^)]*\(https?:[^)]+\)[^)]*\)/g, '').replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();
    parsed.sentences = (parsed.sentences || []).map(s => ({ vi: stripCitations(s.vi), target: stripCitations(s.target) }));

    console.log('[GPT-5 drama] === OUTPUT ===');
    console.log('Title VI:', parsed.title_vi);
    console.log('Title:', parsed.title);
    (parsed.sentences || []).forEach((s, i) => console.log(`  [${i+1}] VI: ${s.vi} | TARGET: ${s.target}`));
    console.log('[GPT-5 drama] === END OUTPUT ===');

    return { title: parsed.title || '', title_vi: parsed.title_vi || '', sentences: parsed.sentences || [] };
}

async function getKeywordsFromGPT(sentence) {
    const r = await aiChat({
        tier: 'mini', temperature: 0.3,
        messages: [
            {
                role: 'system',
                content: 'You are an image search expert. Given a science/educational sentence, return exactly 6 specific Japanese image search queries for stock photo sites. Focus on visual concepts, nature, science diagrams, real phenomena. Write every query in Japanese. Return ONLY a raw JSON array. Example: ["海の塩の結晶 クローズアップ", "水中の塩の鉱物", "海水の蒸発"]'
            },
            { role: 'user', content: sentence }
        ],
    });
    let content = r.content || '[]';
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return parsed.slice(0, 6);
        const val = Object.values(parsed)[0];
        return Array.isArray(val) ? val.slice(0, 6) : [content.slice(0, 60)];
    } catch {
        const match = content.match(/\[.*?\]/s);
        if (match) try { return JSON.parse(match[0]).slice(0, 6); } catch(_) {}
        return [content.slice(0, 60)];
    }
}

// Sinh 3 keyword tiếng NHẬT để tìm bài trên X (Twitter) từ nội dung đoạn
async function getXKeywordsJa(caseInfo) {
    try {
        const r = await aiChat({
            tier: 'std', temperature: 0.2,
            messages: [
                    {
                        role: 'system',
                        content: [
                            'Bạn là chuyên gia tìm kiếm trên X (Twitter) tiếng Nhật.',
                            'Từ THÔNG TIN VỤ VIỆC, xác định sự kiện cốt lõi: AI (quốc tịch/nhân vật) đã LÀM GÌ (hành vi), Ở ĐÂU (địa điểm/quốc gia), với ĐỐI TƯỢNG/VẬT gì.',
                            'Rồi tạo ĐÚNG 3 câu tìm kiếm tiếng NHẬT để tìm bài đăng về CHÍNH sự kiện đó.',
                            'Quy tắc:',
                            '- Mỗi câu ghép 2-3 từ khóa cốt lõi bằng dấu cách (AND). Đặt cụm đặc trưng nhất trong dấu ngoặc kép "..." để khớp chính xác.',
                            '- Dùng ĐÚNG thuật ngữ tiếng Nhật cho vật/hành vi thật. VD: quả cherry = さくらんぼ (TUYỆT ĐỐI KHÔNG dùng 桜 = hoa anh đào); trộm/hái trộm = 窃盗 / 盗む / 無断; người Việt = ベトナム人 (không dùng "phụ nữ Việt" chung chung).',
                            '- ƯU TIÊN từ thuần Nhật mà người Nhật thật sự tweet; TRÁNH katakana ngoại lai khi có từ thuần Nhật phổ biến hơn. VD quả cherry: BẮT BUỘC dùng さくらんぼ, KHÔNG dùng チェリー. Nếu phân vân, chọn từ cho ra nhiều kết quả tìm kiếm nhất.',
                            '- Tránh từ chung chung, cảm xúc, hay chỉ 1 danh từ đơn lẻ. Ưu tiên cách người Nhật thật sự tweet về vụ việc.',
                            '- CHỈ trả về JSON array gồm 3 chuỗi, không giải thích.',
                            'Ví dụ (vụ người Việt hái trộm cherry ở Nhật): ["\\"ベトナム人\\" さくらんぼ", "ベトナム人 さくらんぼ 窃盗", "さくらんぼ 盗難 外国人"]'
                        ].join('\n')
                    },
                    { role: 'user', content: String(caseInfo).slice(0, 6000) }
                ],
        });
        let content = (r.content || '[]').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        try { const p = JSON.parse(content); if (Array.isArray(p)) return p.slice(0, 3); } catch (_) {}
        const m = content.match(/\[.*?\]/s);
        if (m) { try { return JSON.parse(m[0]).slice(0, 3); } catch (_) {} }
        return [];
    } catch (e) { console.error(`    [X] keyword JA lỗi: ${e.message}`); return []; }
}

async function main() {
    const argv = process.argv.slice(2);
    // Cờ --genre <naze|drama> có thể đứng bất cứ đâu → tách ra trước khi đọc tham số vị trí.
    // Cần cho drama-từ-SRT: trước đây chế độ --srt luôn để genre='naze' nên dự án drama tạo bằng SRT
    // không cào X và bị lưu sai thể loại.
    let genre = 'naze';
    const args = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--genre') { genre = (argv[++i] || 'naze').trim() || 'naze'; continue; }
        args.push(argv[i]);
    }
    const mode = args[0]; // topic text, --srt, --youtube

    let projectId, targetLang, rawSentences = null, postTitleVi = '';
    let caseInfo = '';   // văn bản mô tả vụ việc → dùng sinh keyword tìm X (drama)

    if (mode === '--srt') {
        const srtPath = args[1];
        projectId = args[2];
        const srtTargetPath = args[3] && !args[3].match(/^[a-z]{2}$/) ? args[3] : null;
        targetLang = (srtTargetPath ? args[4] : args[3]) || 'vi';
        if (!srtPath || !projectId) { console.error('Usage: node naze_content.js --srt <srt> <projectId> [srtTarget] [lang] [--genre drama]'); process.exit(1); }
        const { readFileSync } = await import('fs');
        const parseSrt = (p) => {
            const blocks = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim().split(/\n\n+/);
            return blocks.map(b => { const lines = b.trim().split('\n'); return lines.length >= 3 ? lines.slice(2).join(' ').trim() : null; }).filter(Boolean);
        };
        const srcSentences = parseSrt(srtPath);
        const tgtSentences = srtTargetPath ? parseSrt(srtTargetPath) : null;
        rawSentences = srcSentences.map((vi, i) => ({ vi, target: tgtSentences?.[i] || vi }));
        postTitleVi = projectId;
        // Drama không còn ô "thông tin vụ việc" → lấy chính nội dung SRT làm mô tả vụ việc cho keyword X
        caseInfo = srcSentences.join(' ').slice(0, 4000);
        console.log(`[naze] SRT mode: ${rawSentences.length} sentences | genre: ${genre}`);
    } else if (mode === '--youtube') {
        const url = args[1];
        projectId = args[2];
        targetLang = args[3] || 'vi';
        if (!url || !projectId) { console.error('Usage: node naze_content.js --youtube <url> <projectId> [lang]'); process.exit(1); }
        console.log(`[naze] YouTube mode: ${url} | targetLang: ${targetLang}`);
        const { execSync } = await import('child_process');
        const { mkdirSync, existsSync, readdirSync, readFileSync } = await import('fs');
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

        // Tải transcript qua youtube-transcript-api (Python)
        const getTranscript = (videoId, langs, noFallback = false) => {
            const langArg = langs.join(',');
            const fallbackCode = noFallback ? 'raise' : `tl = api.list('${videoId}')\n    t = list(tl)[0].fetch()\n    print(json.dumps({'lang': t.language_code, 'texts': [s.text for s in t.snippets]}))`;
            try {
                const out = execSync(`python3 -c "
import sys, json
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
langs = '${langArg}'.split(',')
try:
    t = api.fetch('${videoId}', languages=langs)
    print(json.dumps({'lang': t.language_code, 'texts': [s.text for s in t.snippets]}))
except Exception as e:
    ${fallbackCode}
"`, { encoding: 'utf8' });
                return JSON.parse(out.trim());
            } catch (e) { throw new Error('youtube-transcript-api loi: ' + e.message.slice(0, 100)); }
        };

        const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.split('/').pop();
        console.log(`[naze] Fetching transcript for videoId: ${videoId}`);

        // Lấy transcript gốc
        const prefLangs = targetLang === 'vi' ? ['vi', 'en', 'ja'] : [targetLang, 'vi', 'en', 'ja'];
        const srcTranscript = getTranscript(videoId, prefLangs);
        console.log(`[naze] Got ${srcTranscript.texts.length} entries in ${srcTranscript.lang}`);

        // Cố lấy thêm vi nếu có
        let viTranscript = null;
        if (srcTranscript.lang !== 'vi') {
            try { viTranscript = getTranscript(videoId, ['vi'], true); } catch (_) {}
        }

        // Ghép text thành câu liên tục (remove HTML tags, join)
        const joinTexts = (texts) => texts.map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
        const srcText = joinTexts(srcTranscript.texts);
        const viText = viTranscript ? joinTexts(viTranscript.texts) : null;

        // Placeholder cho parseSrt - không dùng nữa
        const viFile = viText ? '__vi__' : null;
        const targetFile = srcTranscript.lang === targetLang ? '__target__' : null;
        const anyFile = '__any__';
        const parseSrtText = (text) => text.split(/[.!?。！？]+/).map(s => s.trim()).filter(s => s.length > 5);

        // Hàm làm mịn sub bằng GPT-4o (gộp câu bị cắt, loại ký tự thừa)
        const smoothSub = async (sentences, lang) => {
            const langName = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish' }[lang] || lang;
            console.log(`[naze] Smoothing ${sentences.length} sentences in ${langName}...`);
            const text = sentences.join(' ');
            let r;
            try {
                r = await aiChat({
                    tier: 'std', temperature: 0.3, json: true,
                    messages: [
                        { role: 'system', content: `You are a subtitle editor. Given raw auto-generated subtitle text in ${langName}, clean it up:
1. Fix broken sentences (subtitles are often cut mid-sentence - rejoin them).
2. Remove filler words, stutters, repeated words.
3. Split into complete, natural sentences suitable for voice-over (10-25 words each).
4. KEEP all content and meaning, do NOT summarize or remove information.
5. Return ONLY a json object with an array of clean sentences: {"sentences": ["sentence 1", "sentence 2", ...]}` },
                        { role: 'user', content: text.slice(0, 12000) }
                    ],
                });
            } catch (e) { console.error(`[naze] GPT smooth error: ${e.message}`); return sentences; }
            const parsed = JSON.parse(r.content);
            const result = Array.isArray(parsed) ? parsed : Object.values(parsed)[0];
            console.log(`[naze] Smoothed: ${result.length} sentences`);
            const clean = (Array.isArray(result) ? result : sentences).map(s => String(s).replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
            return clean;
        };

        // Hàm dịch mảng câu
        const translateSentences = async (sentences, fromLang, toLang) => {
            const toLangName = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish' }[toLang] || toLang;
            console.log(`[naze] Translating ${sentences.length} sentences to ${toLangName}...`);
            const numbered = sentences.map((s, i) => `${i+1}. ${s}`).join('\n');
            let r;
            try {
                r = await aiChat({
                    tier: 'std', temperature: 0.2, json: true,
                    messages: [
                        { role: 'system', content: `Translate each numbered sentence to ${toLangName}. Keep numbering. Return json: {"sentences": ["translated 1", "translated 2", ...]}` },
                        { role: 'user', content: numbered.slice(0, 12000) }
                    ],
                });
            } catch (e) { console.error(`[naze] GPT translate error: ${e.message}`); return sentences; }
            const parsed = JSON.parse(r.content);
            return (parsed.sentences || sentences).map(s => String(s).replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
        };

        let viSentences, targetSentences;

        if (viText && srcTranscript.lang === targetLang) {
            // Có cả vi và target
            viSentences = await smoothSub(parseSrtText(viText), 'vi');
            targetSentences = await smoothSub(parseSrtText(srcText), targetLang);
        } else if (srcTranscript.lang === 'vi') {
            // Gốc là vi
            viSentences = await smoothSub(parseSrtText(srcText), 'vi');
            targetSentences = targetLang === 'vi' ? viSentences : await translateSentences(viSentences, 'vi', targetLang);
        } else {
            // Gốc là ngôn ngữ khác
            const detectedLang = srcTranscript.lang;
            const rawSents = await smoothSub(parseSrtText(srcText), detectedLang);
            if (targetLang === detectedLang) {
                targetSentences = rawSents;
            } else {
                targetSentences = await translateSentences(rawSents, detectedLang, targetLang);
            }
            viSentences = viText
                ? await smoothSub(parseSrtText(viText), 'vi')
                : await translateSentences(rawSents, detectedLang, 'vi');
        }

        // Căn chỉnh độ dài
        const maxLen = Math.max(viSentences.length, targetSentences.length);
        rawSentences = Array.from({ length: maxLen }, (_, i) => ({
            vi: viSentences[i] || viSentences[viSentences.length - 1] || '',
            target: targetSentences[i] || targetSentences[targetSentences.length - 1] || ''
        }));
        postTitleVi = projectId;
        console.log(`[naze] YouTube done: ${rawSentences.length} sentences`);
    } else {
        const topic = mode;
        projectId = args[1];
        targetLang = args[2] || 'vi';
        if (args[3]) genre = args[3];          // vẫn nhận genre ở vị trí cũ (tương thích lệnh cũ)
        caseInfo = topic;                       // chế độ text: chính topic là thông tin vụ việc
        if (!topic || !projectId) { console.error('Usage: node naze_content.js <topic> <projectId> [targetLang] [genre]'); process.exit(1); }
        console.log(`[naze] Topic: ${topic} | Lang: ${targetLang} | Genre: ${genre}`);
    }

    const result = rawSentences ? null : await (genre === 'drama' ? generateDramaContent(mode, targetLang) : generateContent(mode, targetLang));
    if (result) { rawSentences = result.sentences; postTitleVi = result.title_vi || result.title; }

    const db = await getDb();
    await db.run('INSERT OR IGNORE INTO Post (project_id, title, status, voice_content_type, target_lang, genre) VALUES (?, ?, ?, ?, ?, ?)',
        [projectId, postTitleVi || projectId, 'crawling', targetLang === 'vi' ? 'content_vi' : 'content', targetLang, genre === 'drama' ? 'drama' : 'naze']);
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;

    const paragraphIds = [];
    for (const [i, s] of rawSentences.entries()) {
        const paraRes = await db.run(
            'INSERT INTO Paragraph (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, s.target, s.vi, i + 1]
        );
        const paragraphId = paraRes.lastID;
        await db.run(
            'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [paragraphId, s.target, s.vi, 1]
        );
        paragraphIds.push({ index: i + 1, text: s.vi, paragraphId });
    }
    console.log(`[naze] ✅ Đã lưu ${rawSentences.length} câu vào DB`);

    // Kịch bản đã xong → kích hoạt gen voice (+lips) NGAY, chạy song song với crawl ảnh/video bên dưới.
    try {
        const http = await import('http');
        http.default.request({ hostname: 'localhost', port: process.env.PORT || 3000, path: '/api/auto-voice/run', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
            .end(JSON.stringify({ projectId }));
    } catch (_) {}

    // Cấu hình cào X (chỉ genre drama) — sinh keyword tiếng Nhật 1 LẦN từ toàn bộ vụ việc
    const X_PROFILE = process.env.X_PROFILE || 'chrome-profile-4';
    const X_TWEET_URLS = process.env.NAZE_TWEET_URLS || '';
    const xCaptureBudget = parseInt(process.env.X_CAPTURE_BUDGET || '5');
    let xKeywords = [];
    if (genre === 'drama') {
        // caseInfo = topic (chế độ text) hoặc nội dung SRT gốc (drama tạo từ 2 file SRT).
        // Trước đây truyền `mode`, mà ở chế độ --srt thì mode = chuỗi '--srt' → keyword X sinh ra từ rác.
        xKeywords = caseInfo.trim() ? await getXKeywordsJa(caseInfo) : [];
        console.log(`[X] keywords (JA): ${xKeywords.join(' | ') || '(none)'}`);
    }

    // TẮT cào stock + sinh keyword + từ gợi ý (mặc định) — ảnh/video cào về không dùng được mà tốn token.
    // Bật lại khi cần: đặt env NAZE_CRAWL_STOCK=on. (Drama luôn không cào stock, media lấy từ X.)
    const CRAWL_STOCK = process.env.NAZE_CRAWL_STOCK === 'on';

    // Crawl ảnh
    const emptyScenes = [];   // cảnh không lấy được ảnh nào (kể cả sau retry + fallback) → báo khi xong
    for (const { index, text, paragraphId } of paragraphIds) {
        console.log(`\n[${index}/${paragraphIds.length}] "${text.slice(0, 60)}..."`);
        let keywords = [];
        // Chỉ sinh keyword (factual) + từ gợi ý ảnh (image_suggestion) khi THỰC SỰ cào stock.
        // Tắt stock (mặc định) hoặc drama → bỏ 2 lệnh gọi GPT này để tiết kiệm token.
        if (CRAWL_STOCK && genre !== 'drama') {
            try {
                keywords = await getKeywordsFromGPT(text);
                console.log(`    Keywords: ${keywords.join(' | ')}`);
            } catch (e) {
                console.error(`    GPT loi: ${e.message}`);
                if (e.message.includes('401') || e.message.includes('429')) {
                    try {
                        const http = await import('http');
                        http.default.request({ hostname: 'localhost', port: process.env.PORT || 3000, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
                            .end(JSON.stringify({ postTitle: projectId, status: `❌ GPT: ${e.message}` }));
                    } catch (_) {}
                    process.exit(1);
                }
                continue;
            }

            await db.run('DELETE FROM Keyword WHERE paragraph_id = ?', [paragraphId]);
            for (const kw of keywords) {
                await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, kw, 'factual']);
            }

            // Sinh image_suggestion bằng GPT-4o-mini
            try {
                const sugRes = await aiChat({
                    tier: 'mini', temperature: 0.3,
                    messages: [
                        { role: 'system', content: 'You are an image/video suggestion expert. Read the given text and return a JSON array of Vietnamese search terms (5-8 terms) describing visuals that would illustrate the content. Return ONLY a JSON array, no explanation. Example: ["bầu trời đầy sao", "vũ trụ nhìn từ không gian", "trái đất từ vệ tinh"]' },
                        { role: 'user', content: text }
                    ],
                });
                {
                    const raw = sugRes.content || '[]';
                    let sugs = [];
                    try { sugs = JSON.parse(raw); } catch(_) {
                        const m = raw.match(/\[.*\]/s);
                        if (m) try { sugs = JSON.parse(m[0]); } catch(_) {}
                    }
                    for (const sug of sugs) {
                        if (sug) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, sug, 'image_suggestion']);
                    }
                    console.log(`    Gợi ý ảnh (${sugs.length}): ${sugs.slice(0,3).join(' | ')}`);
                }
            } catch(e) { console.error(`    Gợi ý ảnh lỗi: ${e.message}`); }
        }

        const imgDir = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', String(index));
        const vidDir = path.join(MEDIA_DIR, projectId, 'assets', '_raw_videos', String(index));
        const { mkdirSync, existsSync, readdirSync } = await import('fs');
        if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });
        if (!existsSync(vidDir)) mkdirSync(vidDir, { recursive: true });

        const syncDir = async (dir, type, exts) => {
            if (!existsSync(dir)) return;
            for (const file of readdirSync(dir)) {
                if (!exts.includes(path.extname(file).toLowerCase())) continue;
                const rel = path.relative(MEDIA_DIR, path.join(dir, file));
                const ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                if (!ex) await db.run('INSERT INTO Asset (paragraph_id, type, file_path) VALUES (?, ?, ?)', [paragraphId, type, rel]);
            }
        };

        // KHÔNG cào ảnh/video stock khi tắt stock (mặc định) hoặc drama (media lấy từ X).
        // Cào stock cho ra ảnh minh hoạ chung chung không dính nội dung → không dùng được, lại tốn thời gian.
        if (!CRAWL_STOCK) {
            console.log(`    [no-stock] bỏ qua cào ảnh/video cảnh ${index} (tắt để tiết kiệm; bật lại: NAZE_CRAWL_STOCK=on)`);
        } else if (genre === 'drama') {
            console.log(`    [drama] bỏ qua cào ảnh/video stock cho cảnh ${index} (media lấy từ X)`);
        } else {
            // Chạy tuần tự TỪNG CÁI 1 (ảnh xong rồi video) — tránh nhiều Puppeteer/tải đua nhau
            for (const kw of keywords) {
                const n = await crawlImagesForKeyword(kw, imgDir, IMAGES_PER_KEYWORD);   // Bing/Google + Pexels (+ Pixabay fallback)
                console.log(`      [${kw}] tổng ${n} ảnh`);
                // Video: Storyblocks + Pexels video (cả hai chạy, gộp kết quả)
                const [sb, px] = await Promise.all([
                    fetchFromStoryblocksBot(kw, 'video', vidDir, 4).catch(() => 0),
                    fetchFromPexelsVideo(kw, vidDir, 4).catch(() => 0),
                ]);
                console.log(`      [${kw}] video: Storyblocks ${sb || 0} + Pexels ${px || 0}`);
                await syncDir(imgDir, 'image', ['.jpg', '.jpeg', '.png', '.webp']);
                await syncDir(vidDir, 'video', ['.mp4', '.mov']);
            }
            // Cảnh vẫn trống ảnh (Google chặn + fallback cũng tịt) → ghi nhận để báo lại.
            // Drama không cào stock nên KHÔNG tính vào đây, kẻo cảnh nào cũng bị báo "thiếu ảnh" + bắn Slack.
            const imgLeft = readdirSync(imgDir).filter(f => ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(f).toLowerCase())).length;
            if (imgLeft === 0) { emptyScenes.push(index); console.warn(`    ⚠️ Cảnh ${index} KHÔNG có ảnh nào sau retry + fallback`); }
        }

        // ===== Cào X (Twitter) — CHỈ genre drama, chạy 1 LẦN, lưu ở block riêng section='x' =====
        if (genre === 'drama' && index === 1 && (xKeywords.length || X_TWEET_URLS.trim())) {
            try {
                for (const kw of xKeywords) {
                    if (kw) await db.run('INSERT INTO Keyword (post_id, section, content, type) VALUES (?, ?, ?, ?)', [postId, 'x', kw, 'x_ja']);
                }
                const xOut = path.join(MEDIA_DIR, projectId, 'assets', 'x');
                const insertAsset = async (absPath, type, srcUrl) => {
                    const rel = path.relative(MEDIA_DIR, absPath);
                    const ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                    if (!ex) await db.run('INSERT INTO Asset (post_id, section, type, file_path, source_url) VALUES (?, ?, ?, ?, ?)', [postId, 'x', type, rel, srcUrl || null]);
                };

                // (1) Search TRẦN + urls: giữ nguyên để CHỤP MÀN HÌNH tweet phản ứng (kể cả tweet chữ).
                //     Không gộp query media vào đây, kẻo tweet nhiều media chiếm hết suất chụp.
                const { manifest } = await crawlX({
                    profileName: X_PROFILE,
                    outDir: xOut,
                    keywords: xKeywords.join('|'),
                    urls: X_TWEET_URLS,
                    limit: 12, max: 12, captureMax: xCaptureBudget,
                });
                for (const t of manifest) {
                    for (const img of t.images) await insertAsset(img, 'image', t.url);
                    for (const vid of t.videos) await insertAsset(vid, 'video', t.url);
                    if (t.screenshot) await insertAsset(t.screenshot, 'image', t.url);
                    if (t.recording) await insertAsset(t.recording, 'video', t.url);
                }
                console.log(`    [X] ${manifest.length} bài (chụp màn hình) → block X`);

                // (2) Search RIÊNG cho media thật: filter:media gần như chỉ ra ẢNH,
                //     phải hỏi thêm filter:native_video mới có VIDEO (đo thực tế: 24 video vs 1).
                let mi = 0, mv = 0;
                if (xKeywords.length) {
                    try {
                        const { manifest: mm } = await crawlX({
                            profileName: X_PROFILE,
                            outDir: xOut,
                            keywords: xKeywords.flatMap(k => [`${k} filter:media`, `${k} filter:native_video`]).join('|'),
                            limit: 16, max: 32, captureMax: 0, maxImages: 5, maxVideos: 5,
                            scrapeTimeoutMs: 90000,
                        });
                        for (const t of mm) {
                            for (const img of t.images) { await insertAsset(img, 'image', t.url); mi++; }
                            for (const vid of t.videos) { await insertAsset(vid, 'video', t.url); mv++; }
                        }
                    } catch (e) { console.error(`    [X] lấy media lỗi: ${e.message}`); }
                }
                console.log(`    [X] +${mi} ảnh + ${mv} video từ search media riêng`);
            } catch (e) { console.error(`    [X] lỗi: ${e.message}`); }
        }

        // Xong 1 đoạn → báo dashboard hiện ngay assets (crawl tới đâu hiện tới đó)
        try {
            const http = await import('http');
            http.default.request({ hostname: 'localhost', port: process.env.PORT || 3000, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
                .end(JSON.stringify({ postTitle: projectId, scene: true }));
        } catch (_) {}
    }

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    if (emptyScenes.length) console.warn(`[naze] ⚠️ ${emptyScenes.length} cảnh thiếu ảnh: ${emptyScenes.join(', ')}`);
    // Báo hoàn tất (dashboard SSE + Slack) — status:null = crawl xong. Kèm cảnh thiếu ảnh (nếu có).
    try {
        const http = await import('http');
        http.default.request({ hostname: 'localhost', port: process.env.PORT || 3000, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
            .end(JSON.stringify({ postTitle: projectId, status: null, missingScenes: emptyScenes }));
    } catch (_) {}
    console.log('\n[naze] ✅ Hoàn thành!');
}

main().catch(e => { console.error('[naze] LỖI:', e.message); process.exit(1); });
