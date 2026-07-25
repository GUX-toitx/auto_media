import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'dotenv/config';
import https from 'https';
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { collectNews, DEFAULT_SOURCES } from '../news/news_pipeline.js';
import { normArticleUrl } from '../news/news_feeds.js';
import { collectFromXAccounts } from '../x/x_source.js';
import { crawlX } from '../x/x_crawler.js';
import { readStockSource } from '../lib/stockNaming.js';
import { setLogProject, logCrawlInfo, logCrawlError } from '../lib/crawlLogger.js';
import { resetXBrowseLog, appendXBrowse } from '../lib/xBrowseLog.js';
import { aiChat, aiStructured, aiProviderName, modelFor, logUsage } from '../lib/ai.js';

// Nuốt lỗi vô hại của puppeteer-extra-stealth khi tạo page lúc nhiều browser bung cùng lúc
// ("Requesting main frame too early!") — nếu không, unhandledRejection có thể kill cả tiến trình giữa chừng.
process.on('unhandledRejection', (err) => {
    const msg = (err && err.message) ? err.message : String(err);
    if (/main frame too early|Target closed|Session closed/i.test(msg)) return;
    console.error('[process_content] unhandledRejection:', msg);
});

const BASE_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || '/usr/gux/media-team/db';
const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');
const OPENAI_KEY = process.env.OPENAI_KEY;
const PORT = process.env.PORT || 3000;

const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

const args = process.argv.slice(2);
const getArg = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : '') || '';
const projectId = args[args.indexOf('--projectId') + 1];
const contentArg = getArg('--content');
const targetLang = getArg('--targetLang') || 'en';
const countryGl = getArg('--country');   // quốc gia ưu tiên (gl) cho Google News, rỗng = US
const countryHl = getArg('--clang');     // ngôn ngữ địa phương (hl)
const daysArg = parseInt(getArg('--days'), 10);
const newsDays = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 1;   // cửa sổ tin "when:Nd" (mặc định 1 ngày = chỉ tin trong 24h)
const seenFile = getArg('--seenFile');   // (monitor sheet) file JSON lưu tin đã xử lý → dedup xuyên lần chạy
// Crawl LẠI media cho project đã có (nút trên dashboard): chỉ cào lại ảnh/video, không đụng kịch bản/GPT.
// Điểm nội dung dưới ngưỡng này -> gọi GPT viết lại kịch bản, LẶP LẠI tới khi đạt ngưỡng (--rewriteBelow 0 để tắt).
const rewriteBelowArg = parseInt(getArg('--rewriteBelow'), 10);
const REWRITE_SCORE_THRESHOLD = Number.isFinite(rewriteBelowArg) ? rewriteBelowArg : 75;
// Số lần viết lại TỐI ĐA (chặn lặp vô hạn khi AI mãi không đạt ngưỡng). --rewriteMaxAttempts hoặc env GEO_REWRITE_MAX_ATTEMPTS.
const rewriteMaxArg = parseInt(getArg('--rewriteMaxAttempts'), 10);
const REWRITE_MAX_ATTEMPTS = Number.isFinite(rewriteMaxArg) && rewriteMaxArg > 0
    ? rewriteMaxArg : (Math.max(1, parseInt(process.env.GEO_REWRITE_MAX_ATTEMPTS, 10) || 4));
// Số luận điểm tối thiểu (chống GPT dồn cả bài vào 1 luận điểm → keyword nổ, media dồn 1 scene). GEO_MIN_LUAN_DIEM để chỉnh.
const GEO_MIN_LUAN_DIEM = Math.max(1, parseInt(process.env.GEO_MIN_LUAN_DIEM, 10) || 4);
const mediaOnly = args.includes('--mediaOnly');

// Kiểm tra cấu trúc kịch bản có "thoái hóa" không: quá ít luận điểm, hoặc luận cứ bị băm mỗi câu 1 luận cứ.
// Cấu trúc xấu → keyword_factual/cinematic của TỪNG luận cứ dồn hết vào 1 paragraph → crawl media/X nổ tung.
function analyzeStructure(result) {
    const lds = result.luan_diem || [];
    const numLd = lds.length;
    let numLc = 0, lcSent = 0;
    for (const ld of lds) {
        const lcs = ld.luan_cu || [];
        numLc += lcs.length;
        for (const lc of lcs) lcSent += (lc.content_sentences || []).length;
    }
    const avgSentPerLc = numLc ? lcSent / numLc : 0;
    const issues = [];
    if (numLd < GEO_MIN_LUAN_DIEM)
        issues.push(`chi co ${numLd} luan diem (BAT BUOC >= ${GEO_MIN_LUAN_DIEM}, moi luan diem = 1 khia canh phan tich)`);
    if (numLc >= 15 && avgSentPerLc < 1.5)
        issues.push(`luan cu bi bam nho: ${numLc} luan cu nhung trung binh chi ${avgSentPerLc.toFixed(1)} cau/luan cu (moi luan cu PHAI gom >= 2-3 cau content_sentences, KHONG tach moi cau thanh 1 luan cu)`);
    return { numLd, numLc, avgSentPerLc, issues };
}
const mediaOnlyPostId = parseInt(getArg('--postId'), 10);
const forceAll = args.includes('--force');   // mặc định: chỉ bù cảnh đang 0 asset

// LUỒNG MỚI: input là MẢNG TỪ KHÓA + MẢNG DOMAIN NGUỒN (JSON). Tổ hợp tất cả qua Google News.
function parseArr(raw) { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : []; } catch { return raw ? raw.split(/[|,\n]/).map(s => s.trim()).filter(Boolean) : []; } }
const keywords = parseArr(getArg('--keywords'));
if (!keywords.length && contentArg) keywords.push(contentArg);   // fallback: dùng --content như 1 từ khóa
// 4 nguồn mặc định (NTV, Yahoo, Japan Times, TBS NEWS DIG — xem news_feeds.js) LUÔN có mặt;
// --sources (cột 'Nguồn' của sheet / ô Nguồn trên UI) là nguồn BỔ SUNG, không phải thay thế.
const normDomain = (d) => String(d).trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
const sourceDomains = [...new Set([...DEFAULT_SOURCES, ...parseArr(getArg('--sources')).map(normDomain).filter(Boolean)])];
const topic = contentArg || keywords.join(', ');                 // tiêu đề/chủ đề cho GPT + đặt tên project
const sources = sourceDomains.join(', ');
const xAccounts = parseArr(getArg('--xAccounts'));               // list account X (cột 'Account X' của sheet geo)

if (mediaOnly) {
    if (!Number.isFinite(mediaOnlyPostId)) {
        console.error('[process_content] --mediaOnly cần --postId <id>');
        process.exit(1);
    }
} else if (!projectId || !keywords.length) {
    console.error('[process_content] Thiếu --projectId hoặc --keywords/--content');
    process.exit(1);
}

// Log crawl (ảnh stock Bing/Google) tách theo dự án: logs/<projectId>/crawl_{info,errors}_<ngày>.log.
// Không gọi cái này thì mọi dự án geo đổ chung vào logs/crawl_*_<ngày>.log — chỉ luồng naze mới tách,
// vì nó đi qua imageCrawlRotate (hàm duy nhất gọi setLogProjectFromDir).
if (projectId) setLogProject(projectId);

function stripLinks(text) {
    if (!text) return text;
    // Xoa markdown links: [text](url) -> text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Xoa trich dan cuoi cau: ([apnews.com](url)) hoac ([bloomberg.com])
    text = text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '');
    text = text.replace(/\s*\[\([^\]]*\)\]/g, '');
    text = text.replace(/\s*\(\[[^\]]*\]\)/g, '');
    // Xoa bare URLs
    text = text.replace(/https?:\/\/[^\s\)\"\']*/g, '');
    // Xoa ten domain trong ngoac: (apnews.com) (e.vnexpress.net) (en.sggp.org.vn)
    text = text.replace(/\s*\([a-zA-Z0-9][a-zA-Z0-9\-\.]*\.[a-zA-Z]{2,}\)/g, '');
    // Xoa tien to dau dong: Boi canh: / Dat van de: / Moi y: ...
    text = text.replace(/^(Bối cảnh( chung)?|Đặt vấn đề|Vấn đề|Mối ý|Ý mới|Ý nghĩa|Ý chính|Mở đầu|Dẫn nhập|Tóm lược|Kết luận|Phân tích|Nhận định|Bản chất|Hệ quả|Tác động|Thực trạng|Nguyên nhân|Diễn biến|Tổng quan|Luận điểm|Luận cứ|Kết quả|Giải pháp|Thách thức|Cơ hội|Rủi ro|Xu hướng|Bải học|Khái quát|Giới thiệu|Nhận xét|Tóm tắt|Nhìn lại|Tiếp theo|Trước tiên|Thứ nhất|Thứ hai|Thứ ba|Cuối cùng)\s*:\s*/gim, '');
    // Xoa khoang trang thua
    text = text.replace(/\s{2,}/g, ' ').trim();
    return text;
}

async function translateText(text, lang) {
    if (!lang || lang === 'vi') return text;
    try {
        const { content } = await aiChat({
            tier: 'mini', temperature: 0.2,
            messages: [
                { role: 'system', content: `Translate to ${lang}. Return ONLY translated text, no explanation.` },
                { role: 'user', content: text },
            ],
        });
        return content?.trim() || text;
    } catch (e) { console.warn('[process_content] dịch lỗi:', e.message); return text; }
}

function httpsGet(url) {
    return new Promise((resolve) => {
        try {
            const urlObj = new URL(url);
            const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET', family: 4, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 };
            const req = https.request(options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const location = res.headers.location;
                    // Handle relative redirect
                    const redirectUrl = location.startsWith('http') ? location : `${urlObj.protocol}//${urlObj.hostname}${location}`;
                    return httpsGet(redirectUrl).then(resolve);
                }
                if (res.statusCode !== 200) return resolve(null);
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        } catch(e) {
            resolve(null);
        }
    });
}

