// news_pipeline.js
// Luồng: (mảng từ khóa × mảng domain nguồn)
//   - Domain CÓ RSS gốc (news_feeds.js)  -> đọc thẳng feed: có URL bài luôn, khỏi Google News, khỏi decode.
//   - Domain KHÔNG có RSS (hoặc feed 0 bài khớp) -> Google News RSS site: search -> giải mã URL báo gốc.
//   Rồi: tải HTML (HTTP thẳng nếu site không có Cloudflare, không thì FlareSolverr) -> cào HẾT ảnh/video.
// Export: collectNews({ keywords, sources, ... }) -> { articles:[{title, source, pub, url, keyword, images:[], videos:[]}], titles:[] }
import 'dotenv/config';
import https from 'https';
import http from 'http';
import { collectFromFeeds, getFeedSource, needsFlare, fetchPage, matchKeyword, extraVideosFromHtml, ignoresYoutubeEmbed, normArticleUrl, DEFAULT_SOURCES } from './news_feeds.js';
import { logCrawlInfo, logCrawlError, hasLogProject } from '../lib/crawlLogger.js';

// Ghi log tin tức vào CÙNG thư mục dự án với log ảnh stock: logs/<projectId>/crawl_{info,errors}_<ngày>.log
// (chỉ ghi khi process_content đã setLogProject — chạy tay bằng scripts/test_news.mjs thì bỏ qua)
const newsInfo = (o) => { if (hasLogProject()) logCrawlInfo(o); };
const newsErr = (o) => { if (hasLogProject()) logCrawlError(o); };

