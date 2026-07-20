// news_feeds.js
// Nguồn báo có RSS GỐC → đi thẳng feed, KHÔNG qua Google News.
// Lợi so với Google News search:
//   - Không bị rate-limit / trả rỗng như news.google.com/rss/search
//   - URL bài đã là URL gốc → BỎ hẳn bước decode batchexecute (chậm nhất & hay hỏng)
//   - Lấy được cả tin không lọt vào index Google News, thời gian thực hơn
// Domain KHÔNG có RSS (vd newsdig.tbs.co.jp) → news_pipeline tự fallback về Google News site: search.
import https from 'https';
import http from 'http';
import { logCrawlInfo, logCrawlError, hasLogProject } from '../lib/crawlLogger.js';

const feedInfo = (o) => { if (hasLogProject()) logCrawlInfo(o); };   // chỉ ghi khi chạy trong 1 dự án
const feedErr = (o) => { if (hasLogProject()) logCrawlError(o); };

// ---------- Registry: domain -> feed RSS gốc ----------
// cf:true  = site sau Cloudflare → tải feed/bài bằng FlareSolverr
// resolve  = feed trả link trung gian, cần lần ra URL bài thật (Yahoo: /pickup/ -> /articles/)
export const FEED_SOURCES = {
    'news.ntv.co.jp': {
        name: '日テレNEWS NNN',
        // Chỉ có feed TỔNG (đã thử /rss/politics.rdf, /rss/category/*.rdf → 403, không tồn tại).
        // Feed ~500 item đủ mọi chuyên mục (society/international/politics/economy...) → lọc bằng từ khóa.
        feeds: ['https://news.ntv.co.jp/rss/index.rdf'],
        cf: false,
    },
    'news.yahoo.co.jp': {
        name: 'Yahoo!ニュース',
        // Feed theo chuyên mục — chỉ lấy các mục liên quan địa chính trị/thời sự.
        feeds: [
            'https://news.yahoo.co.jp/rss/topics/top-picks.xml',
            'https://news.yahoo.co.jp/rss/topics/world.xml',
            'https://news.yahoo.co.jp/rss/topics/domestic.xml',
            'https://news.yahoo.co.jp/rss/topics/business.xml',
        ],
        cf: false,
        resolve: resolveYahooPickup,
    },
    'japantimes.co.jp': {
        name: 'The Japan Times',
        // Feed theo tag (vd /tag/china/feed/) KHÔNG tồn tại — trả về HTML trang tag.
        // Chỉ có feed tổng 30 bài mới nhất → lọc bằng từ khóa.
        feeds: ['https://www.japantimes.co.jp/feed/'],
        cf: true,
    },
    'newsdig.tbs.co.jp': {
        name: 'TBS NEWS DIG',
        // KHÔNG có RSS (đã thử /rss, /feed, /rss.xml, /index.rdf, /atom.xml → 404, trang chủ cũng
        // không có <link rel="alternate">). Bỏ trống feeds → news_pipeline dùng Google News site: search.
        feeds: [],
        cf: false,
    },
};

// 4 nguồn mặc định khi người dùng không nhập domain nào
export const DEFAULT_SOURCES = Object.keys(FEED_SOURCES);