function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const data = JSON.stringify(body);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            family: 4,
            headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
        };
        const req = https.request(options, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// GET đơn giản (theo redirect, resolve URL tương đối, có timeout + cookie consent) cho RSS/trang báo/YouTube
function httpGet(url, depth = 0) {
    return new Promise((resolve, reject) => {
        const req = (url.startsWith('http://') ? http : https).get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': 'CONSENT=YES+1', 'Accept-Language': 'en-US,en;q=0.9' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
                res.resume();
                return httpGet(new URL(res.headers.location, url).href, depth + 1).then(resolve, reject);
            }
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

const decodeXml = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');

// Phát hiện quốc gia/ngôn ngữ liên quan từ chủ đề -> truy vấn tiếng Anh + tiếng địa phương (gpt-4o-mini)
async function detectRegionQueries(topic) {
    const forced = countryGl && countryHl; // người dùng chọn quốc gia ở giao diện
    try {
        const sys = forced
            ? `Người dùng đưa chủ đề tin tức (tiếng Việt). Quốc gia ưu tiên: ${countryGl}, ngôn ngữ địa phương (mã hl): ${countryHl}. Trả JSON: {"en":"<truy vấn tìm kiếm tiếng Anh, gồm quốc gia + chủ đề>","local":"<truy vấn bằng ngôn ngữ ${countryHl}>"}. CHỈ trả JSON.`
            : 'Người dùng đưa một chủ đề tin tức (tiếng Việt). Trả về JSON: {"en":"<truy vấn tìm kiếm tiếng Anh, gồm quốc gia + chủ đề chính>","local":"<truy vấn bằng ngôn ngữ chính của quốc gia liên quan, để rỗng nếu mang tính toàn cầu hoặc không rõ nước>","hl":"<mã ngôn ngữ địa phương: ja, zh-Hans, ko, ru, fr, de, ar...; rỗng nếu không>","gl":"<mã quốc gia: JP, CN, KR, RU, FR, DE, IL...; rỗng nếu không>"}. CHỈ trả JSON.';
        const { content } = await aiChat({
            tier: 'mini', temperature: 0, json: true,
            messages: [{ role: 'system', content: sys }, { role: 'user', content: topic }],
        });
        const j = JSON.parse(content);
        if (forced) { j.hl = countryHl; j.gl = countryGl; } // ép theo lựa chọn người dùng
        return j;
    } catch (e) { return forced ? { en: topic, local: '', hl: countryHl, gl: countryGl } : null; }
}

// Lấy tin thật 24h từ Google News — nhiều "edition" theo vùng: nước liên quan + quốc tế (Anh) + VN
async function fetchGoogleNews(topic, maxItems = 30) {
    const reg = await detectRegionQueries(topic);
    const editions = [];
    // Ưu tiên báo nước được nhắc tới (ngôn ngữ địa phương)
    if (reg && reg.local && reg.hl && reg.gl) editions.push({ q: reg.local, hl: reg.hl, gl: reg.gl, tag: reg.gl });
    // Quốc tế tiếng Anh — dùng en-GB (en-US bị chặn/redirect từ server), query tiếng Anh
    editions.push({ q: (reg && reg.en) || topic, hl: 'en-GB', gl: 'GB', tag: 'Quốc tế' });
    // Tiếng Việt
    editions.push({ q: topic, hl: 'vi', gl: 'VN', tag: 'VN' });

    const seen = new Set(), out = [];
    for (const ed of editions) {
        try {
            const ceidLang = ed.hl.split('-')[0];
            const url = `https://news.google.com/rss/search?q=${encodeURIComponent(ed.q + ' when:1d')}&hl=${ed.hl}&gl=${ed.gl}&ceid=${ed.gl}:${ceidLang}`;
            const xml = await httpGet(url);
            let n = 0;
            for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
                if (n >= 25) break;
                const b = m[1];
                const title = decodeXml((b.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
                const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
                const source = decodeXml((b.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '').trim());
                const link = decodeXml((b.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim());
                const key = title.toLowerCase().slice(0, 50);
                if (title && link && !seen.has(key)) { seen.add(key); out.push({ title, pub, source, link, tag: ed.tag }); n++; }
            }
            console.log(`[news][gnews] ${ed.tag} (${ed.hl}/${ed.gl}) "${ed.q.slice(0, 40)}": ${n} bài`);
        } catch (e) { console.error(`[news][gnews] ${ed.tag} lỗi:`, e.message); }
    }
    console.log(`[process_content] Google News: ${out.length} bài (nước liên quan + quốc tế + VN)`);
    return { items: out.slice(0, maxItems), editions, reg };
}

// ===== Pool ảnh THEO CHỦ ĐỀ: Bing image search theo truy vấn từng edition (ảnh báo thật, đúng chủ đề) =====
// Giải mã chuỗi bị HTML-entity + \uXXXX trong thuộc tính m="..." của Bing
const decodeBing = (s) => decodeXml(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');
async function fetchTopicImagePool(editions, maxPerQuery = 40) {
    const pool = [], seen = new Set();
    for (const ed of (editions || [])) {
        try {
            // filterui: ảnh photo, ưu tiên 7 ngày gần nhất để bám tin thời sự
            const url = `https://www.bing.com/images/search?q=${encodeURIComponent(ed.q)}&qft=+filterui:photo-photo+filterui:age-lt10080&form=HDRSC2`;
            const html = await httpGet(url);
            let n = 0;
            for (const m of html.matchAll(/\sm="([^"]+)"/g)) {
                const j = m[1];
                if (!j.includes('&quot;murl&quot;')) continue;
                let img = j.match(/&quot;murl&quot;:&quot;(.*?)&quot;/)?.[1];
                if (!img) continue;
                img = decodeBing(img);
                if (!/^https?:\/\//.test(img) || /\.svg($|\?)/i.test(img)) continue;
                const title = decodeBing(j.match(/&quot;t&quot;:&quot;(.*?)&quot;/)?.[1] || ed.q);
                if (!seen.has(img)) { seen.add(img); pool.push({ title, img }); n++; }
                if (n >= maxPerQuery) break;
            }
            console.log(`[news][IMG-search] ${ed.tag} "${ed.q.slice(0, 40)}": ${n} ảnh`);
        } catch (e) { console.error(`[news][IMG-search] ${ed.tag} lỗi:`, e.message); }
    }
    console.log(`[process_content] Topic image pool: ${pool.length} ảnh (Bing image search theo chủ đề)`);
    pool.slice(0, 3).forEach((a, i) => console.log(`[news][IMG] ví dụ ${i + 1}: "${a.title.slice(0, 45)}" -> ${a.img.slice(0, 70)}`));
    return pool;
}

// ===== Pool video THEO CHỦ ĐỀ: YouTube search theo truy vấn từng edition =====
async function fetchTopicVideoPool(editions, maxPerQuery = 20) {
    const pool = [], seen = new Set();
    for (const ed of (editions || [])) {
        try {
            const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(ed.q)}&hl=${ed.hl.split('-')[0]}&gl=${ed.gl}`;
            const html = await httpGet(url);
            const re = /"videoRenderer":\{"videoId":"([\w-]{11})".*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
            let n = 0, m;
            while ((m = re.exec(html)) && n < maxPerQuery) {
                const vid = m[1];
                let title = m[2];
                try { title = JSON.parse('"' + title + '"'); } catch { }
                if (!seen.has(vid)) { seen.add(vid); pool.push({ title, url: `https://www.youtube.com/watch?v=${vid}` }); n++; }
            }
            console.log(`[news][YT-search] ${ed.tag} "${ed.q.slice(0, 40)}": ${n} video`);
        } catch (e) { console.error(`[news][YT-search] ${ed.tag} lỗi:`, e.message); }
    }
    console.log(`[process_content] Topic video pool: ${pool.length} video (YouTube search theo chủ đề)`);
    pool.slice(0, 3).forEach((a, i) => console.log(`[news][YT] ví dụ ${i + 1}: "${a.title.slice(0, 50)}" -> ${a.url}`));
    return pool;
}

// ===== (Dự phòng) Ảnh tin từ RSS các báo cố định — chỉ dùng khi pool theo chủ đề rỗng =====
const NEWS_FEEDS = [
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://vnexpress.net/rss/the-gioi.rss',
    'http://rss.cnn.com/rss/edition_world.rss',
    'https://moxie.foxnews.com/google-publisher/world.xml',
];

// Tải 1 ảnh về file (theo redirect, bỏ ảnh quá nhỏ)
function downloadBinary(url, destPath, depth = 0) {
    return new Promise((resolve, reject) => {
        const req = (url.startsWith('http://') ? http : https).get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 4) {
                res.resume();
                return downloadBinary(new URL(res.headers.location, url).href, destPath, depth + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('status ' + res.statusCode)); }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (buf.length < 4000) return reject(new Error('too small')); // bỏ placeholder/icon
                fs.writeFileSync(destPath, buf);
                resolve(buf.length);
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

const tokenize = (s) => (s || '').toLowerCase().split(/[^a-zà-ỹ0-9]+/i).filter(w => w.length >= 4);

// Lấy pool bài có ảnh từ các feed
async function fetchNewsPool(maxPerFeed = 50) {
    const pool = [], seen = new Set();
    let feedIdx = 0;
    for (const feed of NEWS_FEEDS) {
        const host = (feed.match(/\/\/([^/]+)/) || [])[1] || feed;
        try {
            const xml = await httpGet(feed);
            const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, maxPerFeed);
            // Dump cấu trúc thô 1 item của feed đầu tiên để xem RSS trông như thế nào
            if (feedIdx === 0 && items[0]) {
                console.log(`[news][RSS][raw] cấu trúc 1 <item> của ${host}:\n` + items[0][1].trim().slice(0, 600));
            }
            let withImg = 0;
            for (const m of items) {
                const b = m[1];
                const title = decodeXml((b.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
                let img = b.match(/<media:(?:content|thumbnail)[^>]+url="([^"]+)"/i)?.[1]
                    || b.match(/<enclosure[^>]+url="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i)?.[1]
                    || (b.match(/<(?:description|content:encoded)>([\s\S]*?)<\/(?:description|content:encoded)>/i)?.[1] || '').match(/https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp)/i)?.[0];
                // Nâng kích thước ảnh BBC (mặc định 240px -> 976px)
                if (img && img.includes('ichef.bbci.co.uk')) img = img.replace(/\/standard\/\d+\//, '/standard/976/').replace(/\/news\/\d+\//, '/news/976/');
                if (title && img && !seen.has(img)) { seen.add(img); pool.push({ title, img }); withImg++; }
            }
            console.log(`[news][RSS] ${host}: ${items.length} item, ${withImg} có ảnh`);
        } catch (e) { console.error(`[news][RSS] ${host} lỗi:`, e.message); }
        feedIdx++;
    }
    console.log(`[process_content] News pool: ${pool.length} bài có ảnh (từ ${NEWS_FEEDS.length} feed)`);
    pool.slice(0, 3).forEach((a, i) => console.log(`[news][RSS] ví dụ ${i + 1}: "${a.title.slice(0, 50)}" -> ${a.img.slice(0, 75)}`));
    return pool;
}

// Chọn bài tin có tiêu đề khớp nhất với token của paragraph (dùng cho cả ảnh và video)
function pickNews(pool, tokens, n, used) {
    return pool.filter(a => !used.has(a.img || a.url))
        .map(a => ({ a, score: tokens.reduce((s, w) => s + (a.title.toLowerCase().includes(w) ? 1 : 0), 0) }))
        .filter(x => x.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, n).map(x => x.a);
}

// ===== Video tin thật từ kênh YouTube hãng tin (tải bằng yt-dlp) =====
const YT_NEWS_CHANNELS = [
    'UC16niRr50-MSBwiO3YDb3RA', // BBC News
    'UCknLrEdhRCp1aegoMqRaCZg', // DW News
    'UCNye-wNBqNL5ZzHSJj3l8Bg', // Al Jazeera English
    'UChqUTb7kYRX8-EiaN3XFrSQ', // Reuters
    'UCabsTV34JwALXKGMqHpvUiA', // VTV24
    'UCinkijG72G87sn-mtaFJTbA', // VTC14
    'UCmBT5CqUxf3-K5_IU9tVtBg', // ANTV
    'UCHCos7l5Nol2OZfFFkDXckg', // VOV
];

async function fetchNewsVideoPool(maxPerCh = 25) {
    const pool = [], seen = new Set();
    let chIdx = 0;
    for (const ch of YT_NEWS_CHANNELS) {
        try {
            const xml = await httpGet(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`);
            const chName = decodeXml((xml.match(/<title>([^<]+)<\/title>/)?.[1] || ch).trim());
            const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, maxPerCh);
            // Dump cấu trúc thô 1 entry của kênh đầu tiên
            if (chIdx === 0 && items[0]) {
                console.log(`[news][YT][raw] cấu trúc 1 <entry> của ${chName}:\n` + items[0][1].trim().slice(0, 600));
            }
            let n = 0;
            for (const m of items) {
                const b = m[1];
                const vid = b.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
                const title = decodeXml((b.match(/<media:title>([\s\S]*?)<\/media:title>/)?.[1] || b.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim());
                if (vid && title && !seen.has(vid)) { seen.add(vid); pool.push({ title, url: `https://www.youtube.com/watch?v=${vid}` }); n++; }
            }
            console.log(`[news][YT] ${chName}: ${n} video`);
        } catch (e) { console.error(`[news][YT] kênh ${ch} lỗi:`, e.message); }
        chIdx++;
    }
    console.log(`[process_content] News video pool: ${pool.length} video (từ ${YT_NEWS_CHANNELS.length} kênh)`);
    pool.slice(0, 3).forEach((a, i) => console.log(`[news][YT] ví dụ ${i + 1}: "${a.title.slice(0, 50)}" -> ${a.url}`));
    return pool;
}

// Tải 1 video YouTube (cap 720p cho nhẹ, bỏ video > 15 phút, không tải playlist)
function downloadYtVideo(url, destPath) {
    return new Promise((resolve, reject) => {
        const args = ['--no-warnings', '--no-playlist',
            '-f', 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '--match-filter', 'duration < 900',
            '--user-agent', 'Mozilla/5.0', '-o', destPath, url];
        const p = spawn('yt-dlp', args);
        let err = '';
        p.stderr.on('data', d => err += d);
        p.on('close', code => code === 0 ? resolve(true) : reject(new Error((err.split('\n')[0] || 'code ' + code))));
        p.on('error', reject);
    });
}

// Gom tat ca cap song ngu {vi, en} trong ket qua GPT (hook + ket + luan diem + luan cu).
function collectBilingualPairs(result) {
    const pairs = [];
    const push = (arr) => { for (const p of (arr || [])) if (p && typeof p === 'object') pairs.push(p); };
    push(result.hook_sentences);
    push(result.conclusion_sentences);
    for (const ld of (result.luan_diem || [])) {
        push(ld.content_sentences);
        for (const lc of (ld.luan_cu || [])) push(lc.content_sentences);
    }
    return pairs;
}

// Tien to ngon ngu model hay nhet vao dau chuoi: "ja: ...", "en：..."
const LANG_PREFIX_RE = /^\s*(ja|jp|japanese|en|english|target|vi|vietnamese)\s*[:：]\s*/i;

// Luoi an toan cho ban target (tieng Nhat) truoc khi ghi DB:
//   1. Model dat sai ten key (ja/jp/target) -> map ve 'en'
//   2. Bo tien to ngon ngu thua o dau chuoi
//   3. Cau nao van thieu ban target -> dich bu tu tieng Viet
// Khong co buoc nay thi mot lan GPT tra 'en' rong la ca project mat sub (xem post 473).
async function ensureTargetSentences(result) {
    const pairs = collectBilingualPairs(result);
    if (!pairs.length) return;

    let renamed = 0, stripped = 0;
    const missing = [];
    for (const p of pairs) {
        if (!(typeof p.en === 'string' && p.en.trim())) {
            const alt = [p.ja, p.jp, p.target, p.JA].find(v => typeof v === 'string' && v.trim());
            if (alt) { p.en = alt; renamed++; }
        }
        for (const k of ['vi', 'en']) {
            if (typeof p[k] === 'string' && LANG_PREFIX_RE.test(p[k])) {
                p[k] = p[k].replace(LANG_PREFIX_RE, '').trim();
                stripped++;
            }
        }
        if (!(typeof p.en === 'string' && p.en.trim())) missing.push(p);
    }
    if (renamed) console.warn(`[process_content] ⚠ ${renamed} câu GPT trả sai tên key (ja/jp/target) → đã map về 'en'`);
    if (stripped) console.warn(`[process_content] ⚠ ${stripped} câu dính tiền tố ngôn ngữ ("ja: ") → đã bỏ`);
    if (!missing.length) return;

    const queue = missing.filter(p => typeof p.vi === 'string' && p.vi.trim());
    console.warn(`[process_content] ⚠ ${missing.length}/${pairs.length} câu thiếu bản ${targetLang} → dịch bù từ tiếng Việt (${queue.length} câu dịch được)`);

    // Dich song song 5 luong cho do lau (kich ban thuong 90-110 cau).
    let idx = 0, filled = 0;
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => {
        while (idx < queue.length) {
            const p = queue[idx++];
            const t = await translateText(p.vi, targetLang);
            // translateText tra lai nguyen van tieng Viet khi loi -> khong nhan, de rong con hon sub sai ngon ngu.
            if (t && t.trim() && t.trim() !== p.vi.trim()) { p.en = t.trim(); filled++; }
        }
    }));
    console.warn(`[process_content] ⚠ dịch bù xong: ${filled}/${queue.length} câu`);
}

// Schema JSON của kịch bản song ngữ — dùng chung cho bước sinh mới và bước viết lại theo đánh giá.
const SCRIPT_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        hook_sentences: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    vi: { type: 'string' },
                    en: { type: 'string' }
                },
                required: ['vi', 'en'],
                additionalProperties: false
            }
        },
        hook_keywords_factual: { type: 'array', items: { type: 'string' } },
        hook_keywords_cinematic: { type: 'array', items: { type: 'string' } },
        luan_diem: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    title_vi: { type: 'string' },
                    title_target: { type: 'string' },
                    content_sentences: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                vi: { type: 'string' },
                                en: { type: 'string' }
                            },
                            required: ['vi', 'en'],
                            additionalProperties: false
                        }
                    },
                    keywords_factual: { type: 'array', items: { type: 'string' } },
                    keywords_cinematic: { type: 'array', items: { type: 'string' } },
                    luan_cu: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                // Luận cứ KHÔNG có title riêng (bỏ theo yêu cầu) — chỉ còn nội dung + keyword.
                                content_sentences: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            vi: { type: 'string' },
                                            en: { type: 'string' }
                                        },
                                        required: ['vi', 'en'],
                                        additionalProperties: false
                                    }
                                },
                                keywords_factual: { type: 'array', items: { type: 'string' } },
                                keywords_cinematic: { type: 'array', items: { type: 'string' } }
                            },
                            required: ['content_sentences', 'keywords_factual', 'keywords_cinematic'],
                            additionalProperties: false
                        }
                    }
                },
                // Đã xóa image và video khỏi required
                required: ['title_vi', 'title_target', 'content_sentences', 'keywords_factual', 'keywords_cinematic', 'luan_cu'],
                additionalProperties: false
            }
        },
        conclusion_sentences: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    vi: { type: 'string' },
                    en: { type: 'string' }
                },
                required: ['vi', 'en'],
                additionalProperties: false
            }
        },
        conclusion_keywords_factual: { type: 'array', items: { type: 'string' } },
        conclusion_keywords_cinematic: { type: 'array', items: { type: 'string' } },
    },
    required: [
        'title',
        'hook_sentences',
        'hook_keywords_factual',
        'hook_keywords_cinematic',
        'luan_diem',
        'conclusion_sentences',
        'conclusion_keywords_factual',
        'conclusion_keywords_cinematic',
    ],
    additionalProperties: false
};