export { DEFAULT_SOURCES };

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
// filterTitle=true (mặc định): CHỈ giữ bài có từ khóa trong tiêu đề.
// Lý do: khi query có site:, Google News gần như bỏ qua từ khóa và trả về feed chung của trang đó
// (đo thực tế với "高市首相" + site:newsdig.tbs.co.jp: 100 bài trả về, chỉ 2 bài nói về Takaichi —
// còn lại là bóng chày, cháy nhà hàng...). Không lọc thì GPT xào kịch bản từ tin rác và media
// bị cào từ chính mấy bài rác đó.
export async function searchGoogleNews(keyword, sources = [], { days = 2, max = 15, hl = 'en-US', gl = 'US', retries = 3, filterTitle = true } = {}) {
    // Bỏ chú thích trong ngoặc (vd "台湾有事 (Khủng hoảng Đài Loan)" -> "台湾有事") để query không bị nhiễu
    const kw = String(keyword).replace(/[\(（][^)）]*[\)）]/g, ' ').replace(/\s+/g, ' ').trim() || keyword;
    const sitePart = (sources && sources.length) ? ` (${sources.map(d => `site:${d}`).join(' OR ')})` : '';
    const q = `${kw}${sitePart} when:${days}d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;
    let raw = [];
    let fetchErr = null;   // phân biệt "request hỏng" với "Google trả 0 bài" (nguồn không có tin khớp)
    // Google News RSS thỉnh thoảng trả rỗng (rate-limit) -> thử lại vài lần
    for (let attempt = 1; attempt <= retries; attempt++) {
        raw = [];
        try {
            const xml = await httpGet(url);
            for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
                const b = m[1];
                const title = decodeXml((b.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
                const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
                const source = decodeXml((b.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '').trim());
                const link = decodeXml((b.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim());
                const articleId = (link.match(/\/articles\/([^?]+)/) || [])[1];
                // Lấy HẾT item của feed rồi mới lọc + cắt `max` (lọc trước khi cắt, kẻo max toàn bài rác)
                if (title && articleId) raw.push({ title, pub, source, articleId, keyword, ts: Date.parse(pub) || 0 });
            }
        } catch (e) { fetchErr = e.message; console.error(`[news] search "${keyword}" lần ${attempt} lỗi:`, e.message); }
        if (raw.length) break;
        if (attempt < retries) await sleep(1500 * attempt);   // backoff trước khi thử lại
    }
    const kept = filterTitle ? raw.filter(it => matchKeyword(it.title, [keyword])) : raw;
    const items = kept.slice(0, max);
    const dropped = raw.length - kept.length;
    console.log(`[news] "${keyword}"${sitePart ? ' +sources' : ''}: ${items.length} bài`
        + (dropped ? ` (đã loại ${dropped}/${raw.length} bài Google trả kèm không đúng từ khóa)` : ''));
    const srcNote = sources && sources.length ? ` [${sources.join(',')}]` : ' [mọi nguồn]';
    newsInfo({ source: 'GoogleNews', keyword, url,
        note: `${items.length} bài${srcNote}${dropped ? ` (loại ${dropped}/${raw.length} bài lệch từ khóa)` : ''}` });
    // 0 bài mà request KHÔNG hỏng = nguồn đó đơn giản không có tin khớp → không phải lỗi, đừng bơm vào crawl_errors
    if (fetchErr && !raw.length) newsErr({ source: 'GoogleNews', keyword, url, reason: `Google News lỗi: ${fetchErr}` });
    return items;
}

// ---------- 2) Giải mã link Google News -> URL báo gốc (batchexecute) ----------
// Google trả về (chống JSON hijack nên có tiền tố )]}' ):
//   )]}'\n\n[["wrb.fr","Fbv4je","[\"garturlres\",\"https://bao.com/bai?display=1\",1]",...]]
// URL nằm trong 1 chuỗi JSON LỒNG trong chuỗi JSON → phải parse 2 lớp, không bắt bằng regex:
// bản cũ dùng [^"\\]+ nên ĐỨT ngay tại dấu \ của = (dấu '=' bị escape) → mọi bài có query string
// (vd .../withbloomberg/2801643?display=1) đều trả null và bị vứt, mất ~50% số bài đã chọn.
function parseGarturl(resp) {
    const body = String(resp || '').replace(/^\)\]\}'\s*/, '');
    try {
        for (const row of JSON.parse(body)) {
            if (!Array.isArray(row) || row[0] !== 'wrb.fr' || typeof row[2] !== 'string') continue;
            const inner = JSON.parse(row[2]);                  // ["garturlres","https://...",1]
            const url = (Array.isArray(inner) ? inner : []).find(v => typeof v === 'string' && /^https?:\/\//i.test(v));
            if (url && !/^https?:\/\/(news\.)?google\./i.test(url)) return url;
        }
    } catch { /* rơi xuống regex dự phòng */ }
    // Dự phòng: bắt chuỗi rồi tự gỡ escape (\uXXXX, \/) — dùng khi Google đổi khung JSON
    const m = body.match(/(https?:(?:\\\/|\/)(?:\\u[0-9a-f]{4}|\\.|[^"\\])+)/i);
    if (!m) return null;
    const url = m[1].replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');
    return /^https?:\/\/(news\.)?google\./i.test(url) ? null : decodeXml(url);
}

export async function decodeGoogleNewsUrl(articleId) {
    try {
        const page = await httpGet(`https://news.google.com/rss/articles/${articleId}`);
        const sig = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
        const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
        if (!sig || !ts) return null;
        const inner = JSON.stringify(["garturlreq", [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], articleId, Number(ts), sig]);
        const freq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
        const resp = await httpPost('https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je&source-path=%2Frss%2Farticles&hl=en-US&gl=US', 'f.req=' + encodeURIComponent(freq));
        return parseGarturl(resp);
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
export async function collectNews({ keywords = [], sources = [], days = 2, maxArticles = 30, perKeyword = 15, hl = 'en-US', gl = 'US', seenIds = null, seenTitles = null, seenUrls = null } = {}) {
    // 4 nguồn mặc định (NTV, Yahoo, Japan Times, TBS) LUÔN được crawl; nguồn người dùng nhập là BỔ SUNG.
    // Trước đây nhập nguồn là đè mất mặc định → dòng sheet liệt kê nikkei/asahi/... không bao giờ chạm tới
    // TBS (báo duy nhất nhúng video) lẫn RSS gốc của NTV/Yahoo.
    const norm = (d) => String(d).trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
    const extra = sources.map(norm).filter(Boolean);
    sources = [...new Set([...DEFAULT_SOURCES, ...extra])];
    if (extra.length) console.log(`[news] Nguồn: ${DEFAULT_SOURCES.length} mặc định + ${sources.length - DEFAULT_SOURCES.length} bổ sung = ${sources.length}`);

    // 1 session FlareSolverr dùng chung cho cả feed (Japan Times sau Cloudflare) lẫn cào bài
    const session = await fsCreateSession();
    const all = [];
    try {
        // 4.1a Domain CÓ RSS gốc -> đọc thẳng feed (không rate-limit, URL bài có sẵn)
        const feedDomains = sources.filter(d => getFeedSource(d));
        let gnewsDomains = sources.filter(d => !getFeedSource(d));
        if (feedDomains.length) {
            const { items, emptyDomains } = await collectFromFeeds({
                keywords, domains: feedDomains, days, perDomain: perKeyword, fsGet, session,
            });
            all.push(...items);
            // Feed không có bài nào khớp (vd từ khóa tiếng Nhật vs feed tiếng Anh) -> vẫn thử Google News cho domain đó
            gnewsDomains = gnewsDomains.concat(emptyDomains);
        }

        // 4.1b Domain KHÔNG có RSS -> Google News site: search (giãn nhịp tránh rate-limit).
        // Nguồn MẶC ĐỊNH (vd TBS) đi truy vấn RIÊNG, không dồn chung với nguồn bổ sung: gộp hết vào 1 query
        // `site:A OR site:B OR ...` thì Google chỉ trả `max` bài và MỘT báo có thể chiếm sạch slot
        // (đo thực tế: nippon.com lấy trọn 15/15, TBS — báo duy nhất có video — không lọt bài nào).
        if (gnewsDomains.length) {
            const priority = gnewsDomains.filter(d => DEFAULT_SOURCES.includes(d));   // mỗi nguồn 1 query riêng
            const extras = gnewsDomains.filter(d => !DEFAULT_SOURCES.includes(d));    // nguồn bổ sung: gộp 1 query
            const queries = [...priority.map(d => [d]), ...(extras.length ? [extras] : [])];
            for (let i = 0; i < keywords.length; i++) {
                for (let j = 0; j < queries.length; j++) {
                    try { all.push(...await searchGoogleNews(keywords[i], queries[j], { days, max: perKeyword, hl, gl })); }
                    catch (e) { console.error(`[news] search "${keywords[i]}" lỗi:`, e.message); }
                    if (i < keywords.length - 1 || j < queries.length - 1) await sleep(1200);
                }
            }
        }
        return await buildArticles({ all, maxArticles, seenIds, seenTitles, seenUrls, session });
    } finally {
        await fsDestroySession(session);
    }
}