const domainKey = (d) => {
    const host = String(d || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    return Object.keys(FEED_SOURCES).find(k => host === k || host.endsWith('.' + k) || k.endsWith('.' + host)) || null;
};
export const getFeedSource = (domain) => {
    const k = domainKey(domain);
    const cfg = k ? FEED_SOURCES[k] : null;
    return cfg && cfg.feeds.length ? { key: k, ...cfg } : null;
};
// Bài của domain này có cần FlareSolverr không (domain lạ → cứ cho là có Cloudflare)
export const needsFlare = (url) => {
    const k = domainKey((url || '').replace(/^https?:\/\//, '').split('/')[0]);
    return k ? !!FEED_SOURCES[k].cf : true;
};

// ---------- HTTP ----------
function httpGet(url, depth = 0) {
    return new Promise((resolve, reject) => {
        const req = (url.startsWith('http://') ? http : https).get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
                'Accept': 'application/rss+xml,application/xml,text/html;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ja,en;q=0.8',
            },
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
                res.resume();
                return httpGet(new URL(res.headers.location, url).href, depth + 1).then(resolve, reject);
            }
            if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}
const isChallenge = (body) => /Just a moment|cf-browser-verification|challenge-platform/i.test(body.slice(0, 2000));

// Tải 1 URL: ưu tiên HTTP thẳng (nhanh); dính Cloudflare hoặc site đã đánh dấu cf → FlareSolverr.
export async function fetchPage(url, { cf = false, fsGet = null, session = null } = {}) {
    if (!cf) {
        try {
            const body = await httpGet(url);
            if (body && !isChallenge(body)) return body;
        } catch { /* rơi xuống FlareSolverr */ }
    }
    if (!fsGet) throw new Error('cần FlareSolverr nhưng không có fsGet');
    return fsGet(url, session);
}

// ---------- Parse RSS 2.0 / RSS 1.0 (RDF) / Atom ----------
const decodeXml = (s) => (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decodeXml(m[1]).replace(/<[^>]+>/g, ' ').trim() : '';
};

export function parseFeed(xml) {
    const out = [];
    // FlareSolverr trả HTML do Chrome render (XML viewer) — XML gốc nằm trong div#webkit-xml-viewer-source-xml
    const wrapped = xml.match(/<div id="webkit-xml-viewer-source-xml">([\s\S]*?)<\/div>/i);
    if (wrapped) xml = wrapped[1];
    // <item> (RSS 2.0 & RDF — RDF là <item rdf:about="...">) và <entry> (Atom)
    for (const m of xml.matchAll(/<(item|entry)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
        const attrs = m[2], b = m[3];
        const title = tag(b, 'title');
        // link: <link>url</link> (RSS/RDF) | <link href="..."/> (Atom) | rdf:about (RDF fallback)
        let link = tag(b, 'link')
            || decodeXml(b.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i)?.[1] || '')
            || decodeXml(attrs.match(/rdf:about=["']([^"']+)["']/i)?.[1] || '');
        const pub = tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'updated') || tag(b, 'published') || '';
        const desc = tag(b, 'description') || tag(b, 'summary') || '';
        if (title && link) out.push({ title, url: link.trim(), pub, desc, ts: Date.parse(pub) || 0 });
    }
    return out;
}

// ---------- Khớp từ khóa ----------
// CJK không có dấu cách → so khớp substring. Latin/Việt → mọi token (>=3 ký tự) phải có mặt.
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿]/;
// Hậu tố chức danh: báo Nhật hay viết 高市総理 / 高市早苗 chứ không phải lúc nào cũng đúng cụm 高市首相
// → khớp theo LÕI của từ khóa (高市首相 → 高市). Chỉ cắt khi lõi còn >= 2 ký tự.
const TITLE_SUFFIX_RE = /(首相|総理大臣|総理|大臣|政権|政府|大統領|外相|防衛相|氏)$/u;
const cjkCore = (p) => { const core = p.replace(TITLE_SUFFIX_RE, ''); return core.length >= 2 ? core : p; };
export function matchKeyword(text, keywords) {
    const t = String(text || '').toLowerCase();
    const tFlat = t.replace(/\s+/g, '');
    for (const kw of keywords) {
        // bỏ chú thích trong ngoặc: "台湾有事 (Khủng hoảng Đài Loan)" -> "台湾有事"
        const clean = String(kw).replace(/[（(][^)）]*[)）]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!clean) continue;
        if (CJK_RE.test(clean)) {
            // >=2 ký tự: 1 ký tự (vd 米) khớp bừa quá nhiều (新米, 酒米...) -> bỏ
            const parts = clean.split(/[\s、,，・]+/).filter(p => p.length >= 2);
            if (parts.length && parts.every(p => tFlat.includes(cjkCore(p.replace(/\s+/g, ''))))) return kw;
        } else {
            const toks = clean.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
            if (toks.length && toks.every(w => t.includes(w))) return kw;
        }
    }
    return null;
}