async function analyzeWithGPT5(topic, newsTitles, sources) {
    // Tin thật từ Google News (đã thu thập sẵn theo từ khóa + nguồn) — GPT bám sự kiện có thật, không bịa
    const news = newsTitles || [];
    const newsBlock = news.length ? [
        'NGUON TIN THUC TE (Google News, moi nhat & sat nhat theo tu khoa + nguon) — BAT BUOC bam vao cac su kien co that duoi day, KHONG duoc bia su kien ngoai danh sach:',
        ...news.map((a, i) => `${i + 1}. ${a.title}${a.source ? ' — ' + a.source : ''}`),
        '',
    ] : [];

    const input = [
        'TAO NOI DUNG YOUTUBE DIA CHINH TRI THE GIOI THEO KIEU CINEMATIC STORYTELLING (THI TRUONG NHAT BAN)',
'',
'CHU DE: ' + topic,
'',
...newsBlock,
'',
'MUC TIEU:',
'- Tao bai phan tich dia chinh tri theo phong cach thoi su/documentary hien dai danh rieng cho thi truong Nhat Ban.',
'- PHONG CACH PHAN TICH STORYTELLING: 70% phan tich bao chi thuc te (thong tin, du lieu, dien bien, logic nguyen nhan - hau qua) + 30% dan chuyen storytelling cuon hut de giu retention cao.',
'- TUYET DOI KHONG DUNG PHEP AN DU: Khong dung cac tu ngu mang tinh an dụ, triet ly, van chuong bay borig hay kich hoa. Viet theo giong bao chi phan tich thoi su truyen hinh khach quan, chinh xac, de hieu.',
'- Giong mot geopolitical documentary chuyen nghiep nhu NHK Special / BBC.',
'- DO DAI TARGET: Dat thoi luong voice-over 8-10 phut nhung KHONG DUOC NOI LAN MAN. Do dai phai den tu CHIEU SAU THONG TIN va GOC NHIN.',
'',
'CHI TIEU SO LUONG OBJECT JSON (BAT BUOC DE DAT 8-10 PHUT):',
'- TOAN BAI BAT BUOC PHAI XUAT DU TU 90 DEN 110 OBJECT JSON (Chinh la 90-110 cau thoai doc lap).',
'- PHAN BO SO LUONG OBJECT CUNG NHU SAU:',
'  + MO BAI: Bat buoc dung tu 5 den 8 Object JSON.',
'  + THAN BAI: Bat buoc co tu 80 den 90 Object JSON.',
'  + KET BAI: Bat buoc dung tu 5 den 8 Object JSON.',
'- TONG SO OBJECT DUOI 90 LA THAT BAI.',
'',
'CAU TRUC LUAN DIEM / LUAN CU (BAT BUOC — CHONG DON HET VAO 1 LUAN DIEM):',
'- Than bai BAT BUOC chia thanh IT NHAT ' + GEO_MIN_LUAN_DIEM + ' luan diem (luan_diem), moi luan diem la 1 khia canh phan tich rieng theo 6 khia canh o tren.',
'- Moi luan cu (luan_cu) PHAI gom NHIEU cau content_sentences (3-6 cau) cung mach y — TUYET DOI KHONG tach moi cau thanh 1 luan cu rieng.',
'- keywords_factual / keywords_cinematic cho moi luan diem/luan cu chi can 2-4 tu khoa moi loai, sat noi dung — KHONG liet ke tran lan.',
'',
'QUY TAC NGHIEP NGAC: TUYET DOI KHONG TAO OBJECT CHUA TIEU DE / NHAN PHAN DOAN (CRITICAL FIX):',
'- TUYET DOI KHONG duoc tao bat ky Object JSON nao chi de chua ten tieu de, ten lop hay ten phan doan.',
'- CAM TOAN BO CAC CUM TU NHAN TRONG CA TIENG VIET VOI TIENG NHAT:',
'  + Khong duoc co cac cau nhu: "Lop 1...", "Lop 2...", "Su kien be noi:", "Boi canh lich su:", "Dong co an:", "Tac dong nguoi dan:", "Ban do an ninh:", "Kich ban 3-5 nam:".',
'  + Cấm tuyệt đối tiếng Nhật: 「表層の動き」「歴史の文脈」「内在する動機」「生活への波及」「海の安全保障」「シナリオ」「問い」「逆説」「第一章」...',
'- MOI OBJECT JSON PHAI LA MOT CAU THOAI TRUOC TIEP CUNG CAP THONG TIN/PHAN TICH. Toan bo danh sach Object phai la DONG THOAI KHI DOC NOI TIEP NHAU THA THUAM KHONG BI NGAT NHO BOI TIEU DE.',
'',
'QUY TAC TRIEN KHAI NOI DUNG THAN BAI (DE TUDUYT LOGIC, KHONG IN TIEN LOP RA TEXT):',
'- Noi dung Than bai phai lan luot di qua 6 khia canh phan tich thuc te sau:',
'  1. Dien bien thuc te va su kien be noi moi nhat.',
'  2. Boi canh lich su va cac tien le tuong tu trong qua khu.',
'  3. Dong co an noi bo cua cac ben va tinh toan ngoai giao thuc te.',
'  4. Tac dong den doi song, vi tien, ty gia Yen, gia xang, hoa don dien cua nguoi dan Nhat Ban.',
'  5. Tuyen duong hang hai (Sea Lanes) va thoi tran an ninh tai khu vuc Senkaku.',
'  6. Kich ban du bao tuong lai trong 3-5 nam toi.',
'',
'LAP TRUONG CHU QUYEN & AN NINH QUOC GIA NHAT BAN (BAT BUOC):',
'- LUON DUNG TREN LAP TRUONG CHU QUYEN VA LOI ICH QUOC GIA CUA NHAT BAN.',
'- QUY TAC TEN GOI:',
'  + BAT BUOC dung "尖閣諸島" (Quan dao Senkaku). TUYET DOI KHONG nhac ten tieng Trung (Dieu Ngu/Diaoyu) hay cach goi trung lap cua ben thu ba.',
'  + Goi hanh vi tau nuoc ngoai vao vung bien Senkaku la "領海侵入" (Xam nhap hai phan) hoac "接続水域の入域" (Vao vung tiep giap).',
'  + Goi hanh dong cua Luc luong Bao ve bo bien Nhat (JCG) la "警告・排除" (Canh bao/Tuyen truyen canh gioi de bao ve trat tu phap ly).',
'- GOC NHIN DIA CHINH TRI: Moi su kien quoc te deu phai lien ket voi an ninh va kinh te Nhat Ban.',
'',
'VAN HOA & VAN PHONG NHAT BAN:',
'- Binh tinh, diem tinh (冷静), khach quan va kiem che. TUYET DOI KHONG giat gan re tien, KHONG ho hao.',
'- BAT BUOC DUNG THE VAN CHOTAI (常体) CHUYEN NGHIEP NHK SPECIAL:',
'  + Su dung linh hoat va da dang cac kieu ket cau CHOTAI: だ, である, のだ, 体言止め (ngu phap danh tu hoa cuoi cau), ...のだ/である.',
'  + TUYET DOI KHONG KET THUC TAT CA CAC CAU BANG MOT TU "だ".',
'',
'QUY TAC CHUYEN LUAN CU & TRANSITIONS (DE KICH BAN CUC KY MUOT MA):',
'- MOI KHI CHUYEN SANG LUAN CU MOI, BAT BUOC phai co 1-2 cau chuyen doan (Narrative Bridge) dua tren logic nguyen nhan - hau qua hoac thuc te doi lap.',
'- NÊN DÙNG CAC TU NOI TAO NHIP DOCUMENTARY: "しかし、本当の焦点は…", "この状況の裏で…", "数字が示す現実は…", "安全保障の議論と同時に…"',
'',
'MO BAI: (BAT BUOC DU 5 - 8 OBJECT SONG NGU)',
'- Nêu ngay su kien trung tam, di vao thuc te van de, dat ra nghi van/khia canh chinh can phan tich. Tuyet doi khong in nhan tiêu đề.',
'',
'THAN BAI: (BAT BUOC DU 80 - 90 OBJECT SONG NGU)',
'- Phai phan tich chi tiet qua du 6 khia canh goc nhin da neu o tren. Tuyet doi khong in bat ky nhan tieu de nao.',
'',
'KET BAI: (BAT BUOC DU 5 - 8 OBJECT SONG NGU)',
'- Tong ket ngan gon logic van de va keu goi dang ky kenh, de lai binh luan mot cach tu nhien.',
'',
'TUYET DOI KHONG:',
'- KHONG LAP LAI TU / CAU HUU HAN THANH VONG LAP (Chong lap tu vo han nhu "だ。だ。だ。").',
'- KHONG viet theo dang bao cao hoc thuat kho hieu, cung khong viet kieu van hoc bay borig.',
'- KHONG viet long vong, noi di noi lai 1 y.',
'',
'QUY DINH NGON NGU DANG SONG NGU (TOI UU TOAN BO OUTPUT TOKEN):',
'- Ngon ngu muc tieu: _target = ' + targetLang + ' (Chinh la TIENG NHAT / JAPANESE).',
'- BAT BUOC: Tat ca content_sentences, hook_sentences, conclusion_sentences PHAI LA ARRAY CUA CAC OBJECT SONG NGU CAP {vi, en}.',
'- TEN KEY CHI DUOC LA "vi" VA "en" (dung y nhu schema). TUYET DOI KHONG dat ten key la "ja", "jp", "target"... — schema se tu choi va cau do bi MAT.',
'- Truong [vi] (O BEN TRAI): Phai la TIENG VIET dich muot, tu nhien, de hieu.',
'- Truong [en] (O BEN PHAI): KEY TEN LA "en" NHUNG NOI DUNG BAT BUOC LA TIENG NHAT chuan van phong NHK (duoi cau CHOTAI).',
'  + TUYET DOI KHONG de rong, KHONG viet tieng Anh, KHONG chep lai y nguyen tieng Viet.',
'  + KHONG them tien to ngon ngu vao dau chuoi (khong viet "ja: ...", "en: ...") — chi ghi noi dung thuan.',
'  [',
'    {',
'      vi: "Tokyo đang vẽ lại một tấm bản đồ mới cho an ninh.",',
'      en: "東京は安全保障の新たな地図を描き直している。"',
'    }',
'  ]',
'',
'MEDIA KEYWORDS:',
'- Voi moi object sentence, BAT BUOC tao keywords_factual (su kien) va keywords_cinematic (nghe thuat) bang tieng Anh.',
'',
'OUTPUT PHAI CAM GIAC NHU:',
'- Mot bai phan tich thoi su dia chinh tri thuc te, khach quan, chinh xac, dai va sau (Dat du 90-110 Object JSON), de hieu va doc lien tuc khong dinh bat ky nhan tieu de nao.'
            ].join('\n');

    console.log(`[process_content] Gọi ${aiProviderName()} (${modelFor('main')}) sinh kịch bản cho: ${topic}`);

    const { outputText, usage } = await aiStructured({
        schema: SCRIPT_SCHEMA,
        schemaName: 'phan_tich_dia_chinh_tri',
        input,
        effort: 'medium',
        maxTokens: 40000,
        webSearch: true,      // OpenAI dùng web_search_preview; DeepSeek tự bỏ qua
    });
    logUsage('process_content', usage);

    // Log output GPT để phân tích
    console.log('[process_content] === GPT OUTPUT ===');
    console.log(outputText);
    console.log('[process_content] === END GPT OUTPUT ===');
    
    const result = JSON.parse(outputText);
    // Vá bản target (tiếng Nhật) nếu GPT trả sai key / bỏ trống -> tránh mất sub cả project.
    await ensureTargetSentences(result);
    result._news = news;   // danh sách tiêu đề tin (để ghi log RSS)
    return result;
}

// Chấm điểm CHẤT LƯỢNG kịch bản địa chính trị (0-100) bằng 1 lần gọi GPT nữa (gpt-4o-mini, rẻ).
// Trả { score, reason, detail } (detail = object đánh giá chi tiết) hoặc null nếu lỗi.
async function scoreContentWithGPT(result) {
    try {
        // Ghép toàn bộ kịch bản (ngôn ngữ đích) để đưa GPT chấm
        const parts = [];
        if (result.title) parts.push('TIÊU ĐỀ: ' + result.title);
        const hook = (result.hook_sentences || []).map(s => s.en).filter(Boolean).join(' ');
        if (hook) parts.push('MỞ BÀI: ' + hook);
        for (const ld of (result.luan_diem || [])) {
            if (ld.title_target) parts.push('\n# ' + ld.title_target);
            const c = (ld.content_sentences || []).map(s => s.en).filter(Boolean).join(' ');
            if (c) parts.push(c);
            for (const lc of (ld.luan_cu || [])) {
                const cc = (lc.content_sentences || []).map(s => s.en).filter(Boolean).join(' ');
                if (cc) parts.push(cc);
            }
        }
        const concl = (result.conclusion_sentences || []).map(s => s.en).filter(Boolean).join(' ');
        if (concl) parts.push('KẾT BÀI: ' + concl);
        const script = parts.join('\n').slice(0, 12000);
        if (!script.trim()) return null;

        const sys = [
            'Bạn là biên tập viên kịch bản documentary địa chính trị khó tính. Chấm CHẤT LƯỢNG kịch bản theo 5 TIÊU CHÍ, mỗi tiêu chí 0-20 điểm (tổng 100):',
            '1. Chiều sâu phân tích địa chính trị',
            '2. Độ cuốn hút & giữ chân người xem (retention)',
            '3. Văn phong documentary tự nhiên, không lộ AI',
            '4. Bám sự kiện thực tế, chính xác',
            '5. Cấu trúc mạch lạc & chuyển đoạn mượt',
            'Nghiêm khắc, phân bổ điểm thực tế (trung bình 60-75, xuất sắc 85+). Điểm tổng = tổng 5 tiêu chí.',
            'Nhận xét bằng TIẾNG VIỆT, cụ thể, có ví dụ trong bài. Trả về DUY NHẤT JSON đúng dạng:',
            '{"score": <số nguyên 0-100>, "reason": "<1 câu tóm tắt>",',
            ' "criteria": [{"name":"Chiều sâu phân tích địa chính trị","score":<0-20>,"comment":"<nhận xét>"}, ... đủ 5 tiêu chí theo đúng thứ tự trên],',
            ' "strengths": ["<điểm mạnh>", ...], "weaknesses": ["<điểm yếu>", ...], "suggestions": ["<gợi ý cải thiện>", ...]}',
        ].join('\n');
        const { content } = await aiChat({
            tier: 'mini', temperature: 0, json: true,
            messages: [{ role: 'system', content: sys }, { role: 'user', content: script }],
        });
        const j = JSON.parse(content);
        let score = Math.round(Number(j.score));
        if (!Number.isFinite(score)) return null;
        score = Math.max(0, Math.min(100, score));
        // detail = object đánh giá chi tiết (lưu JSON) — chuẩn hoá gọn để frontend render
        const detail = {
            criteria: Array.isArray(j.criteria) ? j.criteria.map(c => ({ name: String(c.name || ''), score: Math.max(0, Math.min(20, Math.round(Number(c.score) || 0))), comment: String(c.comment || '') })) : [],
            strengths: Array.isArray(j.strengths) ? j.strengths.map(String) : [],
            weaknesses: Array.isArray(j.weaknesses) ? j.weaknesses.map(String) : [],
            suggestions: Array.isArray(j.suggestions) ? j.suggestions.map(String) : [],
        };
        console.log(`[process_content] 📊 Điểm nội dung: ${score}/100 — ${j.reason || ''}`);
        return { score, reason: String(j.reason || ''), detail };
    } catch (e) { console.warn('[process_content] chấm điểm lỗi:', e.message); return null; }
}