async function buildArticles({ all, maxArticles, seenIds, seenTitles, seenUrls, session }) {
    // 4.2 Dedup theo articleId + tiêu đề, sắp theo mới nhất
    const seenId = new Set(), seenTitle = new Set(), uniq = [];
    for (const a of all.sort((x, y) => y.ts - x.ts)) {
        const tk = a.title.toLowerCase().slice(0, 60);
        if (seenId.has(a.articleId) || seenTitle.has(tk)) continue;   // trùng trong CÙNG lần chạy
        if (seenIds && seenIds.has(a.articleId)) continue;            // đã xử lý ở LẦN CHẠY TRƯỚC (dedup bền)
        if (seenTitles && seenTitles.has(tk)) continue;
        seenId.add(a.articleId); seenTitle.add(tk); uniq.push(a);
    }
    // Chọn XEN KẼ theo nguồn: mỗi vòng lấy bài mới nhất của từng báo. Nếu cứ cắt thuần theo độ mới thì
    // báo nào đăng dày sẽ nuốt hết slot (nippon.com từng chiếm 15/15) → mất luôn báo có video như TBS.
    const bySource = new Map();
    for (const a of uniq) {                       // uniq đã sắp mới nhất trước → mỗi nhóm cũng vậy
        const k = a.source || '?';
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k).push(a);
    }
    const picked = [];
    for (let more = true; more && picked.length < maxArticles;) {
        more = false;
        for (const list of bySource.values()) {
            if (!list.length) continue;
            picked.push(list.shift());
            more = true;
            if (picked.length >= maxArticles) break;
        }
    }
    const seenNote = (seenIds || seenTitles) ? ' (đã loại tin xử lý ở lần trước)' : '';
    console.log(`[news] Tổng ${all.length} bài -> ${uniq.length} bài mới${seenNote} -> lấy ${picked.length} bài`
        + ` từ ${bySource.size} nguồn (xen kẽ)`);

    // 4.3 Giải mã URL báo gốc — CHỈ cho bài từ Google News; bài từ RSS gốc đã có URL thật rồi
    const needDecode = picked.filter(a => !a.url);
    await Promise.all(needDecode.map(async (a) => { a.url = await decodeGoogleNewsUrl(a.articleId); }));
    for (const a of needDecode) {
        if (!a.url) newsErr({ source: a.source || 'GoogleNews', keyword: a.keyword, url: `articleId=${a.articleId}`, reason: 'không giải mã được URL báo gốc' });
    }
    // Dedup theo URL BÀI — chỉ làm được sau khi giải mã, vì bài từ Google News chưa có URL lúc lọc theo id.
    // Cùng 1 bài hay đội lốt nhiều URL (TBS: /-/, /withbloomberg/, /gallery/) nên so bằng normArticleUrl.
    let articles = picked.filter(a => a.url);
    if (seenUrls && seenUrls.size) {
        const before = articles.length;
        articles = articles.filter(a => !seenUrls.has(normArticleUrl(a.url)));
        const dropped = before - articles.length;
        if (dropped) console.log(`[news] Loại ${dropped} bài dự án TRƯỚC đã dùng (dedup theo URL bài)`);
    }
    console.log(`[news] URL bài: ${articles.length}/${picked.length} (${picked.length - needDecode.length} sẵn từ RSS, ${needDecode.length} giải mã Google News)`);

    // 4.4 Cào HTML: site không Cloudflare (NTV/Yahoo) -> HTTP thẳng, nhanh hơn nhiều;
    // site có Cloudflare / domain lạ -> FlareSolverr, 1 session dùng chung để tái dùng cookie theo domain
    // (đã thử pool nhiều session nhưng CHẬM hơn: mỗi session phải tự giải Cloudflare lại).
    // Gom theo domain để cookie ấm liên tục.
    articles.sort((a, b) => (a.source || '').localeCompare(b.source || ''));
    const nFlare = articles.filter(a => needsFlare(a.url)).length;
    console.log(`[news] Cào ${articles.length} bài (${articles.length - nFlare} HTTP thẳng, ${nFlare} qua FlareSolverr)`);
    for (const a of articles) {
        try {
            const html = await fetchPage(a.url, { cf: needsFlare(a.url), fsGet, session });
            const md = extractMedia(html, a.url);
            a.images = md.images;
            // TBS nhúng luồng LIVE 24/7 của kênh vào MỌI bài → bỏ, kẻo yt-dlp tải live vô tận
            a.videos = ignoresYoutubeEmbed(a.url) ? md.videos.filter(v => !/youtube\.com|youtu\.be/i.test(v)) : md.videos;
            // Video của player riêng (TBS: Streaks API) — không lộ URL trong HTML nên phải gọi API
            const extra = await extraVideosFromHtml(a.url, html);
            for (const v of extra) if (!a.videos.includes(v)) a.videos.push(v);
            console.log(`[news][scrape] ${a.source || ''} "${a.title.slice(0, 45)}" -> ${a.images.length} ảnh, ${a.videos.length} video`);
            newsInfo({ source: `Tin/${a.source || '?'}`, keyword: a.keyword, url: a.url,
                note: `"${a.title.slice(0, 60)}" -> ${a.images.length} ảnh, ${a.videos.length} video` });
            for (const v of a.videos) newsInfo({ source: `Tin/${a.source || '?'}`, keyword: a.keyword, url: v, note: 'video của bài' });
        } catch (e) {
            a.images = []; a.videos = [];
            console.error(`[news][scrape] lỗi "${a.title.slice(0, 40)}": ${e.message}`);
            newsErr({ source: `Tin/${a.source || '?'}`, keyword: a.keyword, url: a.url, reason: `cào bài lỗi: ${e.message}` });
        }
    }

    const titles = articles.map(a => ({ title: a.title, source: a.source, pub: a.pub, keyword: a.keyword }));
    const totImg = articles.reduce((s, a) => s + a.images.length, 0), totVid = articles.reduce((s, a) => s + a.videos.length, 0);
    console.log(`[news] HOÀN TẤT: ${articles.length} bài, ${totImg} ảnh, ${totVid} video`);
    newsInfo({ source: 'Tin/tổng kết', note: `${articles.length} bài, ${totImg} ảnh, ${totVid} video` });
    return { articles, titles };
}
