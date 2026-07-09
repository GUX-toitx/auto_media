// news_pipeline.js
// Luồng: (mảng từ khóa × mảng domain nguồn) -> Google News RSS (tin mới & sát nhất)
//   -> giải mã URL báo gốc -> FlareSolverr (vượt Cloudflare) tải HTML -> cào HẾT ảnh/video trong bài.
// Export: collectNews({ keywords, sources, ... }) -> { articles:[{title, source, pub, url, keyword, images:[], videos:[]}], titles:[] }
import 'dotenv/config';
import https from 'https';
import http from 'http';

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';

// ---------- HTTP nhẹ (Google News RSS + batchexecute, không bị Cloudflare) ----------
function httpGet(url, depth = 0) {
    return new Promise((resolve, reject) => {
        const req = (url.startsWith('http://') ? http : https).get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Cookie': 'CONSENT=YES+1', 'Accept-Language': 'en-US,en;q=0.9' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 6) {
                res.resume();
                return httpGet(new URL(res.headers.location, url).href, depth + 1).then(resolve, reject);
            }
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}
function httpPost(url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url); const data = Buffer.from(body);
        const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Content-Length': data.length } }, (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        });
        req.on('error', reject); req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data); req.end();
    });
}
const decodeXml = (s) => (s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

// ---------- FlareSolverr (vượt Cloudflare) ----------
async function fsRequest(payload) {
    const res = await fetch(FLARESOLVERR_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.json();
}
async function fsCreateSession() {
    try { const j = await fsRequest({ cmd: 'sessions.create' }); return j.session || (j.solution && j.session) || null; } catch { return null; }
}
async function fsDestroySession(session) { if (session) try { await fsRequest({ cmd: 'sessions.destroy', session }); } catch { } }
async function fsGet(url, session) {
    const j = await fsRequest({ cmd: 'request.get', url, session, maxTimeout: 60000 });
    if (j.status !== 'ok' || !j.solution) throw new Error(j.message || 'flaresolverr fail');
    return j.solution.response || '';
}

// ---------- 1) Google News RSS: keyword + (site:domain OR ...) ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export async function searchGoogleNews(keyword, sources = [], { days = 2, max = 15, hl = 'en-US', gl = 'US', retries = 3 } = {}) {
    // Bỏ chú thích trong ngoặc (vd "台湾有事 (Khủng hoảng Đài Loan)" -> "台湾有事") để query không bị nhiễu
    const kw = String(keyword).replace(/[\(（][^)）]*[\)）]/g, ' ').replace(/\s+/g, ' ').trim() || keyword;
    const sitePart = (sources && sources.length) ? ` (${sources.map(d => `site:${d}`).join(' OR ')})` : '';
    const q = `${kw}${sitePart} when:${days}d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;
    let items = [];
    // Google News RSS thỉnh thoảng trả rỗng (rate-limit) -> thử lại vài lần
    for (let attempt = 1; attempt <= retries; attempt++) {
        items = [];
        try {
            const xml = await httpGet(url);
            for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
                const b = m[1];
                const title = decodeXml((b.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
                const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
                const source = decodeXml((b.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '').trim());
                const link = decodeXml((b.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim());
                const articleId = (link.match(/\/articles\/([^?]+)/) || [])[1];
                if (title && articleId) items.push({ title, pub, source, articleId, keyword, ts: Date.parse(pub) || 0 });
                if (items.length >= max) break;
            }
        } catch (e) { console.error(`[news] search "${keyword}" lần ${attempt} lỗi:`, e.message); }
        if (items.length) break;
        if (attempt < retries) await sleep(1500 * attempt);   // backoff trước khi thử lại
    }
    console.log(`[news] "${keyword}"${sitePart ? ' +sources' : ''}: ${items.length} bài`);
    return items;
}

// ---------- 2) Giải mã link Google News -> URL báo gốc (batchexecute) ----------
export async function decodeGoogleNewsUrl(articleId) {
    try {
        const page = await httpGet(`https://news.google.com/rss/articles/${articleId}`);
        const sig = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
        const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
        if (!sig || !ts) return null;
        const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], articleId, Number(ts), sig]);
        const freq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
        const resp = await httpPost('https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je&source-path=%2Frss%2Farticles&hl=en-US&gl=US', 'f.req=' + encodeURIComponent(freq));
        const m = resp.match(/\\?"(https?:\/\/(?!news\.google)[^"\\]+)\\?"/);
        return m ? decodeXml(m[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/')) : null;
    } catch { return null; }
}

// ---------- 3) Cào ảnh/video từ HTML bài báo (lọc rác mạnh) ----------
// Loại: logo/icon/cờ/thời tiết/quảng cáo/tracking/nút share/app badge/QR + thumbnail bài liên quan.
const JUNK_RE = /logo|sprite|icon|favicon|avatar|gravatar|placeholder|no-image|blank|spacer|loading|spinner|tracking|pixel|1x1|\/ads?[\/_.-]|adv\.|\/delivery\/|avw\.php|doubleclick|analytics|\/imps|\blog\.|share|social|emoji|badge|button|taboola|outbrain|adservice|adsystem|adnxs|banner|sponsor|promoted|thumb|cxpublic|dominantthumb|worldcup|\/teams\/|\/weather\/|mcms\.one|google[-_]news|apple_app|android_app|qr[-_]?code|g-bnews|n_yt|n_fb|\.svg(\?|$)|\/static\/|\/templates?\/|template[_-]|\/themes?\/|\/theme\/|\/assets\/|\/dist\/|\/skin\/|\/layout\/|graphics|handle_cert|tinnhiemmang|\/common\//i;
const MAX_IMG_PER_ARTICLE = 10;   // tránh 1 bài đổ hàng chục icon/thumbnail vào pool