// Bỏ các key nội bộ (_news, _articles...) trước khi đưa kịch bản cho GPT — chúng rất nặng và vô ích với model.
function stripInternalKeys(obj) {
    return JSON.parse(JSON.stringify(obj, (k, v) => (k.startsWith('_') ? undefined : v)));
}

// Đánh giá -> văn bản để GPT biết phải sửa gì.
function formatEvaluation(scoreObj) {
    const d = scoreObj.detail || {};
    const list = (title, arr) => (arr || []).length ? [title, ...arr.map(s => '- ' + s)].join('\n') : '';
    return [
        `DIEM HIEN TAI: ${scoreObj.score}/100 — ${scoreObj.reason || ''}`,
        (d.criteria || []).length ? 'CHI TIET TUNG TIEU CHI:\n' + d.criteria.map(c => `- ${c.name}: ${c.score}/20 — ${c.comment}`).join('\n') : '',
        list('DIEM MANH (BAT BUOC GIU LAI, KHONG DUOC LAM YEU DI):', d.strengths),
        list('DIEM YEU (BAT BUOC SUA TRIET DE):', d.weaknesses),
        list('GOI Y CAI THIEN (BAT BUOC AP DUNG):', d.suggestions),
    ].filter(Boolean).join('\n\n');
}

// Viết lại kịch bản DUY NHẤT 1 LẦN khi điểm dưới ngưỡng: đưa nguyên kịch bản cũ + toàn bộ đánh giá
// (ưu/nhược/gợi ý) cho GPT sửa. Trả kịch bản mới (đã vá bản target) hoặc null nếu lỗi.
async function rewriteContentWithGPT(result, scoreObj, structIssues = []) {
    try {
        const draft = JSON.stringify(stripInternalKeys(result));
        const scoreLine = scoreObj
            ? `Kich ban duoi day bi cham ${scoreObj.score}/100 — DUOI NGUONG DAT (${REWRITE_SCORE_THRESHOLD}). Nhiem vu: VIET LAI TOAN BO cho dat diem cao nhat co the.`
            : 'Nhiem vu: VIET LAI TOAN BO kich ban duoi day cho dat chat luong cao nhat.';
        // Khi cau truc thoai hoa (1 luan diem, luan cu bam nho...) → BAT BUOC tai cau truc, KHONG giu nguyen so luan diem.
        const hasStruct = structIssues.length > 0;
        const structBlock = hasStruct ? [
            '===== LOI CAU TRUC BAT BUOC SUA (UU TIEN CAO NHAT) =====',
            ...structIssues.map(s => '- ' + s),
            `- BAT BUOC chia Than bai thanh IT NHAT ${GEO_MIN_LUAN_DIEM} luan diem (luan_diem), moi luan diem la 1 khia canh phan tich rieng (dien bien thuc te / boi canh lich su / dong co ngoai giao / tac dong doi song nguoi Nhat / an ninh hang hai Senkaku / kich ban 3-5 nam).`,
            '- Moi luan cu (luan_cu) PHAI gom NHIEU cau content_sentences (3-6 cau) cung mach y — TUYET DOI KHONG tach moi cau thanh 1 luan cu rieng.',
            '- Phan bo deu 90-110 Object cau vao cac luan diem/luan cu; KHONG don het vao 1 luan diem.',
            '- Moi luan diem / luan cu chi giu keywords_factual & keywords_cinematic GON (2-4 tu khoa moi loai), sat noi dung cua chinh no.',
            '',
        ] : [];
        const input = [
            'Ban la bien tap vien truong cua kenh documentary dia chinh tri tieng Nhat.',
            scoreLine,
            '',
            ...(scoreObj ? ['===== DANH GIA CUA BIEN TAP VIEN (PHAI XU LY HET) =====', formatEvaluation(scoreObj), ''] : []),
            ...structBlock,
            '===== YEU CAU VIET LAI =====',
            // Chỉ giữ nguyên số luận điểm khi cấu trúc ĐANG ỔN; nếu lỗi cấu trúc thì phải tái cấu trúc theo khối trên.
            hasStruct
                ? '- TAI CAU TRUC theo khoi "LOI CAU TRUC" o tren; giu tong so Object JSON (90-110 cau) nhung PHAN BO lai thanh nhieu luan diem/luan cu hop ly.'
                : '- GIU NGUYEN cau truc JSON, so luong luan diem va tong so Object JSON (90-110 cau) nhu ban cu.',
            '- GIU NGUYEN chu de, cac su kien co that va so lieu trong ban cu — TUYET DOI KHONG bia them su kien moi.',
            '- Sua triet de tung DIEM YEU va ap dung tung GOI Y o tren; giu lai nhung DIEM MANH da co.',
            '- Van phong NHK Special, the CHOTAI (常体), khach quan, khong an du, khong giat gan, khong nhan tieu de trong cau thoai.',
            '- Moi cau van la object song ngu {vi, en}: [vi] = TIENG VIET, [en] = key ten "en" nhung NOI DUNG BAT BUOC LA TIENG NHAT.',
            '- KHONG de trong [en], KHONG viet tieng Anh, KHONG them tien to "ja: ".',
            '- Giu keywords_factual / keywords_cinematic bang tieng Anh cho moi doan (co the tinh chinh cho sat noi dung moi).',
            '',
            '===== KICH BAN CU (JSON) =====',
            draft,
        ].join('\n');

        console.log(`[process_content] ✍️  Gọi ${modelFor('main')} viết lại kịch bản${hasStruct ? ' (tái cấu trúc)' : ''}...`);
        const { outputText, usage } = await aiStructured({
            schema: SCRIPT_SCHEMA,
            schemaName: 'phan_tich_dia_chinh_tri_v2',
            input,
            effort: 'medium',
            maxTokens: 40000,
        });
        logUsage('process_content:rewrite', usage);

        const rewritten = JSON.parse(outputText);
        // Bản viết lại cũng phải qua lưới an toàn tiếng Nhật như bản gốc.
        await ensureTargetSentences(rewritten);
        if (!(rewritten.luan_diem || []).length) {
            console.warn('[process_content] ⚠ bản viết lại rỗng luận điểm -> bỏ, giữ bản cũ');
            return null;
        }
        return rewritten;
    } catch (e) { console.warn('[process_content] viết lại lỗi:', e.message); return null; }
}

// Sinh 3 câu tìm kiếm X (Twitter) tiếng NHẬT từ chủ đề + tiêu đề tin — để crawl X kiểu drama.
async function getGeoXKeywordsJa(caseInfo) {
    try {
        const r = await aiChat({
            tier: 'mini', temperature: 0.2,
            messages: [
                { role: 'system', content: [
                    'Bạn là chuyên gia tìm kiếm trên X (Twitter) tiếng Nhật cho video địa chính trị.',
                    'Từ CHỦ ĐỀ + TIÊU ĐỀ TIN, xác định sự kiện cốt lõi (ai/nước nào, làm gì, ở đâu).',
                    'Tạo ĐÚNG 3 câu tìm kiếm tiếng NHẬT để tìm bài đăng/ảnh/video về CHÍNH sự kiện đó.',
                    '- Mỗi câu ghép 2-3 từ khóa tiếng Nhật bằng dấu cách (AND); cụm đặc trưng nhất để trong "..." .',
                    '- Dùng thuật ngữ tiếng Nhật người Nhật thật sự tweet, ưu tiên từ cho nhiều kết quả.',
                    '- CHỈ trả JSON array gồm 3 chuỗi, không giải thích.',
                ].join('\n') },
                { role: 'user', content: String(caseInfo).slice(0, 4000) },
            ],
        });
        let content = (r.content || '[]').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        try { const p = JSON.parse(content); if (Array.isArray(p)) return p.slice(0, 3); } catch (_) {}
        const m = content.match(/\[.*?\]/s);
        if (m) { try { return JSON.parse(m[0]).slice(0, 3); } catch (_) {} }
        return [];
    } catch (e) { console.error('    [X-geo] keyword JA lỗi:', e.message); return []; }
}

// Crawl X kiểu drama cho geo: search theo keyword JA, lấy tối đa 5 ảnh + 5 video, lưu block section='x'.
async function crawlXForGeo(db, postId, projectId, result) {
    try {
        const news = (result._news || []).map(a => a.title).filter(Boolean).slice(0, 8);
        const caseInfo = [topic, ...(keywords || []), ...news].filter(Boolean).join('\n');
        if (!caseInfo.trim()) return;
        const xKeywords = await getGeoXKeywordsJa(caseInfo);
        if (!xKeywords.length) { console.log('    [X-geo] không sinh được keyword → bỏ qua'); return; }
        console.log(`    [X-geo] keywords (JA): ${xKeywords.join(' | ')}`);
        for (const kw of xKeywords) if (kw) await db.run('INSERT INTO Keyword (post_id, section, content, type) VALUES (?, ?, ?, ?)', [postId, 'x', kw, 'x_ja']);

        const X_PROFILE = process.env.X_PROFILE || 'chrome-profile-4';
        const xOut = path.join(BASE_DIR, projectId, 'assets', 'x');
        const { manifest } = await crawlX({
            profileName: X_PROFILE,
            outDir: xOut,
            keywords: xKeywords.join('|'),
            limit: 25, max: 25, captureMax: 0,   // chỉ lấy media của tweet, không chụp màn hình
            maxImages: 5, maxVideos: 5,           // mục tiêu 5 ảnh + 5 video
        });
        const insertAsset = async (absPath, type, srcUrl) => {
            const rel = path.relative(BASE_DIR, absPath);
            const ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
            if (!ex) await db.run('INSERT INTO Asset (post_id, section, type, file_path, source_url) VALUES (?, ?, ?, ?, ?)', [postId, 'x', type, rel, srcUrl || null]);
        };
        let ni = 0, nv = 0;
        for (const t of manifest) {
            for (const img of t.images) { await insertAsset(img, 'image', t.url); ni++; }
            for (const vid of t.videos) { await insertAsset(vid, 'video', t.url); nv++; }
        }
        console.log(`    [X-geo] ${manifest.length} bài → ${ni} ảnh + ${nv} video (block section='x')`);
    } catch (e) { console.error('    [X-geo] lỗi:', e.message); }
}