// ---------- Video RIÊNG của từng báo (player tự dựng, không lộ URL trong HTML) ----------
// TBS NEWS DIG: bài có <video data-mw-play-id="<media_id>"> + SDK Streaks. URL thật lấy qua Playback API:
//   GET https://playback.api.streaks.jp/v1/projects/tbsnews-prod/medias/<media_id>  (header X-Streaks-Api-Key)
//   -> sources[].src = HLS .m3u8 (yt-dlp tải được).
// (project + apiKey nằm công khai trong shared.prod.js của TBS — không phải khoá bí mật.)
const TBS_STREAKS = { host: 'playback.api.streaks.jp', project: 'tbsnews-prod', apiKey: '7d7cc1dc87b84e1b8f7b00487ae33ded' };
async function tbsVideos(html) {
    const ids = [...new Set([...html.matchAll(/data-mw-play-id=["']([a-f0-9]{16,})["']/gi)].map(m => m[1]))];
    const out = [];
    for (const id of ids) {
        try {
            const r = await fetch(`https://${TBS_STREAKS.host}/v1/projects/${TBS_STREAKS.project}/medias/${id}`,
                { headers: { 'X-Streaks-Api-Key': TBS_STREAKS.apiKey, 'Accept': 'application/json' } });
            if (!r.ok) continue;
            const j = await r.json();
            for (const s of (j.sources || [])) if (s.src) out.push(s.src);
        } catch (e) { console.error(`[news][video] TBS streaks ${id} lỗi: ${e.message}`); }
    }
    return out;
}

// Bài của báo này có nhúng YouTube "rác" không (TBS nhúng luồng LIVE 24/7 của kênh vào MỌI bài —
// không phải video của bài, mà yt-dlp tải live thì chạy vô tận) → bỏ qua YouTube, dùng player riêng.
export const ignoresYoutubeEmbed = (url) => /newsdig\.tbs\.co\.jp/i.test(url || '');

// Video lấy thêm từ player riêng của báo (ngoài những gì extractMedia bắt được trong HTML)
export async function extraVideosFromHtml(url, html) {
    if (/newsdig\.tbs\.co\.jp/i.test(url || '')) return tbsVideos(html);
    return [];
}

// ---------- Khoá nhận dạng 1 BÀI BÁO (để dedup xuyên dự án) ----------
// Cùng một bài có thể xuất hiện dưới nhiều URL khác nhau, nhất là TBS:
//   /articles/-/2800622  |  /articles/withbloomberg/2800622?display=1  |  /articles/gallery/2800000
// → bỏ query, bỏ khúc phân loại giữa, chỉ giữ host + mã bài. Không có mã số thì dùng nguyên path.
export function normArticleUrl(u) {
    try {
        const s = String(u);
        // Tweet X/Twitter: x.com/<user>/status/<id> → khoá theo id (bỏ user/host khác nhau)
        const xm = s.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
        if (xm) return 'x.com/status/' + xm[1];
        const x = new URL(s);
        let p = x.pathname.replace(/\/+$/, '');
        const m = p.match(/\/articles\/(?:[^/]+\/)?(\d+)$/);   // TBS & tương tự: mã bài là số ở cuối
        if (m) p = '/articles/' + m[1];
        return (x.hostname + p).toLowerCase();
    } catch { return String(u || '').toLowerCase(); }
}

// ---------- Yahoo: /pickup/<id> là trang tóm tắt → lần ra bài đầy đủ /articles/<id> ----------
async function resolveYahooPickup(url) {
    if (!/\/pickup\//.test(url)) return url;
    try {
        const html = await httpGet(url);
        const m = html.match(/https:\/\/news\.yahoo\.co\.jp\/articles\/[a-z0-9]+/i);
        return m ? m[0] : url;
    } catch { return url; }
}

// ---------- Thu tin từ RSS gốc của các domain ----------
// Trả { items, emptyDomains } — emptyDomains = domain có feed nhưng 0 bài khớp
// → news_pipeline fallback sang Google News site: search cho các domain đó (khỏi mất recall).
export async function collectFromFeeds({ keywords = [], domains = [], days = 2, perDomain = 15, fsGet = null, session = null } = {}) {
    const items = [], emptyDomains = [];
    const cutoff = Date.now() - days * 86400_000;
    for (const domain of domains) {
        const src = getFeedSource(domain);
        if (!src) continue;
        const seen = new Set();
        let raw = 0, kept = 0;
        for (const feed of src.feeds) {
            try {
                // Feed luôn thử HTTP thẳng trước (kể cả site có Cloudflare — URL /feed/ thường không bị chặn);
                // dính challenge mới nhờ FlareSolverr (parseFeed tự gỡ lớp HTML viewer của Chrome).
                const xml = await fetchPage(feed, { cf: false, fsGet, session });
                const parsed = parseFeed(xml);
                raw += parsed.length;
                for (const it of parsed) {
                    if (kept >= perDomain) break;
                    if (it.ts && it.ts < cutoff) continue;                  // ngoài cửa sổ N ngày
                    const kw = matchKeyword(it.title + ' ' + it.desc, keywords);
                    if (!kw) continue;
                    if (seen.has(it.url)) continue;
                    seen.add(it.url); kept++;
                    items.push({
                        title: it.title, pub: it.pub, ts: it.ts, keyword: kw,
                        source: src.name, url: it.url,
                        articleId: 'rss:' + it.url,                          // id bền cho dedup xuyên lần chạy
                        _resolve: src.resolve || null, _cf: src.cf,
                    });
                }
            } catch (e) {
                console.error(`[news][rss] ${feed} lỗi: ${e.message}`);
                feedErr({ source: `RSS/${src.name}`, url: feed, reason: `đọc feed lỗi: ${e.message}` });
            }
        }
        console.log(`[news][rss] ${src.name} (${src.key}): ${raw} item feed → ${kept} bài khớp từ khóa (${days}d)`);
        feedInfo({ source: `RSS/${src.name}`, keyword: keywords.join(' | ').slice(0, 60), url: src.feeds[0],
            note: `${raw} item trong feed → ${kept} bài khớp từ khóa (${days} ngày)` });
        if (!kept) emptyDomains.push(domain);
    }
    // Lần ra URL bài thật (Yahoo pickup → articles), song song
    await Promise.all(items.map(async (a) => {
        if (a._resolve) { try { a.url = await a._resolve(a.url); a.articleId = 'rss:' + a.url; } catch { } }
        delete a._resolve;
    }));
    return { items, emptyDomains };
}
