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
import { readStockSource } from '../lib/stockNaming.js';
import { setLogProject, logCrawlInfo, logCrawlError } from '../lib/crawlLogger.js';

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
const mediaOnly = args.includes('--mediaOnly');
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
    const res = await httpsPost(
        'https://api.openai.com/v1/chat/completions',
        { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: `Translate to ${lang}. Return ONLY translated text, no explanation.` },
                { role: 'user', content: text }
            ],
            temperature: 0.2
        }
    );
    if (res.status !== 200) return text;
    const data = JSON.parse(res.body);
    return data.choices?.[0]?.message?.content?.trim() || text;
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
        const res = await httpsPost(
            'https://api.openai.com/v1/chat/completions',
            { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
            { model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' },
              messages: [{ role: 'system', content: sys }, { role: 'user', content: topic }] }
        );
        if (res.status !== 200) return forced ? { en: topic, local: '', hl: countryHl, gl: countryGl } : null;
        const j = JSON.parse(JSON.parse(res.body).choices[0].message.content);
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

async function analyzeWithGPT5(topic, newsTitles, sources) {
    const schema = {
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
                                    keywords_cinematic: { type: 'array', items: { type: 'string' } }
                                },
                                required: ['title_vi', 'title_target', 'content_sentences', 'keywords_factual', 'keywords_cinematic'],
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
        '- Tao bai phan tich dia chinh tri theo phong cach documentary YouTube hien dai danh rieng cho thi truong Nhat Ban.',
        '- Noi dung phai cuon, co chieu sau va giu retention cao.',
        '- Giong mot geopolitical documentary storytelling chuyen nghiep nhu NHK Special / BBC.',
        '- Nguoi xem phai cam thay dang theo doi mot ban co quyen luc thuc su.',
        '- Do dai tong the phai du de tao video voice-over khoang 8-10 phut (Khoang 2,200 - 2,800 ky tu tieng Nhat).',
        '- Storytelling phai co nhip documentary: mo rong dan, dao sau dan va tang stakes tu nhien.',
        '',
        'LAP TRUONG CHU QUYEN & AN NINH QUOC GIA NHAT BAN (BAT BUOC):',
        '- LUON DUNG TREN LAP TRUONG CHU QUYEN VA LOI ICH QUOC GIA CUA NHAT BAN.',
        '- QUY TAC TEN GOI:',
        '  + BAT BUOC dung "尖閣諸島" (Quan dao Senkaku). TUYET DOI KHONG nhac ten tieng Trung (Dieu Ngu/Diaoyu) hay cach goi trung lap cua ben thu ba.',
        '  + Goi hanh vi tau nuoc ngoai vao vung bien Senkaku la "領海侵入" (Xam nhap hai phan) hoac "接続水域の入域" (Vao vung tiep giap).',
        '  + Goi hanh dong cua Luc luong Bao ve bo bien Nhat (JCG) la "警告・排除" (Canh bao/Tuyen truyen canh gioi de bao ve trat tu phap ly).',
        '- GOC NHIN DIA CHINH TRI: Moi su kien quoc te (Dai Loan, Bien Dong, My-Trung) deu phai phan tich duoi goc nhin: Anh huong the nao den an ninh, tuyen duong hang hai (Sea Lanes) va kinh te cua Nhat Ban.',
        '',
        'VAN HOA & VAN PHONG NHAT BAN:',
        '- Binh tinh, diem tinh (冷静), khach quan va kiem che. TUYET DOI KHONG giat gan re tien, KHONG ho hao.',
        '- Dung cac phep an du sac ben mang tinh chien luoc (Vi du: "chiec dong ho do ap luc", "nhip dieu cua chien tranh", "vung xam").',
        '- Tao cam giac "moi de doat tham lang nhung sat suon" (静かなる脅威 / 漸進的な圧力).',
        '- Bat buoc dung the van Chotai: 常体 (duoi cau だ・である) de tao su uy quyen, khach quan cua phim tai lieu.',
        '',
        'QUY TAC CHUYEN LUAN CU & TRANSITIONS (DE KICH BAN CUC KY MUOT MA):',
        '- TUYET DOI KHONG duoc nhay dot ngot tu chu de nay sang chu de khac (vi du: tu Quan su sang Kinh te, hoac tu Ngoai giao sang Noi chinh).',
        '- MOI KHI CHUYEN SANG LUAN CU MOI, BAT BUOC phai co 1-2 cau chuyen doan (Narrative Bridge) dua tren cac cong thuc sau:',
        '  1. Cong thuc Mau thuan / Nghich ly (Paradox): "Mat nuoc quan su thi suc soi, nhung ben duoi dong chay kinh te lai..." (軍事的な緊張がどれほど高まろうとも、経済の糸は…)',
        '  2. Cong thuc Nguyen nhan - Hau qua (Cause-Effect Layering): "Su be tac tren bien nhanh chong lan sang phong hop cua tap doan..." (海上の膠着状態は、直ちに企業の取締役会へと波及する…)',
        '  3. Cong thuc Buc tranh lon (Zoom-out/Zoom-in): "Chiec tau tuan tra tren bien chi la mot nua buc tranh, nua con lai nam o..." (現場の巡視船は絵の半分に過ぎない。もう半分は…)',
        '- TRANSITION PHAI TU NHIEN NHU DANG KE CHUYEN, UU TIEN TRANSITION MANG TINH DOI LAP, CHIEN LUOC HOAC ESCALATION.',
        '- HAN CHE TU NHOI AI THO KECH TRONG TIENG NHAT NHU:',
        '  "それだけでなく" (Khong chi vay), "一方で" (Dung lap lai qua nhieu), "また" (Ngoai ra), "さらに"...',
        '- NÊN DÙNG CAC TU NOI TAO NHIP DOCUMENTARY:',
        '  "しかし、本当の戦線は…", "この静寂の裏で…", "数字が語る真実は…", "安全保障の鋭い刃のすぐ隣で…"',
        '',
        'MO BAI: tuong ung voi hook_vi va hook_target',
        '- Mo bai ngan gon, vao thang van de.',
        '- Hook trong 2-4 cau dau.',
        '- Tao su to mo, tension hoac cam giac co mot dieu lon dang dien ra.',
        '- Sau hook phai vao ngay trung tam van de.',
        '- KHONG mo bai dai dong.',
        '',
        'GOC NHIN DIA CHINH TRI:',
        '- Moi su kien deu phai duoc nhin duoi goc nhin loi ich quoc gia va geopolitical realism.',
        '- Phan tich dong co chien luoc cua cac ben lien quan.',
        '- Chi ra ai dang huong loi, ai dang mat loi.',
        '- Lam ro tac dong kinhte, quan su, ngoai giao va anh huong khu vuc.',
        '- Dat moi dien bien vao buc tranh quyen luc lon hon.',
        '- Neu hop ly, hay chi ra hidden agenda hoac strategic signaling.',
        '',
        'NARRATIVE MODE:',
        '- Neu la chien tranh: tao tension, escalation, uncertainty.',
        '- Neu la ngoai giao: nhan manh timing, hidden signal, strategic balancing.',
        '- Neu la kinh te: nhan manh domino effect, supply chain, leverage.',
        '- Neu la trade route, cang bien, kenh dao: nhan manh strategic location va influence competition.',
        '- Neu la lien minh quan su: nhan manh balance of power.',
        '',
        'RETENTION:',
        '- Moi phan moi phai mo rong quy mo van de lon hon phan truoc (Cau truc 4-6 Lop/Layers).',
        '- Cu 2-3 doan phai co mot chi tiet bat ngo, nghich ly hoac cau hoi mo.',
        '- Tao cam giac tinh hinh dang am tham leo thang.',
        '- Storytelling phai co cam giac tinh hinh dang dan tro nen lon hon, phuc tap hon hoac nguy hiem hon qua tung phan.',
        '- Storytelling phai co duong cong escalation ro rang, moi phan sau phai tao cam giac stakes lon hon phan truoc.',
        '- Nhip van phai nhanh gon, khong dai dong.',
        '- Moi phan phai co cam giac dang dan nguoi xem di sau hon vao ban chat van de.',
        '- Moi phan phai tao cam giac day khong chi la mot su kien rieng le, ma la mot phan cua buc tranh quyen luc lon hon.',
        '',
        'TUYET DOI KHONG:',
        '- KHONG duoc chen cac tieu de kieu "Dai 1 chuong" (第一章), "Chuong 1", "Phan 1", "Muc 1" vao van ban voice-over.',
        '- KHONG viet theo dang bao cao.',
        '- KHONG viet nhu sach giao khoa.',
        '- KHONG dien giai dai dong.',
        '- KHONG lap lai y.',
        '- KHONG bullet-point hoa noi dung.',
        '- KHONG dung van phong qua hoc thuat.',
        '- KHONG chen URL vao text.',
        '- KHONG viet theo kieu "giai thich cho nguoi xem".',
        '- KHONG dung giong van dang thuyet trinh.',
        '- KHONG tao cam giac AI dang phan tich tung muc rieng le.',
        '- KHONG bien moi su kien thanh khung hoang hoac chien tranh giat gan.',
        '- Giu giong dieu binh tinh, tham trong nhung dang ngai.',
        '- Han che an du, nhan hoa hoac van phong qua van chuong.',
        '- Uu tien geopolitical realism thay vi dramatic writing.',
        '- Han che dung dau "—", ";", "..." va cac dau cau mang tinh dramatic qua muc.',
        '- KHONG the hien goc nhin trung lap lap lo doi voi chu quyen lanh tho cot loi cua Nhat Ban.',
        '',
        'QUY DINH NGON NGU DANG SONG NGU (BAT BUOC SUA LOI FRONTEND):',
        '- Ngon ngu muc tieu: _target = ' + targetLang + ' (Chinh la TIENG NHAT / JAPANESE).',
        '- BAT BUOC: Tat ca content_sentences, hook_sentences, conclusion_sentences PHAI LA ARRAY CUA CAC OBJECT SONG NGU CAP {vi, target, en, ja}.',
        '- QUY TAC GIAN TRAP KEY: AI BAT BUOC GIAN GIA TRI TIENG NHAT VAO TAT CA CAC KEY CUA O BEN PHAI ({target}, {ja}, {en}) DE TRANH LOI KHI FRONTEND COMPONENT DOC SAI KEY.',
        '- Truong [vi] (O BEN TRAI): Phai la TIENG VIET dich mượt, tự nhiên, chính xác nội dung để người quản lý đọc hiểu.',
        '- Truong [target], [ja], [en] (O BEN PHAI): Phai la TIENG NHAT CHUAN VAN PHONG NHK (duoi cau だ・である) de lam Voice-over. TUYET DOI KHONG XUAT TIENG ANH HOAC TIENG VIET O CAC KEY NAY.',
        '- Vi du Output Object chuan:',
        '  [',
        '    {',
        '      vi: "Tokyo đang vẽ lại một tấm bản đồ mới cho an ninh.",',
        '      target: "東京は安全保障の新たな地図を描き直している。",',
        '      ja: "東京は安全保障の新たな地図を描き直している。",',
        '      en: "東京は安全保障の新たな地図を描き直している。"',
        '    }',
        '  ]',
        '',
        'CAU TRUC NOI DUNG & THE VAN:',
        '- Toan bai co 4-6 luan diem lon.',
        '- Moi luan diem phai duoc trien khai thanh mot narrative co setup, escalation, implication va consequence ro rang.',
        '- Toan bo bai phai co cam giac nhu mot cau chuyen lien tuc thay vi cac muc tach roi.',
        '- Uu tien cau ngan, ro, cinematic va de voice-over.',
        '- Sau moi cau nen xuong dong de toi uu narration, subtitle va pacing cho voice-over.',
        '- Moi luan diem phai co transition muot sang y tiep theo.',
        '',
        'MEDIA KEYWORDS:',
        '- Voi moi luan_diem va luan_cu, BAT BUOC phai tao 2 loai keyword tieng Anh tach biet de phuc vu he thong render tu dong.',
        '- 1. keywords_factual: 3-5 tu khoa SU KIEN THUC TE tieng Anh de bot tim kiem tren bao chi (AP News, Reuters).',
        '  + CHI su dung danh tu rieng, ten chinh tri gia, dia danh, vu khi, hoac hanh dong the hien su kien.',
        '  + TUYET DOI KHONG dung tu mieu ta goc may, nghe thuat hay anh sang.',
        '- 2. keywords_cinematic: 3-5 tu khoa B-ROLL NGHE THUAT tieng Anh de search tren Storyblocks/Envato.',
        '  + Mieu ta chi tiet goc may quay, cam xuc, boi canh hoac chi tiet dac ta mang tinh bieu tuong.',
        '- Tu khoa phai cuc ky sat voi noi dung cua tung luan_cu, khong duoc lay chung chung.',
        '',
        'KET BAI: tuong ung voi conclusion',
        '- BAT BUOC phai co phan conclusion_vi va conclusion_target rieng.',
        '- Ket bai chi can mot dong narrative tong ket, KHONG chia luan cu.',
        '- Ket bai phai tao du am va cam giac van de van dang tiep dien.',
        '- Cau cuoi cung cua ket bai nen keu goi nguoi xem like video, dang ky kenh va de lai y kien duoi phan binh luan mot cach tu nhien.',
        '- Ket bai KHONG duoc bi bo sot trong output cuoi.',
        '',
        'OUTPUT PHAI CAM GIAC NHU:',
        '- Mot documentary geopolitical hien dai cua NHK Special / BBC.',
        '- Mot ban co quyen luc dang van dong am tham va khong ngung nghi.'
    ].join('\n');

    console.log(`[process_content] Gọi GPT-5 Responses API cho: ${topic}`);

    const res = await httpsPost(
        'https://api.openai.com/v1/responses',
        {
            'Authorization': `Bearer ${OPENAI_KEY}`,
            'Content-Type': 'application/json'
        },
        {
            model: 'gpt-5',
            reasoning: { effort: 'medium' },
            max_output_tokens: 40000,
            tools: [{ type: 'web_search_preview' }],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'phan_tich_dia_chinh_tri',
                    schema,
                    strict: true
                }
            },
            input
        }
    );

    if (res.status !== 200) {
        throw new Error(`GPT-5 API lỗi: ${res.status} ${res.body}`);
    }

    const data = JSON.parse(res.body);
    const usage = data.usage;
    console.log(`[process_content] 📊 Tokens - input: ${usage?.input_tokens}, output: ${usage?.output_tokens}, reasoning: ${usage?.output_tokens_details?.reasoning_tokens}`);
    const outputText = data.output?.find(o => o.type === 'message')
        ?.content?.find(c => c.type === 'output_text')?.text;

    if (!outputText) throw new Error('Không lấy được output từ API: ' + JSON.stringify(data).slice(0, 200));
    
    // Log output GPT để phân tích
    console.log('[process_content] === GPT OUTPUT ===');
    console.log(outputText);
    console.log('[process_content] === END GPT OUTPUT ===');
    
    const result = JSON.parse(outputText);
    result._news = news;   // danh sách tiêu đề tin (để ghi log RSS)
    return result;
}