// [DEPRECATED] Sinh keyword tìm X (tiếng NHẬT) cho TỪNG CẢNH — KHÔNG còn dùng: geo giờ tìm X bằng
// keyword Factual của cảnh (xem crawlXPerSceneForGeo). Giữ lại phòng khi cần quay lại luồng JA.
async function getGeoXKeywordsPerScene(sceneTexts) {
    const items = sceneTexts.map((t, i) => `[${i}] ${String(t || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    if (!items.trim()) return {};
    try {
        const r = await aiChat({
            tier: 'mini', temperature: 0.2, json: true,
            messages: [
                { role: 'system', content: [
                    'Bạn là chuyên gia tìm kiếm trên X (Twitter) tiếng Nhật cho video địa chính trị.',
                    'Với MỖI cảnh (đánh số [i]) dưới đây, tạo ĐÚNG 2 câu tìm kiếm tiếng NHẬT bám sát nội dung CHÍNH của cảnh đó để tìm bài đăng/ảnh/video liên quan.',
                    '- Mỗi câu ghép 2-3 từ khóa tiếng Nhật bằng dấu cách (AND); cụm đặc trưng nhất để trong "..." .',
                    '- Dùng thuật ngữ người Nhật thật sự tweet, ưu tiên từ cho nhiều kết quả.',
                    'CHỈ trả json object: khóa là số thứ tự cảnh (dạng chuỗi), giá trị là mảng 2 chuỗi. Ví dụ {"0":["...","..."],"1":["...","..."]}',
                ].join('\n') },
                { role: 'user', content: items.slice(0, 12000) },
            ],
        });
        let content = (r.content || '{}').replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const m = content.match(/\{[\s\S]*\}/);
        if (m) content = m[0];
        const obj = JSON.parse(content);
        return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { console.error('    [X-scene] keyword/cảnh lỗi:', e.message); return {}; }
}

// Chèn 1 asset X — GOM VỀ LUẬN ĐIỂM: cả luận điểm (para) LẪN luận cứ (sent) đều gán vào paragraph_id
// của luận điểm, sentence_id = NULL → media dồn hết vào pool luận điểm, KHÔNG tự nhảy vào luận cứ.
// Người dùng tự chọn asset vào luận cứ nào (nút 📦 → chọn luận cứ). Mở bài/kết bài vẫn theo section.
async function insertSceneAsset(db, postId, sc, type, absPath, srcUrl) {
    const rel = path.relative(BASE_DIR, absPath);
    const base = path.basename(rel);
    const paraId = sc.kind === 'section' ? null : sc.paraId;
    // Dedup: cùng file, HOẶC cùng 1 media của cùng tweet (basename x_<id>_<i>) đã có trong CÙNG luận điểm
    // (luận điểm & luận cứ của nó có thể cùng tìm ra 1 tweet) → tránh trùng trong pool.
    let ex;
    if (paraId != null) {
        const escBase = base.replace(/[\\%_]/g, c => '\\' + c);
        ex = await db.get(
            "SELECT id FROM Asset WHERE file_path = ? OR (paragraph_id = ? AND file_path LIKE ? ESCAPE '\\')",
            [rel, paraId, '%/' + escBase]
        );
    } else {
        ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
    }
    if (ex) return;
    await db.run(
        'INSERT INTO Asset (post_id, paragraph_id, sentence_id, section, type, file_path, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [postId, paraId, null, sc.kind === 'section' ? sc.section : null, type, rel, srcUrl || null]
    );
}

// Nhãn cảnh dùng cho thư mục out / log: mở bài-kết bài theo section, luận điểm/luận cứ theo id.
function xSceneLabel(sc) {
    return sc.kind === 'section' ? sc.section : `${sc.kind}_${sc.sentId || sc.paraId}`;
}

// Crawl X (mở bài + luận điểm + luận cứ + kết bài): tìm bằng keyword FACTUAL của chính cảnh đó.
// Media của luận điểm VÀ các luận cứ của nó đều GOM VỀ POOL LUẬN ĐIỂM (paragraph_id) — không tự gán
// vào luận cứ; người dùng tự chọn asset vào luận cứ nào. Mở bài/kết bài vẫn theo section.
async function crawlXPerSceneForGeo(db, postId, projectId, result) {
    try {
        await db.run('ALTER TABLE Keyword ADD COLUMN sentence_id INTEGER DEFAULT NULL').catch(() => {});   // self-heal
        const scenes = [];
        // Mở bài (hook) TRƯỚC — trước đây bị bỏ sót nên "mở bài không có media nào".
        const hookKw = (result.hook_keywords_factual || []).filter(Boolean).map(String);
        if (hookKw.length) scenes.push({ kind: 'section', section: 'hook', factual: hookKw });
        for (const cau of (result.luan_diem || [])) {
            if (!cau._paragraphId) continue;
            scenes.push({ kind: 'para', paraId: cau._paragraphId, sentId: null, factual: (cau.keywords_factual || []).filter(Boolean).map(String) });
            for (const doan of (cau.luan_cu || [])) {
                if (!doan._sentenceId) continue;
                scenes.push({ kind: 'sent', paraId: cau._paragraphId, sentId: doan._sentenceId, factual: (doan.keywords_factual || []).filter(Boolean).map(String) });
            }
        }
        // Kết bài (conclusion) SAU CÙNG.
        const conclKw = (result.conclusion_keywords_factual || []).filter(Boolean).map(String);
        if (conclKw.length) scenes.push({ kind: 'section', section: 'conclusion', factual: conclKw });
        // Tạo mới → chèn keyword x_factual (lưu để nút crawl lại tái dùng đúng cảnh), gán media mọi cảnh.
        await runXSceneCrawl(db, postId, projectId, scenes, { insertKeyword: true, onlyMissing: false });
    } catch (e) { console.error('    [X-scene] lỗi:', e.message); }
}

// Cảnh đã có asset chưa? (para/luận cứ gom pool ở paragraph_id; section theo section) — cho chế độ chỉ-bù-thiếu.
async function sceneHasAsset(db, postId, sc) {
    if (sc.kind === 'section') {
        const r = await db.get('SELECT 1 FROM Asset WHERE post_id = ? AND section = ? LIMIT 1', [postId, sc.section]);
        return !!r;
    }
    const r = await db.get('SELECT 1 FROM Asset WHERE paragraph_id = ? LIMIT 1', [sc.paraId]);
    return !!r;
}

// Dựng lại danh sách cảnh từ DB (dùng cho nút crawl lại): lấy keyword x_factual ĐÃ LƯU của lần tạo, đúng từng cảnh.
async function buildScenesFromDb(db, postId) {
    const scenes = [];
    const kwOf = async (where, params) =>
        (await db.all(`SELECT content FROM Keyword WHERE ${where} AND type = 'x_factual' ORDER BY id`, params))
            .map(r => r.content).filter(Boolean);
    const hook = await kwOf("post_id = ? AND section = 'hook'", [postId]);
    if (hook.length) scenes.push({ kind: 'section', section: 'hook', factual: hook });
    const paras = await db.all('SELECT id FROM Paragraph WHERE post_id = ? ORDER BY id', [postId]);
    for (const pa of paras) {
        const pk = await kwOf('paragraph_id = ? AND sentence_id IS NULL', [pa.id]);
        if (pk.length) scenes.push({ kind: 'para', paraId: pa.id, sentId: null, factual: pk });
        const sents = await db.all('SELECT id FROM Sentence WHERE paragraph_id = ? ORDER BY "order"', [pa.id]);
        for (const s of sents) {
            const sk = await kwOf('sentence_id = ?', [s.id]);
            if (sk.length) scenes.push({ kind: 'sent', paraId: pa.id, sentId: s.id, factual: sk });
        }
    }
    const concl = await kwOf("post_id = ? AND section = 'conclusion'", [postId]);
    if (concl.length) scenes.push({ kind: 'section', section: 'conclusion', factual: concl });
    return scenes;
}

// Crawl lại NGUỒN X theo từng cảnh, dựng cảnh từ DB (keyword x_factual đã lưu). onlyMissing → chỉ cảnh 0 asset.
async function crawlXPerSceneFromDb(db, postId, projectId, { onlyMissing = true } = {}) {
    try {
        const scenes = await buildScenesFromDb(db, postId);
        if (!scenes.length) { console.log('    [X-scene] DB không có keyword x_factual (dự án tạo trước khi có crawl X per-scene) → không crawl lại được nguồn X'); return; }
        // Crawl lại → KHÔNG chèn keyword mới (đã có sẵn), chỉ cào X và bù media.
        await runXSceneCrawl(db, postId, projectId, scenes, { insertKeyword: false, onlyMissing });
    } catch (e) { console.error('    [X-scene] crawl lại lỗi:', e.message); }
}

// Vòng cào X dùng CHUNG cho tạo mới (scenes từ result) và crawl lại (scenes từ DB).
async function runXSceneCrawl(db, postId, projectId, scenes, { insertKeyword = false, onlyMissing = false } = {}) {
    if (!scenes.length) { console.log('    [X-scene] không có cảnh → bỏ qua'); return; }
    console.log(`    [X-scene] ${scenes.length} cảnh (mở bài + luận điểm + luận cứ + kết bài) → tìm X bằng keyword Factual${onlyMissing ? ' (chỉ cảnh còn thiếu)' : ''}...`);
    resetXBrowseLog(projectId);   // log MỌI bài X lướt qua từng cảnh (xem ở modal "Log X")

    const X_PROFILE = process.env.X_PROFILE || 'chrome-profile-4';
    let totImg = 0, totVid = 0, done = 0, skipped = 0;
    for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const label = xSceneLabel(sc);
        // Chỉ-bù-thiếu: cảnh đã có media → bỏ qua (không tốn request X).
        if (onlyMissing && await sceneHasAsset(db, postId, sc)) { skipped++; continue; }
        // Tìm X bằng keyword FACTUAL của cảnh (tiếng Anh, bám nội dung thực tế) — theo yêu cầu.
        // CHỈ 1 keyword/cảnh: mỗi query = 1 request X, throttle ~50 req/15 phút cho MỖI account.
        const kws = (sc.factual || []).slice(0, 1);
        if (!kws.length) { console.log(`    [X-scene] cảnh ${label} (${sc.kind}) không có keyword Factual → bỏ`); continue; }
        if (insertKeyword) for (const kw of kws) await db.run(
            'INSERT INTO Keyword (post_id, paragraph_id, sentence_id, section, content, type) VALUES (?, ?, ?, ?, ?, ?)',
            [postId,
             sc.kind === 'para' ? sc.paraId : null,
             sc.kind === 'sent' ? sc.sentId : null,
             sc.kind === 'section' ? sc.section : null,
             kw, 'x_factual']
        );
        const outDir = path.join(BASE_DIR, projectId, 'assets', 'x', label);
        let manifest = [], scraped = [];
        try {
            ({ manifest, scraped } = await crawlX({
                profileName: X_PROFILE, outDir,
                // GIỐNG NHẤT với "tự gõ từ khóa rồi search trên web X": query THUẦN keyword (KHÔNG thêm
                // filter:media / filter:native_video — người dùng đâu có gõ mấy toán tử đó), tab mặc định
                // Top (x_scrape --product Top), lấy media theo ĐÚNG thứ tự X trả (crawlX đã giữ nguyên).
                // 1 query/cảnh = 1 request (giảm nửa so với kiểu 2-filter trước) → nhẹ rate-limit hơn.
                keywords: kws.join('|'),
                // limit<=20 vẫn chỉ 1 request; max cao để không cắt mất bài liên quan ở cuối trang Top.
                limit: 20, max: 40, captureMax: 0, maxImages: 5, maxVideos: 5,
                scrapeTimeoutMs: 90000,   // dính rate-limit thì bỏ cảnh, KHÔNG treo pipeline
            }));
        } catch (e) {
            console.error(`    [X-scene] crawl cảnh ${label} (${sc.kind}) lỗi: ${e.message}`);
            appendXBrowse(projectId, { scene: label, kind: sc.kind, keywords: kws, scraped, usedUrls: null });
            continue;
        }
        let ni = 0, nv = 0;
        const usedUrls = new Set();
        for (const t of manifest) {
            for (const img of t.images) { await insertSceneAsset(db, postId, sc, 'image', img, t.url); ni++; usedUrls.add(t.url); }
            for (const vid of t.videos) { await insertSceneAsset(db, postId, sc, 'video', vid, t.url); nv++; usedUrls.add(t.url); }
        }
        // Ghi log MỌI bài đã lướt (kể cả bài không lấy media) kèm cờ used.
        appendXBrowse(projectId, { scene: label, kind: sc.kind, keywords: kws, scraped, usedUrls });
        totImg += ni; totVid += nv; done++;
        console.log(`    [X-scene] ${label}: ${ni} ảnh + ${nv} video (kw: ${kws.join(' | ')})`);
    }
    console.log(`    [X-scene] xong ${done}/${scenes.length} cảnh${skipped ? ` (bỏ qua ${skipped} cảnh đã có media)` : ''} → ${totImg} ảnh + ${totVid} video`);
}

async function saveToDb(projectId, result, scoreObj = null, scoreHistory = null) {
    const db = await getDb();
    const postTitle = projectId;

    await db.run('INSERT OR IGNORE INTO Post (project_id, genre) VALUES (?, ?)', [postTitle, 'geo']);
    await db.run('UPDATE Post SET status = ?, genre = COALESCE(genre, ?) WHERE project_id = ?', ['crawling', 'geo', postTitle]);

    // Notify dashboard
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
        .end(JSON.stringify({ postTitle, status: 'crawling' }));

    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [postTitle]);
    const postId = post.id;

    // Lưu title, hook_vi/hook_target từ hook_sentences, conclusion
    const hookVi = result.hook_sentences?.map(s => s.vi).filter(Boolean).join(' ') || '';
    const hookTarget = result.hook_sentences?.map(s => s.en).filter(Boolean).join(' ') || '';
    const conclusionVi = result.conclusion_sentences?.map(s => s.vi).filter(Boolean).join(' ') || '';
    const conclusionTarget = result.conclusion_sentences?.map(s => s.en).filter(Boolean).join(' ') || '';

    await db.run('ALTER TABLE Post ADD COLUMN target_lang TEXT DEFAULT NULL').catch(() => {}); // self-heal
    await db.run('ALTER TABLE Post ADD COLUMN content_score INTEGER DEFAULT NULL').catch(() => {}); // self-heal: điểm chấm nội dung 0-100
    await db.run('ALTER TABLE Post ADD COLUMN content_score_reason TEXT DEFAULT NULL').catch(() => {}); // self-heal: lý do điểm
    await db.run('ALTER TABLE Post ADD COLUMN content_score_detail TEXT DEFAULT NULL').catch(() => {}); // self-heal: đánh giá chi tiết (JSON)
    await db.run('ALTER TABLE Post ADD COLUMN content_score_history TEXT DEFAULT NULL').catch(() => {}); // self-heal: lịch sử chấm điểm (JSON) — bản đầu + bản viết lại
    await db.run(
        'UPDATE Post SET title = ?, target_lang = ?, hook = ?, hook_vi = ?, conclusion_vi = ?, conclusion_target = ?, content_score = ?, content_score_reason = ?, content_score_detail = ?, content_score_history = ? WHERE id = ?',
        [stripLinks(result.title), targetLang, stripLinks(hookTarget), stripLinks(hookVi),
         stripLinks(conclusionVi), stripLinks(conclusionTarget),
         (scoreObj && Number.isFinite(scoreObj.score)) ? scoreObj.score : null,
         (scoreObj && scoreObj.reason) ? scoreObj.reason : null,
         (scoreObj && scoreObj.detail) ? JSON.stringify(scoreObj.detail) : null,
         (scoreHistory && scoreHistory.length) ? JSON.stringify(scoreHistory) : null, postId]
    );

    // HookDetail từ array
    for (let k = 0; k < (result.hook_sentences || []).length; k++) {
        const pair = result.hook_sentences[k];
        await db.run(
            'INSERT INTO HookDetail (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, stripLinks(pair.en || ''), stripLinks(pair.vi || ''), k + 1]
        );
    }

    // ConclusionDetail từ array
    for (let k = 0; k < (result.conclusion_sentences || []).length; k++) {
        const pair = result.conclusion_sentences[k];
        await db.run(
            'INSERT INTO ConclusionDetail (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, stripLinks(pair.en || ''), stripLinks(pair.vi || ''), k + 1]
        );
    }

    // Lưu keywords cho hook, conclusion
    const savePostKeywords = async (section, factuals, cinematics) => {
        for (const kw of (factuals || [])) if (kw) await db.run('INSERT INTO Keyword (post_id, section, content, type) VALUES (?, ?, ?, ?)', [postId, section, kw, 'factual']);
        for (const kw of (cinematics || [])) if (kw) await db.run('INSERT INTO Keyword (post_id, section, content, type) VALUES (?, ?, ?, ?)', [postId, section, kw, 'cinematic']);
    };
    await savePostKeywords('hook', result.hook_keywords_factual, result.hook_keywords_cinematic);
    await savePostKeywords('conclusion', result.conclusion_keywords_factual, result.conclusion_keywords_cinematic);

    let sentenceOrder = 0;
    await db.run('BEGIN TRANSACTION');
    try {
        for (let i = 0; i < result.luan_diem.length; i++) {
            const cau = result.luan_diem[i];
            // ParagraphDetail từ content_sentences array
            const contentVi = cau.content_sentences?.map(s => s.vi).filter(Boolean).join(' ') || '';
            const contentTarget = cau.content_sentences?.map(s => s.en).filter(Boolean).join(' ') || '';
            const paraRes = await db.run(
                'INSERT INTO Paragraph (post_id, content, content_vi, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                [postId, stripLinks(contentTarget), stripLinks(contentVi), stripLinks(cau.title_target), stripLinks(cau.title_vi), i + 1]
            );
            const paragraphId = paraRes.lastID;

            for (let k = 0; k < (cau.content_sentences || []).length; k++) {
                const pair = cau.content_sentences[k];
                await db.run(
                    'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
                    [paragraphId, stripLinks(pair.en || ''), stripLinks(pair.vi || ''), k + 1]
                );
            }

            for (let j = 0; j < cau.luan_cu.length; j++) {
                const doan = cau.luan_cu[j];
                sentenceOrder++;
                const contentVi = doan.content_sentences?.map(s => s.vi).filter(Boolean).join(' ') || '';
                const contentTarget = doan.content_sentences?.map(s => s.en).filter(Boolean).join(' ') || '';
                const sentenceRes = await db.run(
                    // Luận cứ không còn title → lưu NULL (bỏ title của luận cứ).
                    'INSERT INTO Sentence (paragraph_id, content, content_vi, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                    [paragraphId, stripLinks(contentTarget), stripLinks(contentVi), null, null, sentenceOrder]
                );
                const sentenceId = sentenceRes.lastID;
                doan._sentenceId = sentenceId;
                doan._paragraphId = paragraphId;

                // SentenceDetail từ content_sentences array
                for (let k = 0; k < (doan.content_sentences || []).length; k++) {
                    const pair = doan.content_sentences[k];
                    await db.run(
                        'INSERT INTO SentenceDetail (sentence_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
                        [sentenceId, stripLinks(pair.en || ''), stripLinks(pair.vi || ''), k + 1]
                    );
                }
            }
            cau._paragraphId = paragraphId;
        }
        await db.run('COMMIT');
        console.log(`[process_content] ✅ Đã lưu ${result.luan_diem.length} luận điểm vào DB`);
    } catch (e) {
        await db.run('ROLLBACK');
        throw e;
    }

    // Lưu keywords
    for (const cau of result.luan_diem) {
        for (const kw of (cau.keywords_factual || []))
            if (kw) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [cau._paragraphId, kw, 'factual']);
        for (const kw of (cau.keywords_cinematic || []))
            if (kw) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [cau._paragraphId, kw, 'cinematic']);
        for (const doan of cau.luan_cu) {
            for (const kw of (doan.keywords_factual || []))
                if (kw) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [doan._paragraphId, kw, 'factual']);
            for (const kw of (doan.keywords_cinematic || []))
                if (kw) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [doan._paragraphId, kw, 'cinematic']);
        }
    }
    const summaryPath = path.join(BASE_DIR, projectId, 'summary.json');
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });   // đảm bảo thư mục project tồn tại
    fs.writeFileSync(summaryPath, JSON.stringify({
        title: result.title,
        hook_vi: result.hook_vi,
        hook_target: result.hook_target
    }, null, 2));

    // Kịch bản đã xong → kích hoạt gen voice (+lips) NGAY, song song với crawl media bên dưới.
    try {
        http.request({ hostname: 'localhost', port: PORT, path: '/api/auto-voice/run', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
            .end(JSON.stringify({ projectId }));
    } catch (_) {}

    await crawlMediaForPost({
        db, postId, projectId,
        articles: result._articles || [],
        searchKeywords: keywords, sourceDomains, topic,
        onlyMissing: false,                                  // project mới → gán media cho mọi cảnh
    });

    // Crawl X (Twitter) THEO TỪNG CẢNH: sinh keyword JA riêng mỗi luận điểm/luận cứ → 3 ảnh + 2 video,
    // gán media đúng vào từng cảnh (paragraph_id/sentence_id) để chọn khớp b-roll sub-scene.
    await crawlXPerSceneForGeo(db, postId, projectId, result);

    await db.run('UPDATE Post SET status = NULL WHERE project_id = ?', [postTitle]);
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
        .end(JSON.stringify({ postTitle, status: null }));

    await db.close();
    console.log(`[process_content] ✅ Hoàn thành project: ${projectId}`);
}

// Gán media vào từng cảnh (section hook/conclusion + paragraph) theo ĐÚNG luồng của pipeline:
//   1) ảnh/video cào được TỪ BÀI BÁO THẬT (articles) — khớp token tiêu đề/keyword của cảnh
//   2) stock bổ sung (Google/Bing Image qua sync_assets_db) — KHÔNG có Storyblocks/Pexels
// onlyMissing=true → chỉ đụng vào cảnh đang 0 asset (dùng cho nút crawl lại).
async function crawlMediaForPost({ db, postId, projectId, articles = [], searchKeywords = [], sourceDomains = [], topic = '', onlyMissing = false, notifyKey = null }) {
    // TẮT (mặc định) mọi nguồn media KHÁC của geo: ảnh/video từ bài báo + stock (Pexels/Pixabay/Storyblocks/Google).
    // Lý do: cào về không dùng được. CHỈ giữ nguồn X (block section='x' do crawlXForGeo lo, chạy riêng sau).
    // Keyword & gợi ý (keywords_factual/cinematic) VẪN được sinh & lưu ở saveToDb — không phụ thuộc hàm này.
    // Bật lại toàn bộ cào media khi cần: đặt env GEO_CRAWL_MEDIA=on.
    if (process.env.GEO_CRAWL_MEDIA !== 'on') {
        console.log('[process_content] ⛔ Bỏ qua cào media bài báo + stock (tắt để tiết kiệm; chỉ dùng nguồn X). Bật lại: GEO_CRAWL_MEDIA=on');
        return;
    }
    const postTitleKey = notifyKey || projectId;
    // Xong 1 cảnh → báo dashboard nạp lại asset của cảnh đó (không đổi status, không bắn Slack)
    const pingScene = () => {
        try {
            const req = http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => { });
            req.on('error', () => { });
            req.end(JSON.stringify({ postTitle: postTitleKey, scene: true }));
        } catch (_) { }
    };
    {
        // Gom toàn bộ media cào được từ các bài (mỗi item gắn tiêu đề bài để khớp token theo đoạn)
        // Chuẩn hoá URL để gộp cùng 1 ảnh khác kích thước/định dạng/host (bỏ query, /wNNN/, /thumb/, đuôi .webp/.avif, host)
        const normImg = (u) => u.split('?')[0]
            .replace(/\/w\d+\//, '/').replace(/\/thumb\/[^/]+\//, '/')
            .replace(/\.(webp|avif)$/i, '').replace(/^https?:\/\/[^/]+/, '').toLowerCase();
        const newsPool = [], videoPool = [], seenImg = new Set(), seenVid = new Set();
        for (const a of articles) {
            for (const img of (a.images || [])) { const k = normImg(img); if (!seenImg.has(k)) { seenImg.add(k); newsPool.push({ title: a.title, img, source: a.source, srcUrl: a.url }); } }
            for (const v of (a.videos || [])) if (!seenVid.has(v)) { seenVid.add(v); videoPool.push({ title: a.title, url: v, source: a.source, srcUrl: a.url }); }
        }
        console.log(`[process_content] Media pool từ ${articles.length} bài: ${newsPool.length} ảnh, ${videoPool.length} video`);
        const usedNews = new Set(), usedVideos = new Set(), usedHashes = new Set();

        // ===== Nguồn KHÁC (stock: Pexels/Pixabay/Storyblocks/Google) — crawl bổ sung cạnh tin RSS =====
        const STOCK_VID = 4, STOCK_IMG = 8;   // số video/ảnh stock mỗi keyword
        const { fetchAndDownloadStock, runConcurrently } = await import('./sync_assets_db.js').catch(() => ({}));
        // Quét file stock_* mới tải trong thư mục vào DB (bỏ qua file đã có / trùng nội dung)
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const syncStock = async (folder, type, insertFn) => {
            const exts = type === 'video' ? ['.mp4', '.mov'] : ['.jpg', '.jpeg', '.png', '.webp'];
            if (!fs.existsSync(folder)) return;
            for (const file of fs.readdirSync(folder)) {
                if (!exts.includes(path.extname(file).toLowerCase())) continue;
                const full = path.join(folder, file);
                // Bỏ file chưa tải xong / rỗng (tránh chèn asset 0 byte gây lỗi 416)
                try { if (fs.statSync(full).size < 2000) continue; } catch (_) { continue; }
                const rel = path.relative(BASE_DIR, full);
                if (await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel])) continue;
                try { const h = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex'); if (usedHashes.has(h)) { fs.unlinkSync(full); continue; } usedHashes.add(h); } catch (_) {}
                await insertFn(rel, type, readStockSource(full));   // gắn URL nguồn (sidecar .src)
            }
        };
        // Crawl stock SONG SONG (như nguồn cũ) + LIVE SYNC mỗi 2s để asset hiện dần trên màn hình
        const attachStock = async (kws, iFolder, vFolder, ins) => {
            if (!fetchAndDownloadStock || !runConcurrently) return;
            const tasks = [];
            for (const kw of kws) {
                tasks.push(() => fetchAndDownloadStock(kw, 'video', vFolder, STOCK_VID).catch(() => {}));
                tasks.push(() => fetchAndDownloadStock(kw, 'image', iFolder, STOCK_IMG).catch(() => {}));
            }
            let downloading = true;
            const liveSync = async () => {
                while (downloading) {
                    try { await syncStock(vFolder, 'video', ins); await syncStock(iFolder, 'image', ins); } catch (_) {}
                    await sleep(2000);
                }
            };
            const lp = liveSync();
            await runConcurrently(tasks, Math.max(1, parseInt(process.env.CRAWL_CONCURRENCY || '1', 10) || 1));   // mặc định 1 = tuần tự
            downloading = false;
            await lp;
            await syncStock(vFolder, 'video', ins);   // sync lần cuối
            await syncStock(iFolder, 'image', ins);
        };

        // Log RSS của lần chạy này — ghi ra thư mục rss/ khi xong
        const rssLog = {
            generatedAt: new Date().toISOString(),
            projectId,
            topic,
            keywords: searchKeywords,
            sources: sourceDomains,
            // Nguồn CUSTOM (không phải mặc định) — lưu riêng để nút crawl lại dựng nguồn = DEFAULT_SOURCES HIỆN TẠI + custom,
            // KHÔNG cào lại các nguồn mặc định đã bị gỡ/comment sau này. (sources ở trên chỉ để tham khảo/lịch sử.)
            sourcesExtra: (sourceDomains || []).filter(s => !DEFAULT_SOURCES.includes(s)),
            country: { gl: countryGl || '', hl: countryHl || '' },   // để nút crawl lại dựng lại đúng truy vấn
            days: newsDays,
            mode: onlyMissing ? 'recrawl-missing' : 'full',
            articles: articles.map(a => ({ title: a.title, source: a.source, pub: a.pub, url: a.url, keyword: a.keyword, images: a.images?.length || 0, videos: a.videos?.length || 0 })),
            imagePool: newsPool.map(a => ({ title: a.title, img: a.img })),
            videoPool: videoPool.map(a => ({ title: a.title, url: a.url })),
            assignments: {},   // key: "hook"/"summary"/"conclusion" hoặc số thứ tự paragraph
        };

        // Số ảnh/video tin tối đa lấy cho mỗi section/paragraph (lấy nhiều nhất pool cho phép)
        const CAP_IMG = 16, CAP_VID = 4;
        // Chọn tới `cap` mục: ưu tiên khớp token, thiếu thì bù thêm mục mới nhất chưa dùng
        const pickUpTo = (pool, tokens, cap, used, keyOf) => {
            const matched = pickNews(pool, tokens, cap, used);
            if (matched.length >= cap) return matched;
            const have = new Set(matched.map(keyOf));
            const extra = pool.filter(a => !used.has(keyOf(a)) && !have.has(keyOf(a))).slice(0, cap - matched.length);
            return matched.concat(extra);
        };

        // Gắn ảnh tin (tối đa CAP_IMG) + video tin (tối đa CAP_VID) vào 1 nhóm (section hoặc paragraph)
        const attachNews = async (tokens, gid, iFolder, vFolder, ins) => {
            const rec = { tokens, images: [], videos: [] };
            rssLog.assignments[gid] = rec;
            if (newsPool.length) {
                const imgMatch = pickUpTo(newsPool, tokens, CAP_IMG, usedNews, a => a.img);
                let ni = 0;
                for (const art of imgMatch) {
                    const dest = path.join(iFolder, `news_${gid}_${ni++}.jpg`);
                    try {
                        await downloadBinary(art.img, dest);
                        usedNews.add(art.img);
                        const h = crypto.createHash('md5').update(fs.readFileSync(dest)).digest('hex');
                        if (usedHashes.has(h)) { fs.unlinkSync(dest); continue; }   // ảnh trùng nội dung -> bỏ
                        usedHashes.add(h);
                        const rel = path.relative(BASE_DIR, dest);
                        if (!await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel])) await ins(rel, 'image', art.srcUrl);
                        rec.images.push({ title: art.title, img: art.img, file: rel });
                        console.log(`[process_content] News ảnh ${gid}: ${art.title.slice(0, 45)}`);
                        logCrawlInfo({ source: `Cảnh ${gid}/ảnh tin`, keyword: art.source || '', url: art.img, note: `bài "${art.title.slice(0, 50)}" -> ${rel}` });
                    } catch (_) { /* bỏ ảnh lỗi */ }
                }
            }
            if (videoPool.length) {
                const vidMatch = pickUpTo(videoPool, tokens, CAP_VID, usedVideos, a => a.url);
                let vi = 0;
                for (const art of vidMatch) {
                    usedVideos.add(art.url);
                    const dest = path.join(vFolder, `news_${gid}_${vi++}.mp4`);
                    try {
                        // file mp4/webm trực tiếp -> tải thẳng; youtube/vimeo/m3u8 -> yt-dlp
                        if (/\.(mp4|webm)(\?|$)/i.test(art.url)) await downloadBinary(art.url, dest);
                        else await downloadYtVideo(art.url, dest);
                        if (fs.existsSync(dest)) {
                            const h = crypto.createHash('md5').update(fs.readFileSync(dest)).digest('hex');
                            if (usedHashes.has(h)) { fs.unlinkSync(dest); continue; }   // video trùng nội dung -> bỏ
                            usedHashes.add(h);
                            const rel = path.relative(BASE_DIR, dest);
                            if (!await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel])) await ins(rel, 'video', art.srcUrl);
                            rec.videos.push({ title: art.title, url: art.url, file: rel });
                            console.log(`[process_content] News video ${gid}: ${art.title.slice(0, 45)}`);
                            logCrawlInfo({ source: `Cảnh ${gid}/video tin`, keyword: art.source || '', url: art.url, note: `bài "${art.title.slice(0, 50)}" -> ${rel}` });
                        }
                    } catch (e) {
                        console.error(`[process_content] yt-dlp ${gid}: ${e.message}`);
                        logCrawlError({ source: `Cảnh ${gid}/video tin`, keyword: art.source || '', url: art.url, reason: `tải video lỗi: ${e.message}` });
                    }
                }
            }
        };

        // Sections: hook, conclusion — RSS news khớp keyword của section
        for (const section of ['hook', 'conclusion']) {
            const kws = await db.all('SELECT content FROM Keyword WHERE post_id = ? AND section = ?', [postId, section]);
            if (!kws.length) continue;
            if (onlyMissing) {
                const c = await db.get('SELECT COUNT(*) c FROM Asset WHERE post_id = ? AND section = ?', [postId, section]);
                if (c.c > 0) { console.log(`[process_content] ${section}: đã có ${c.c} asset → bỏ qua`); continue; }
            }
            const vFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_videos', section);
            const iFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_images', section);
            [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            const ins = (rel, type, srcUrl) => db.run('INSERT INTO Asset (post_id, section, type, file_path, source_url) VALUES (?, ?, ?, ?, ?)', [postId, section, type, rel, srcUrl || null]);
            const tokens = [...new Set(kws.flatMap(k => tokenize(k.content)))];
            await attachNews(tokens, section, iFolder, vFolder, ins);
            await attachStock(kws.map(k => k.content), iFolder, vFolder, ins);   // nguồn khác (stock) bổ sung
            pingScene();
        }

        // Paragraphs — RSS news khớp tiêu đề + keyword của từng đoạn
        const paragraphs = await db.all('SELECT id, "order", title, title_vi FROM Paragraph WHERE post_id = ? ORDER BY "order"', [postId]);
        for (const para of paragraphs) {
            const gid = String(para.order);
            const kws = await db.all('SELECT content FROM Keyword WHERE paragraph_id = ?', [para.id]);
            if (!kws.length) continue;
            if (onlyMissing) {
                const c = await db.get('SELECT COUNT(*) c FROM Asset WHERE paragraph_id = ?', [para.id]);
                if (c.c > 0) { console.log(`[process_content] đoạn ${gid}: đã có ${c.c} asset → bỏ qua`); continue; }
            }
            const vFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_videos', gid);
            const iFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_images', gid);
            [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            const ins = (rel, type, srcUrl) => db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path, source_url) VALUES (?, NULL, ?, ?, ?)', [para.id, type, rel, srcUrl || null]);
            const newsTokens = [...new Set([...tokenize(para.title_vi), ...tokenize(para.title), ...kws.flatMap(k => tokenize(k.content))])];
            await attachNews(newsTokens, gid, iFolder, vFolder, ins);
            await attachStock(kws.map(k => k.content), iFolder, vFolder, ins);   // nguồn khác (stock) bổ sung
            pingScene();
        }

        // Ghi kết quả RSS của lần chạy này vào thư mục rss/ (tạo nếu chưa có)
        try {
            const rssDir = path.join(process.cwd(), 'rss');
            if (!fs.existsSync(rssDir)) fs.mkdirSync(rssDir, { recursive: true });
            const stamp = rssLog.generatedAt.replace(/[:.]/g, '-');
            const outFile = path.join(rssDir, `${projectId}_${stamp}.json`);
            fs.writeFileSync(outFile, JSON.stringify(rssLog, null, 2));
            console.log(`[process_content] 📝 Đã ghi kết quả RSS: ${path.relative(process.cwd(), outFile)}`);
        } catch (e) { console.error(`[process_content] Ghi log RSS lỗi: ${e.message}`); }
    }
}

// ===== Trí nhớ tin đã dùng (dedup XUYÊN DỰ ÁN) =====
// Trước đây lưu ở file rss_seen/<md5(chủ đề)>.json — hỏng theo 3 kiểu:
//   1) chỉ ghi ở CUỐI lượt chạy → bị pm2 restart giết giữa chừng là quên sạch, dù project đã vào DB;
//   2) khoá theo md5 nội dung ô 'Chủ đề' → sửa 1 chữ trong sheet là mất hết trí nhớ (file mồ côi);
//   3) tách theo từng chủ đề → 2 dòng sheet khác nhau vẫn xào chung 1 bài, và project tạo tay từ UI
//      (không có --seenFile) thì chẳng dedup gì cả.
// Nay lưu vào DB, khoá theo URL bài đã chuẩn hoá, dùng chung cho MỌI dự án geo.
async function ensureNewsSeen(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS NewsSeen (
        url_key    TEXT PRIMARY KEY,
        url        TEXT,
        title_key  TEXT,
        article_id TEXT,
        project_id TEXT,
        created_at TEXT
    )`);
}