function extractMedia(html, baseUrl) {
    const abs = u => { try { return new URL(decodeXml(u), baseUrl).href; } catch { return null; } };
    const imgs = new Set(), vids = new Set();
    // og:image / twitter:image (ảnh chính của bài) — luôn lấy
    for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/gi)) { const u = abs(m[1]); if (u && !JUNK_RE.test(u)) imgs.add(u); }
    // Ưu tiên vùng nội dung <article>/<main> để giảm rác; nếu ít thì quét cả trang
    const region = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || [])[0];
    const scanImgs = (chunk) => {
        for (const m of chunk.matchAll(/<img\b[^>]*>/gi)) {
            const tag = m[0];
            let src = tag.match(/\b(?:data-src|data-original|data-lazy-src)=["']([^"']+)["']/i)?.[1] || tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
            const ss = tag.match(/\bsrcset=["']([^"']+)["']/i)?.[1];
            if (ss) { const last = ss.split(',').pop().trim().split(/\s+/)[0]; if (last) src = last; }
            if (src && !/^data:/.test(src)) { const u = abs(src); if (u && !JUNK_RE.test(u)) imgs.add(u); }
        }
    };
    if (region) scanImgs(region);
    if (imgs.size < 2) scanImgs(html);   // fallback quét toàn trang nếu vùng bài quá ít
    // video
    for (const m of html.matchAll(/<meta[^>]+property=["']og:video(?::url|:secure_url)?["'][^>]+content=["']([^"']+)["']/gi)) { const u = abs(m[1]); if (u && /\.(mp4|webm|m3u8)/i.test(u)) vids.add(u); }
    for (const m of html.matchAll(/<(?:video|source)\b[^>]+\bsrc=["']([^"']+\.(?:mp4|webm|m3u8)[^"']*)["']/gi)) { const u = abs(m[1]); if (u && !JUNK_RE.test(u)) vids.add(u); }
    for (const m of html.matchAll(/(?:youtube\.com\/embed\/|youtu\.be\/|youtube-nocookie\.com\/embed\/)([\w-]{11})/gi)) vids.add('https://www.youtube.com/watch?v=' + m[1]);
    return { images: [...imgs].slice(0, MAX_IMG_PER_ARTICLE), videos: [...vids] };
}

// ---------- 4) Điều phối: gom tin + cào media ----------
export async function collectNews({ keywords = [], sources = [], days = 2, maxArticles = 30, perKeyword = 15, hl = 'en-US', gl = 'US' } = {}) {
    // 4.1 Search tất cả từ khóa (tổ hợp với toàn bộ domain qua site: OR)
    // Giãn nhịp giữa các từ khóa để tránh Google News rate-limit (nhiều từ khóa dồn dập -> bị chặn -> 0 bài)
    const all = [];
    for (let i = 0; i < keywords.length; i++) {
        try { all.push(...await searchGoogleNews(keywords[i], sources, { days, max: perKeyword, hl, gl })); }
        catch (e) { console.error(`[news] search "${keywords[i]}" lỗi:`, e.message); }
        if (i < keywords.length - 1) await sleep(1200);
    }
    // 4.2 Dedup theo articleId + tiêu đề, sắp theo mới nhất
    const seenId = new Set(), seenTitle = new Set(), uniq = [];
    for (const a of all.sort((x, y) => y.ts - x.ts)) {
        const tk = a.title.toLowerCase().slice(0, 60);
        if (seenId.has(a.articleId) || seenTitle.has(tk)) continue;
        seenId.add(a.articleId); seenTitle.add(tk); uniq.push(a);
    }
    const picked = uniq.slice(0, maxArticles);
    console.log(`[news] Tổng ${all.length} bài -> ${uniq.length} bài duy nhất -> lấy ${picked.length} bài mới nhất`);

    // 4.3 Giải mã URL báo gốc (song song nhẹ)
    await Promise.all(picked.map(async (a) => { a.url = await decodeGoogleNewsUrl(a.articleId); }));
    const articles = picked.filter(a => a.url);
    console.log(`[news] Giải mã URL gốc: ${articles.length}/${picked.length} bài`);

    // 4.4 FlareSolverr: 1 session, cào tuần tự — tái dùng cookie Cloudflare theo domain nên các bài
    // cùng báo (sau bài đầu) rất nhanh. (Đã thử pool nhiều session nhưng CHẬM hơn do mỗi session phải
    // tự giải Cloudflare lại + nhiều browser tranh tài nguyên container.) Gom theo domain để cookie ấm liên tục.
    articles.sort((a, b) => (a.source || '').localeCompare(b.source || ''));
    const session = await fsCreateSession();
    console.log(`[news] FlareSolverr: cào ${articles.length} bài (1 session, tái dùng cookie theo domain)`);
    for (const a of articles) {
        try {
            const html = await fsGet(a.url, session);
            const md = extractMedia(html, a.url);
            a.images = md.images; a.videos = md.videos;
            console.log(`[news][scrape] ${a.source || ''} "${a.title.slice(0, 45)}" -> ${a.images.length} ảnh, ${a.videos.length} video`);
        } catch (e) {
            a.images = []; a.videos = [];
            console.error(`[news][scrape] lỗi "${a.title.slice(0, 40)}": ${e.message}`);
        }
    }
    await fsDestroySession(session);

    const titles = articles.map(a => ({ title: a.title, source: a.source, pub: a.pub, keyword: a.keyword }));
    const totImg = articles.reduce((s, a) => s + a.images.length, 0), totVid = articles.reduce((s, a) => s + a.videos.length, 0);
    console.log(`[news] HOÀN TẤT: ${articles.length} bài, ${totImg} ảnh, ${totVid} video`);
    return { articles, titles };
}