async function saveToDb(projectId, result) {
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
    await db.run(
        'UPDATE Post SET title = ?, target_lang = ?, hook = ?, hook_vi = ?, conclusion_vi = ?, conclusion_target = ? WHERE id = ?',
        [stripLinks(result.title), targetLang, stripLinks(hookTarget), stripLinks(hookVi),
         stripLinks(conclusionVi), stripLinks(conclusionTarget), postId]
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
                    'INSERT INTO Sentence (paragraph_id, content, content_vi, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                    [paragraphId, stripLinks(contentTarget), stripLinks(contentVi), stripLinks(doan.title_target), stripLinks(doan.title_vi), sentenceOrder]
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
    let kws = [], srcs = [], topicRe = '', hl = countryHl, gl = countryGl, days = newsDays;
    try {
        const rssDir = path.join(process.cwd(), 'rss');
        const logs = fs.readdirSync(rssDir).filter(f => f.startsWith(pid + '_')).sort();
        if (logs.length) {
            const j = JSON.parse(fs.readFileSync(path.join(rssDir, logs[logs.length - 1]), 'utf8'));
            kws = j.keywords || []; srcs = j.sources || []; topicRe = j.topic || '';
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
    if (!srcs.length) srcs = [...DEFAULT_SOURCES];
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

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [post.id]);
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => { })
        .end(JSON.stringify({ postTitle: post.project_id, status: null }));
    await db.close();
    console.log(`[process_content] ✅ Crawl lại xong post ${post.id}`);
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
    // 2) Đưa title cho GPT-5 xào kịch bản
    const result = await analyzeWithGPT5(topic, bundle.titles, sources);
    console.log(`[process_content] GPT-5 trả về ${result.luan_diem?.length || 0} luận điểm`);
    result._articles = bundle.articles;   // media đã cào để gán vào paragraph/section
    // GHI TRÍ NHỚ NGAY (trước khi cào media, khâu dài nhất và hay bị pm2 restart giết):
    // trước đây chỉ ghi ở CUỐI lượt chạy nên run bị giết = quên sạch → dự án sau xào lại đúng mấy bài đó.
    await saveNewsSeen(seenDb, bundle.articles, projectId);
    await seenDb.close();
    await saveToDb(projectId, result);
    if (seenFile) console.log('[geo-result] ' + JSON.stringify({ new: bundle.articles.length, projectId }));
    process.exit(0);
} catch (e) {
    console.error('[process_content] LỖI:', e.message);
    process.exit(1);
}