// excludeProjectId: crawl lại CHÍNH dự án đó thì được phép dùng lại bài của chính nó
async function loadNewsSeen(db, excludeProjectId) {
    await ensureNewsSeen(db);
    const rows = await db.all('SELECT url_key, title_key, article_id, project_id FROM NewsSeen');
    const ids = new Set(), titles = new Set(), urls = new Set();
    for (const r of rows) {
        if (excludeProjectId && r.project_id === excludeProjectId) continue;
        if (r.article_id) ids.add(r.article_id);
        if (r.title_key) titles.add(r.title_key);
        if (r.url_key) urls.add(r.url_key);
    }
    return { ids, titles, urls };
}

// ---------------------------------------------------------------------------
// CHỐNG TRÙNG VẤN ĐỀ (không chỉ trùng URL).
// NewsSeen chỉ chặn ĐÚNG bài đã dùng; nhưng nhiều bài KHÁC URL vẫn nói cùng một vấn đề
// → dự án mới lặp lại nội dung dự án cũ. Ở đây lấy "dấu vân tay vấn đề" của các dự án geo
// gần đây (tiêu đề dự án + tiêu đề từng luận điểm — có sẵn trong DB, không tốn thêm AI để tạo)
// rồi nhờ AI đối chiếu với các tin ứng viên, loại tin nào nói lại vấn đề CŨ.
// ---------------------------------------------------------------------------
// Post không có cột thời gian → lấy N dự án geo GẦN NHẤT theo id (id tăng dần theo thời gian tạo).
const DEDUP_LOOKBACK_PROJECTS = Math.max(0, parseInt(process.env.GEO_DEDUP_LOOKBACK, 10) || 20);

