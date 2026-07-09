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
import { collectNews } from './news_pipeline.js';
import { readStockSource } from './stockNaming.js';

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
const newsDays = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 3;   // cửa sổ tin "when:Nd" (mặc định 3)

// LUỒNG MỚI: input là MẢNG TỪ KHÓA + MẢNG DOMAIN NGUỒN (JSON). Tổ hợp tất cả qua Google News.
function parseArr(raw) { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : []; } catch { return raw ? raw.split(/[|,\n]/).map(s => s.trim()).filter(Boolean) : []; } }
const keywords = parseArr(getArg('--keywords'));
if (!keywords.length && contentArg) keywords.push(contentArg);   // fallback: dùng --content như 1 từ khóa
const sourceDomains = parseArr(getArg('--sources'));             // vd ["reuters.com","vnexpress.net"]
const topic = contentArg || keywords.join(', ');                 // tiêu đề/chủ đề cho GPT + đặt tên project
const sources = sourceDomains.length ? sourceDomains.join(', ') : 'Reuters, AP, BBC, CNN, DW, Al Jazeera';

if (!projectId || !keywords.length) {
    console.error('[process_content] Thiếu --projectId hoặc --keywords/--content');
    process.exit(1);
}

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
        'TAO NOI DUNG YOUTUBE DIA CHINH TRI THE GIOI THEO KIEU CINEMATIC STORYTELLING',
        '',
        'CHU DE: ' + topic,
        '',
        ...newsBlock,
        'MUC TIEU:',
        '- Tao bai phan tich dia chinh tri theo phong cach documentary YouTube hien dai.',
        '- Noi dung phai cuon, co chieu sau va giu retention cao.',
        '- Giong mot geopolitical documentary storytelling chuyen nghiep.',
        '- Nguoi xem phai cam thay dang theo doi mot ban co quyen luc thuc su.',
        '- Do dai tong the phai du de tao video voice-over khoang 8-10 phut.',
        '- Storytelling phai du nhiep do de giu retention trong suot video.',
        '',
        'PHONG CACH:',
        '- Viet theo phong cach cinematic geopolitical storytelling.',
        '- Giong narration voice-over documentary.',
        '- Storytelling phai co dong chay lien tuc nhu mot documentary narration.',
        '- Storytelling phai co nhip documentary: mo rong dan, dao sau dan va tang stakes tu nhien.',
        '- Chuyen doan va transition phai muot.',
        '- Dan dat tu nhien, khong gay cam giac AI.',
        '- Moi phan phai lien ket huu co voi phan truoc.',
        '- Moi transition phai tao cam giac co them mot lop su that dang duoc mo ra.',
        '- Moi doan phai ket thuc theo cach khien nguoi xem muon nghe tiep.',
        '- Transition phai tu nhien nhu dang ke chuyen.',
        '- Uu tien transition mang tinh doi lap, chien luoc hoac escalation.',
        '- Han che cac transition AI nhu:',
        '  "Khong chi vay", "Trong khi do", "Ben canh do", "Mot van de khac"...',
        '- Toan bo bai phai giu mot goc nhin narrative thong nhat tu dau toi cuoi.',
        '',
        'MO BAI: tuong ung voi hook_vi va hook_target',
        '- Mo bai ngan gon, vao thang van de.',
        '- Hook trong 2-4 cau dau.',
        '- Tao su to mo, tension hoac cam giac co mot dieu lon dang dien ra.',
        '- Sau hook phai vao ngay trung tam van de.',
        '- KHONG mo bai dai dong.',
        '',
        'GOC NHIN DIA CHINH TRI:',
        '- Moi su kien deu phai duoc nhin duoi goc nhin loi ich quoc gia.',
        '- Phan tich dong co chien luoc cua cac ben lien quan.',
        '- Chi ra ai dang huong loi, ai dang mat loi.',
        '- Lam ro tac dong kinh te, quan su, ngoai giao va anh huong khu vuc.',
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
        '- Moi phan moi phai mo rong quy mo van de lon hon phan truoc.',
        '- Cu 2-3 doan phai co mot chi tiet bat ngo, nghich ly hoac cau hoi mo.',
        '- Tao cam giac tinh hinh dang am tham leo thang.',
        '- Storytelling phai co cam giac tinh hinh dang dan tro nen lon hon, phuc tap hon hoac nguy hiem hon qua tung phan.',
        '- Storytelling phai co duong cong escalation ro rang, moi phan sau phai tao cam giac stakes lon hon phan truoc.',
        '- Nhip van phai nhanh gon, khong dai dong.',
        '- Moi phan phai co cam giac dang dan nguoi xem di sau hon vao ban chat van de.',
        '- Moi phan phai tao cam giac day khong chi la mot su kien rieng le, ma la mot phan cua buc tranh quyen luc lon hon.',
        '',
        'TUYET DOI KHONG:',
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
        '- KHONG bien moi su kien thanh khung hoang hoac chien tranh.',
        '- Giu giong dieu binh tinh, tham trong nhung dang ngai.',
        '- Han che an du, nhan hoa hoac van phong qua van chuong.',
        '- Uu tien geopolitical realism thay vi dramatic writing.',
        '- Han che dung dau "—", ";", "..." va cac dau cau mang tinh dramatic qua muc.',
        '',
        'CAU TRUC NOI DUNG:',
        '- Toan bai co 4-6 luan diem lon.',
        '- Moi luan diem phai duoc trien khai thanh mot narrative co setup, escalation, implication va consequence ro rang.',
        '- Moi luan diem phai duoc trien khai nhu mot dong narrative lien tuc.',
        '- Toan bo bai phai co cam giac nhu mot cau chuyen lien tuc thay vi cac muc tach roi.',
        '- Cac luan cu phai lien ket huu co va mo rong tu nhien tu y truoc.',
        '- Khong tao cam giac dang tach thanh cac muc rieng le.',
        '- Moi luan cu chi la mot lop thong tin moi duoc mo rong them trong cau chuyen.',
        '- Moi luan diem nen tao cam giac dang reveal them mot lop dong co, loi ich hoac chien luoc an sau.',
        '- Moi content_vi va content_target phai du chi tiet de dung thanh mot doan voice-over cinematic.',
        '- Khong viet qua ngan hoac ket luan qua som.',
        '- Moi luan diem phai dao sau vao dong co, phan ung va tac dong day chuyen.',
        '- Uu tien cau ngan, ro, cinematic va de voice-over.',
        '- Sau moi cau nen xuong dong de toi uu narration, subtitle va pacing cho voice-over.',
        '- Khong vong vo hay lap thong tin.',
        '- Moi luan diem phai co transition muot sang y tiep theo.',
        '',
        'YEU CAU PHAN TICH:',
        '- Khong chi noi dieu gi dang xay ra.',
        '- Phai giai thich:',
        '  + Vi sao no quan trong',
        '  + Dong co cua cac ben',
        '  + Ai dang huong loi',
        '  + Tac dong day chuyen',
        '  + Dieu gi co the xay ra tiep theo',
        '- Neu hop ly, hay phan tich hieu ung domino ma su kien nay co the gay ra.',
        '- Neu hop ly, hay phan tich vi sao su kien lai xay ra vao thoi diem nay.',
        '- Neu hop ly, hay lien ket voi trade route, chuoi cung ung, nang luong, an ninh khu vuc va canh tranh anh huong.',
        '- Neu hop ly, hay mo ta vi tri dia ly, trade route, khu vuc chien luoc hoac hanh lang anh huong de tao cam giac geopolitical.',
        '',
        'NGON NGU:',
        '- Viet song ngu dong thoi.',
        '- _vi = tieng Viet.',
        '- _target = ' + targetLang + '.',
        '- BAT BUOC: Tat ca content_sentences, hook_sentences, conclusion_sentences PHAI LA ARRAY CUA CAC CAP {vi, en}.',
        '- Moi phan tu trong array la mot cau hoan chinh VI va EN tuong ung.',
        '- Vi du: [{vi: "Cau 1 tieng Viet.", en: "Sentence 1 in English."}, {vi: "Cau 2.", en: "Sentence 2."}]',
        '- KHONG DUOC de content_vi hoac content_target rieng le.',
        '',
        'MEDIA KEYWORDS:',
        '- Voi moi luan_diem va luan_cu, BAT BUOC phai tao 2 loai keyword tieng Anh tach biet de phuc vu he thong render tự động.',
        '- 1. keywords_factual: 3-5 tu khoa SỰ KIỆN THỰC TẾ de bot tim kiem tren bao chi (AP News, Reuters).',
        '  + CHI su dung danh tu rieng, ten chinh tri gia, dia danh, vu khi, hoac hanh dong the hien su kien.',
        '  + TUYET DOI KHONG dung tu mieu ta goc may, nghe thuat hay anh sang.',
        '  + Vi du ĐÚNG: "US Navy South China Sea", "Donald Trump press conference", "C-130J aircraft maintenance".',
        '  + Vi du SAI: "radar screen glow", "military warship cinematic".',
        '- 2. keywords_cinematic: 3-5 tu khoa B-ROLL NGHE THUAT de search tren Storyblocks/Envato.',
        '  + Mieu ta chi tiet goc may quay, cam xuc, boi canh hoac chi tiet dac ta mang tinh bieu tuong.',
        '  + Vi du: "radar screen glow macro", "satellite data flow animation", "politician shadow walking steadycam".',
        '- Tu khoa phai cuc ky sat voi noi dung cua tung luan_cu, khong duoc lay chung chung.',
        '- TUONG TU voi hook, conclusion: cung phai co hook_keywords_factual, hook_keywords_cinematic,',
        '  conclusion_keywords_factual, conclusion_keywords_cinematic.',
        'KET BAI: tuong ung voi conclusion',
        '- BAT BUOC phai co phan conclusion_vi va conclusion_target rieng.',
        '- Ket bai chi can mot dong narrative tong ket, KHONG chia luan cu.',
        '- Ket bai phai tao du am va cam giac van de van dang tiep dien.',
        '- Co the ket bang cau hoi mo hoac du bao cho dien bien tiep theo.',
        '- Ket bai phai co cam giac documentary ket thuc nhung ban co van dang van dong.',
        '- Ket bai nen dua nguoi xem quay lai buc tranh quyen luc lon hon.',
        '- Cau cuoi cung cua ket bai nen keu goi nguoi xem like video, dang ky kenh va de lai y kien duoi phan binh luan mot cach tu nhien.',
        '- Ket bai KHONG duoc bi bo sot trong output cuoi.',
        '',
        'OUTPUT PHAI CAM GIAC NHU:',
        '- Mot documentary geopolitical hien dai.',
        '- Mot ban co quyen luc dang van dong.',
        '- Mot cuoc canh tranh anh huong dang am tham leo thang.',
        '- Khong chi la tin tuc, ma la cau chuyen cua chien luoc va loi ich.'
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

    await db.run('INSERT OR IGNORE INTO Post (project_id) VALUES (?)', [postTitle]);
    await db.run('UPDATE Post SET status = ? WHERE project_id = ?', ['crawling', postTitle]);

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

    // Crawl media cho tất cả sections và paragraphs — TỪ ẢNH/VIDEO ĐÃ CÀO TRONG BÀI BÁO
    {
        // Gom toàn bộ media cào được từ các bài (mỗi item gắn tiêu đề bài để khớp token theo đoạn)
        // Chuẩn hoá URL để gộp cùng 1 ảnh khác kích thước/định dạng/host (bỏ query, /wNNN/, /thumb/, đuôi .webp/.avif, host)
        const normImg = (u) => u.split('?')[0]
            .replace(/\/w\d+\//, '/').replace(/\/thumb\/[^/]+\//, '/')
            .replace(/\.(webp|avif)$/i, '').replace(/^https?:\/\/[^/]+/, '').toLowerCase();
        const articles = result._articles || [];
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
            await runConcurrently(tasks, 2);   // 2 (mỗi cái lại bung nhiều provider) — tránh quá nhiều browser stealth cùng lúc
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
            keywords,
            sources: sourceDomains,
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
                        }
                    } catch (e) { console.error(`[process_content] yt-dlp ${gid}: ${e.message}`); }
                }
            }
        };

        // Sections: hook, conclusion — RSS news khớp keyword của section
        for (const section of ['hook', 'conclusion']) {
            const kws = await db.all('SELECT content FROM Keyword WHERE post_id = ? AND section = ?', [postId, section]);
            if (!kws.length) continue;
            const vFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_videos', section);
            const iFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_images', section);
            [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            const ins = (rel, type, srcUrl) => db.run('INSERT INTO Asset (post_id, section, type, file_path, source_url) VALUES (?, ?, ?, ?, ?)', [postId, section, type, rel, srcUrl || null]);
            const tokens = [...new Set(kws.flatMap(k => tokenize(k.content)))];
            await attachNews(tokens, section, iFolder, vFolder, ins);
            await attachStock(kws.map(k => k.content), iFolder, vFolder, ins);   // nguồn khác (stock) bổ sung
        }

        // Paragraphs — RSS news khớp tiêu đề + keyword của từng đoạn
        const paragraphs = await db.all('SELECT id, "order", title, title_vi FROM Paragraph WHERE post_id = ? ORDER BY "order"', [postId]);
        for (const para of paragraphs) {
            const gid = String(para.order);
            const kws = await db.all('SELECT content FROM Keyword WHERE paragraph_id = ?', [para.id]);
            if (!kws.length) continue;
            const vFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_videos', gid);
            const iFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_images', gid);
            [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
            const ins = (rel, type, srcUrl) => db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path, source_url) VALUES (?, NULL, ?, ?, ?)', [para.id, type, rel, srcUrl || null]);
            const newsTokens = [...new Set([...tokenize(para.title_vi), ...tokenize(para.title), ...kws.flatMap(k => tokenize(k.content))])];
            await attachNews(newsTokens, gid, iFolder, vFolder, ins);
            await attachStock(kws.map(k => k.content), iFolder, vFolder, ins);   // nguồn khác (stock) bổ sung
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

    await db.run('UPDATE Post SET status = NULL WHERE project_id = ?', [postTitle]);
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
        .end(JSON.stringify({ postTitle, status: null }));

    await db.close();
    console.log(`[process_content] ✅ Hoàn thành project: ${projectId}`);
}

try {
    // 1) Thu thập tin mới & sát nhất (Google News theo từ khóa × domain nguồn) + cào HẾT ảnh/video trong bài
    console.log(`[process_content] Thu thập tin: ${keywords.length} từ khóa × ${sourceDomains.length} nguồn`);
    const bundle = await collectNews({
        keywords, sources: sourceDomains,
        hl: countryHl || 'vi', gl: countryGl || 'VN',   // mặc định bản VN (khớp từ khóa tiếng Việt); chọn quốc gia thì theo đó
        days: newsDays, maxArticles: 30, perKeyword: 15,
    });
    // 2) Đưa title cho GPT-5 xào kịch bản
    const result = await analyzeWithGPT5(topic, bundle.titles, sources);
    console.log(`[process_content] GPT-5 trả về ${result.luan_diem?.length || 0} luận điểm`);
    result._articles = bundle.articles;   // media đã cào để gán vào paragraph/section
    await saveToDb(projectId, result);
    process.exit(0);
} catch (e) {
    console.error('[process_content] LỖI:', e.message);
    process.exit(1);
}