async function loadCoveredIssues(db) {
    if (!DEDUP_LOOKBACK_PROJECTS) return [];
    const posts = await db.all(
        `SELECT id, project_id, title FROM Post WHERE genre = 'geo' ORDER BY id DESC LIMIT ?`,
        [DEDUP_LOOKBACK_PROJECTS]
    );
    const out = [];
    for (const p of posts) {
        const paras = await db.all('SELECT title FROM Paragraph WHERE post_id = ? ORDER BY id', [p.id]);
        const points = paras.map(x => (x.title || '').trim()).filter(Boolean);
        if (p.title || points.length) out.push({ projectId: p.project_id, title: p.title || '', points });
    }
    return out;
}

// Trả về Set index tin ĐƯỢC GIỮ (vấn đề mới). Lỗi/không cấu hình -> giữ tất cả (không chặn pipeline).
async function filterCoveredIssues(covered, titles) {
    if (!covered.length || !titles.length) return null;
    const coveredTxt = covered.map((c, i) =>
        `[Dự án ${i + 1}] ${c.title}\n   - ${c.points.slice(0, 8).join('\n   - ')}`).join('\n');
    const candTxt = titles.map((t, i) => `[${i}] ${String(t.title || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
    try {
        const { content } = await aiChat({
            tier: 'mini', temperature: 0, json: true,
            messages: [
                { role: 'system', content: [
                    'Bạn lọc tin để tránh làm lại video trùng nội dung.',
                    'Cho DANH SÁCH VẤN ĐỀ ĐÃ LÀM (các dự án trước) và DANH SÁCH TIN ỨNG VIÊN đánh số.',
                    'Loại tin nào nói LẠI cùng một sự kiện/vấn đề đã làm (dù khác báo, khác cách diễn đạt).',
                    'GIỮ tin có diễn biến MỚI, sự kiện MỚI, hoặc góc hoàn toàn khác.',
                    'CHỈ trả json: {"keep":[<số thứ tự tin GIỮ>],"reason":"<1 câu>"}',
                ].join('\n') },
                { role: 'user', content: `VẤN ĐỀ ĐÃ LÀM:\n${coveredTxt}\n\nTIN ỨNG VIÊN:\n${candTxt}` },
            ],
        });
        const j = JSON.parse(content);
        const keep = new Set((j.keep || []).filter(i => Number.isInteger(i) && i >= 0 && i < titles.length));
        console.log(`[dedup] AI giữ ${keep.size}/${titles.length} tin (${j.reason || ''})`);
        return keep;
    } catch (e) {
        console.warn('[dedup] AI lọc trùng lỗi, giữ nguyên toàn bộ tin:', e.message);
        return null;
    }
}

async function saveNewsSeen(db, articles, projectId) {
    await ensureNewsSeen(db);
    let n = 0;
    for (const a of (articles || [])) {
        if (!a.url) continue;
        try {
            await db.run(
                'INSERT OR IGNORE INTO NewsSeen (url_key, url, title_key, article_id, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [normArticleUrl(a.url), a.url, (a.title || '').toLowerCase().slice(0, 60), a.articleId || '', projectId, new Date().toISOString()]
            );
            n++;
        } catch (e) { console.error('[process_content] Ghi NewsSeen lỗi:', e.message); }
    }
    console.log(`[process_content] Đã ghi nhớ ${n} bài vào NewsSeen (dự án sau sẽ không xào lại)`);
}

// ===== CRAWL LẠI cho project ĐÃ CÓ (nút Crawl media trên dashboard) =====
// Chạy ĐÚNG luồng như lúc pipeline sheet crawl: news_pipeline (RSS gốc → Google News) → cào ảnh/video
// trong bài báo thật → gán vào cảnh; stock (Google/Bing Image) chỉ bổ sung. KHÔNG đụng GPT, KHÔNG sửa kịch bản.
// Từ khóa/nguồn tìm tin lấy lại từ log rss/<projectId>_*.json của lần chạy gốc; không có thì suy từ Keyword trong DB.
async function runMediaOnly(postIdArg, force) {
    const db = await getDb();
    const post = await db.get('SELECT id, project_id FROM Post WHERE id = ?', [postIdArg]);
    if (!post) { console.error(`[process_content] Không thấy post id=${postIdArg}`); await db.close(); process.exit(1); }
    const pid = post.project_id.replace(/_[a-z]{2}$/, '');   // bỏ hậu tố ngôn ngữ (proj_x_vi → proj_x)
    setLogProject(pid);                                      // crawl lại cũng ghi log vào logs/<projectId>/

    // Lần chạy gốc đã ghi keyword + nguồn + quốc gia vào rss/<projectId>_<stamp>.json → tái dùng cho đúng
    // QUAN TRỌNG: nguồn crawl lại KHÔNG lấy nguyên snapshot cũ (j.sources) — snapshot đó có thể chứa nguồn
    // mặc định đã bị gỡ/comment sau này. Thay vào đó dựng lại ĐÚNG NHƯ LÚC TẠO: DEFAULT_SOURCES HIỆN TẠI + custom đã lưu.
    let kws = [], savedExtra = [], topicRe = '', hl = countryHl, gl = countryGl, days = newsDays;
    try {
        const rssDir = path.join(process.cwd(), 'rss');
        const logs = fs.readdirSync(rssDir).filter(f => f.startsWith(pid + '_')).sort();
        if (logs.length) {
            const j = JSON.parse(fs.readFileSync(path.join(rssDir, logs[logs.length - 1]), 'utf8'));
            kws = j.keywords || []; topicRe = j.topic || '';
            // Log MỚI có sourcesExtra (nguồn custom). Log CŨ chỉ có j.sources gộp → không tách được custom nên bỏ
            // (ưu tiên tôn trọng việc gỡ nguồn: chỉ crawl các nguồn còn trong DEFAULT_SOURCES hiện tại).
            savedExtra = Array.isArray(j.sourcesExtra) ? j.sourcesExtra : [];
            hl = hl || j.country?.hl || ''; gl = gl || j.country?.gl || '';
            days = j.days || days;
            console.log(`[process_content] Dùng lại từ khóa/nguồn của lần chạy gốc (${logs[logs.length - 1]})`);
        }
    } catch (_) { }
    if (!kws.length) {   // project cũ chưa có log → lấy keyword trong DB làm truy vấn
        const rows = await db.all('SELECT DISTINCT content FROM Keyword WHERE post_id = ? OR paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?)', [post.id, post.id]);
        kws = rows.map(r => r.content).filter(Boolean).slice(0, 12);
        console.log(`[process_content] Không có log RSS gốc → dùng ${kws.length} keyword trong DB`);
    }
    // Nguồn = DEFAULT_SOURCES HIỆN TẠI (đã bỏ nguồn comment) + custom đã lưu → giống hệt logic lúc tạo dự án.
    const srcs = [...new Set([...DEFAULT_SOURCES, ...savedExtra])];
    console.log(`[process_content] Nguồn crawl lại: ${DEFAULT_SOURCES.length} mặc định${savedExtra.length ? ' + ' + savedExtra.length + ' custom' : ''} = ${srcs.length} (theo config hiện tại, KHÔNG dùng nguồn cũ đã gỡ)`);
    if (!kws.length) { console.error('[process_content] Không có từ khóa nào để crawl'); await db.close(); process.exit(1); }

    // Không force: đếm trước xem còn cảnh nào 0 asset không — không thiếu gì thì khỏi tốn 1-2 phút cào tin
    if (!force) {
        const missSec = await db.get(`SELECT COUNT(*) c FROM (SELECT DISTINCT section FROM Keyword WHERE post_id = ? AND section IS NOT NULL) k
            WHERE NOT EXISTS (SELECT 1 FROM Asset a WHERE a.post_id = ? AND a.section = k.section)`, [post.id, post.id]);
        const missPara = await db.get(`SELECT COUNT(*) c FROM Paragraph p
            WHERE p.post_id = ? AND EXISTS (SELECT 1 FROM Keyword k WHERE k.paragraph_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM Asset a WHERE a.paragraph_id = p.id)`, [post.id]);
        const miss = (missSec?.c || 0) + (missPara?.c || 0);
        if (!miss) {
            console.log('[process_content] Mọi cảnh đều đã có media → không cần crawl lại (bấm lại với force để cào hết).');
            await db.close();
            return;
        }
        console.log(`[process_content] Còn ${miss} cảnh thiếu media → crawl bù`);
    }

    await db.run('UPDATE Post SET status = ? WHERE id = ?', ['crawling', post.id]);
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => { })
        .end(JSON.stringify({ postTitle: post.project_id, status: 'crawling' }));

    console.log(`[process_content] CRAWL LẠI post ${post.id} (${pid}) — ${force ? 'TẤT CẢ cảnh' : 'chỉ cảnh còn thiếu'}`);

    // NGUỒN X là nguồn media chính của geo (giống lúc tạo dự án). Crawl lại X theo từng cảnh từ keyword đã lưu.
    await crawlXPerSceneFromDb(db, post.id, pid, { onlyMissing: !force });

    // Tin RSS/Google News + stock: MẶC ĐỊNH TẮT cho geo (chỉ dùng X). Chỉ chạy khi bật GEO_CRAWL_MEDIA=on
    // (không thì phí thời gian cào tin rồi bỏ — crawlMediaForPost cũng tự bỏ qua khi tắt).
    if (process.env.GEO_CRAWL_MEDIA === 'on') {
        const seen = await loadNewsSeen(db, post.project_id);   // bài của CHÍNH dự án này vẫn được dùng lại
        const bundle = await collectNews({
            keywords: kws, sources: srcs,
            hl: hl || 'vi', gl: gl || 'VN',
            days, maxArticles: 30, perKeyword: 15,
            seenIds: seen.ids, seenTitles: seen.titles, seenUrls: seen.urls,
        });
        await saveNewsSeen(db, bundle.articles, post.project_id);
        await crawlMediaForPost({
            db, postId: post.id, projectId: pid,
            articles: bundle.articles,
            searchKeywords: kws, sourceDomains: srcs, topic: topicRe || topic,
            onlyMissing: !force,
            notifyKey: post.project_id,      // SSE của dashboard khoá theo project_id trong DB (có thể có hậu tố _vi)
        });
    }

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [post.id]);
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => { })
        .end(JSON.stringify({ postTitle: post.project_id, status: null }));
    await db.close();
    console.log(`[process_content] ✅ Crawl lại xong post ${post.id}`);
}

// Tạo/ cập nhật trạng thái Post SỚM để dashboard hiện dự án ngay trong lúc còn viết/viết-lại kịch bản
// (khâu LLM dài, trước đây dashboard trắng trơn khiến người dùng tưởng treo). status:
//   'scripting'  -> đang viết kịch bản    | 'rewriting' -> chưa đủ điểm, đang viết lại
//   'crawling'   -> đang cào media (saveToDb lo) | null -> xong
async function setGeoPostStatus(projectId, status, { score = null } = {}) {
    if (!projectId) return;
    try {
        const db = await getDb();
        await db.run('INSERT OR IGNORE INTO Post (project_id, genre) VALUES (?, ?)', [projectId, 'geo']);
        if (score != null && Number.isFinite(score)) {
            await db.run('UPDATE Post SET status = ?, content_score = ? WHERE project_id = ?', [status, score, projectId]);
        } else {
            await db.run('UPDATE Post SET status = ? WHERE project_id = ?', [status, projectId]);
        }
        await db.close();
    } catch (e) { console.warn('[process_content] set status lỗi:', e.message); }
    // Báo dashboard (SSE) — status lạ ('scripting'/'rewriting') KHÔNG bắn Slack (chỉ null/'done' mới bắn).
    try {
        http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
            .end(JSON.stringify({ postTitle: projectId, status }));
    } catch (_) {}
}

try {
    if (mediaOnly) { await runMediaOnly(mediaOnlyPostId, forceAll); process.exit(0); }

    // Tin đã dùng ở các DỰ ÁN TRƯỚC (bảng NewsSeen trong DB) → không xào lại tin cũ.
    const seenDb = await getDb();
    const seen = await loadNewsSeen(seenDb, null);
    console.log(`[process_content] Trí nhớ tin: ${seen.urls.size} bài đã dùng ở các dự án trước`);

    // 1) Thu thập tin mới & sát nhất (RSS gốc + Google News) + cào HẾT ảnh/video trong bài
    console.log(`[process_content] Thu thập tin: ${keywords.length} từ khóa × ${sourceDomains.length} nguồn`);
    const bundle = await collectNews({
        keywords, sources: sourceDomains,
        hl: countryHl || 'vi', gl: countryGl || 'VN',   // mặc định bản VN (khớp từ khóa tiếng Việt); chọn quốc gia thì theo đó
        days: newsDays, maxArticles: 30, perKeyword: 15,
        seenIds: seen.ids, seenTitles: seen.titles, seenUrls: seen.urls,
    });

    // Nguồn X: list account chính trị → tweet → GPT lọc theo từ khóa → media của tweet đạt.
    // Trộn thẳng vào bundle: media vào pool gán cảnh, text làm tư liệu cho GPT-5 xào kịch bản.
    if (xAccounts.length) {
        try {
            const x = await collectFromXAccounts({ accounts: xAccounts, keywords, topic, days: newsDays, limit: 20, seenUrls: seen.urls });
            for (const a of x.articles) {
                bundle.articles.push(a);
                bundle.titles.push({ title: a.title, source: a.source, pub: a.pub, keyword: a.keyword });
            }
            console.log(`[process_content] Nguồn X: +${x.articles.length} tweet đạt (tổng ${bundle.articles.length} nguồn)`);
        } catch (e) { console.error('[process_content] Nguồn X lỗi:', e.message); }
    }

    // Monitor sheet: không có tin mới -> thoát (exit 2), KHÔNG tạo project, KHÔNG tốn GPT
    if (seenFile && !bundle.articles.length) {
        await seenDb.close();
        console.log('[geo-result] ' + JSON.stringify({ new: 0, projectId: null }));
        console.log('[process_content] Không có tin mới -> bỏ qua.');
        process.exit(2);
    }
    if (!bundle.articles.length) {
        await seenDb.close();
        console.error('[process_content] Không có tin mới nào (mọi bài đều đã dùng ở dự án trước) -> dừng.');
        process.exit(2);
    }

    // 1b) CHỐNG TRÙNG VẤN ĐỀ: loại tin nói lại vấn đề các dự án geo trước đã làm.
    try {
        const covered = await loadCoveredIssues(seenDb);
        if (covered.length) {
            console.log(`[dedup] Đối chiếu với ${covered.length} dự án geo gần đây...`);
            const keep = await filterCoveredIssues(covered, bundle.titles);
            if (keep) {
                const arts = [], tits = [];
                for (let i = 0; i < bundle.titles.length; i++) {
                    if (!keep.has(i)) continue;
                    tits.push(bundle.titles[i]);
                    if (bundle.articles[i]) arts.push(bundle.articles[i]);
                }
                if (!tits.length) {
                    await seenDb.close();
                    console.log('[geo-result] ' + JSON.stringify({ new: 0, projectId: null }));
                    console.log('[process_content] Mọi tin đều trùng vấn đề dự án cũ -> bỏ qua (không tạo dự án).');
                    process.exit(2);
                }
                console.log(`[dedup] Còn ${tits.length}/${bundle.titles.length} tin có vấn đề MỚI`);
                bundle.titles = tits;
                if (arts.length) bundle.articles = arts;
            }
        }
    } catch (e) { console.warn('[dedup] bỏ qua lọc trùng:', e.message); }

    // 2) Đưa title cho AI xào kịch bản
    // Hiện dự án lên dashboard NGAY (kèm note "đang viết kịch bản") — khâu LLM dưới đây rất dài.
    await setGeoPostStatus(projectId, 'scripting');
    let result = await analyzeWithGPT5(topic, bundle.titles, sources);
    console.log(`[process_content] GPT-5 trả về ${result.luan_diem?.length || 0} luận điểm`);
    result._articles = bundle.articles;   // media đã cào để gán vào paragraph/section
    // Chấm điểm chất lượng nội dung (1 lần gọi GPT nữa) — không chặn nếu lỗi
    let scoreObj = await scoreContentWithGPT(result);
    // Kiểm tra cấu trúc (chống dồn 1 luận điểm / luận cứ băm nhỏ → keyword nổ).
    let struct = analyzeStructure(result);
    if (struct.issues.length) console.log(`[process_content] ⚠ Cấu trúc chưa đạt (${struct.numLd} luận điểm, ${struct.numLc} luận cứ): ${struct.issues.join('; ')}`);
    // Lịch sử đánh giá: bản đầu + các bản viết lại, để so sánh trên dashboard.
    const scoreHistory = [];
    if (scoreObj) scoreHistory.push({ stage: 'initial', score: scoreObj.score, reason: scoreObj.reason, detail: scoreObj.detail, structIssues: struct.issues, at: new Date().toISOString(), used: true });

    // Viết lại khi: điểm dưới ngưỡng HOẶC cấu trúc thoái hóa. LẶP tới khi đạt (hoặc hết số lần).
    // Luôn giữ bản TỐT NHẤT (ưu tiên cấu trúc đạt, rồi tới điểm cao).
    const scoreLow = () => REWRITE_SCORE_THRESHOLD > 0 && scoreObj && scoreObj.score < REWRITE_SCORE_THRESHOLD;
    let attempt = 0;
    while ((scoreLow() || struct.issues.length > 0) && attempt < REWRITE_MAX_ATTEMPTS) {
        attempt++;
        const why = struct.issues.length ? `cấu trúc lỗi: ${struct.issues.join('; ')}` : `điểm ${scoreObj.score} < ${REWRITE_SCORE_THRESHOLD}`;
        await setGeoPostStatus(projectId, 'rewriting', { score: scoreObj ? scoreObj.score : null });
        console.log(`[process_content] ✍️  Viết lại lần ${attempt}/${REWRITE_MAX_ATTEMPTS} — ${why}...`);
        const rewritten = await rewriteContentWithGPT(result, scoreObj, struct.issues);
        if (!rewritten) { console.warn('[process_content] viết lại thất bại → dừng vòng, giữ bản tốt nhất'); break; }
        rewritten._news = result._news;
        rewritten._articles = bundle.articles;
        const reScore = await scoreContentWithGPT(rewritten);
        const reStruct = analyzeStructure(rewritten);
        // Nhận bản mới nếu: sửa được nhiều lỗi cấu trúc hơn, HOẶC (không tệ hơn về cấu trúc VÀ điểm không giảm).
        const structBetter = reStruct.issues.length < struct.issues.length;
        const scoreOk = !reScore || !scoreObj || reScore.score >= scoreObj.score;
        const better = structBetter || (reStruct.issues.length <= struct.issues.length && scoreOk);
        scoreHistory.push({
            stage: 'rewrite', attempt,
            score: reScore ? reScore.score : null,
            reason: reScore ? reScore.reason : 'không chấm lại được',
            detail: reScore ? reScore.detail : null,
            structIssues: reStruct.issues,
            at: new Date().toISOString(),
            used: better,
        });
        if (better) {
            console.log(`[process_content] ✅ Nhận bản viết lại lần ${attempt}: điểm ${scoreObj ? scoreObj.score : '?'} -> ${reScore ? reScore.score : '?'}/100, cấu trúc ${struct.issues.length} -> ${reStruct.issues.length} lỗi (${reStruct.numLd} luận điểm)`);
            for (const h of scoreHistory) h.used = false;   // bản này thắng → các bản trước không dùng
            scoreHistory[scoreHistory.length - 1].used = true;
            result = rewritten;
            struct = reStruct;
            if (reScore) scoreObj = reScore;
            // Không chấm lại được VÀ cấu trúc đã đạt → dừng (tránh lặp mù). Nếu cấu trúc còn lỗi thì tiếp tục thử.
            if (!reScore && !struct.issues.length) break;
        } else {
            console.log(`[process_content] ↩️  Bản viết lại lần ${attempt} không tốt hơn (điểm ${reScore ? reScore.score : '?'}, cấu trúc ${reStruct.issues.length} lỗi) -> giữ bản tốt nhất, thử lại`);
        }
    }
    if (attempt >= REWRITE_MAX_ATTEMPTS && (scoreLow() || struct.issues.length)) {
        console.log(`[process_content] ⚠️  Hết ${REWRITE_MAX_ATTEMPTS} lần viết lại mà vẫn chưa đạt (điểm ${scoreObj ? scoreObj.score : '?'}, cấu trúc ${struct.issues.length} lỗi) → dùng bản tốt nhất.`);
    }
    // GHI TRÍ NHỚ NGAY (trước khi cào media, khâu dài nhất và hay bị pm2 restart giết):
    // trước đây chỉ ghi ở CUỐI lượt chạy nên run bị giết = quên sạch → dự án sau xào lại đúng mấy bài đó.
    await saveNewsSeen(seenDb, bundle.articles, projectId);
    await seenDb.close();
    await saveToDb(projectId, result, scoreObj, scoreHistory);
    if (seenFile) console.log('[geo-result] ' + JSON.stringify({ new: bundle.articles.length, projectId }));
    process.exit(0);
} catch (e) {
    console.error('[process_content] LỖI:', e.message);
    // Dọn "ghost project": nếu đã tạo Post sớm (status scripting/rewriting) nhưng CHƯA có nội dung
    // (crash trước saveToDb) → xoá để dashboard không kẹt 1 dự án rỗng đang quay.
    if (projectId && !mediaOnly) {
        try {
            const db = await getDb();
            const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
            if (post) {
                const np = await db.get('SELECT COUNT(*) AS n FROM Paragraph WHERE post_id = ?', [post.id]);
                if (!np || !np.n) {
                    await db.run('DELETE FROM Post WHERE id = ?', [post.id]);
                    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
                        .end(JSON.stringify({ postTitle: projectId, status: null }));
                    console.log('[process_content] Đã xoá ghost project rỗng:', projectId);
                }
            }
            await db.close();
        } catch (_) {}
    }
    process.exit(1);
}
