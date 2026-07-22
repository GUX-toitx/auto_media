// x_source.js
// Nguồn tin cho pipeline ĐỊA CHÍNH TRỊ từ danh sách account X (trang cá nhân chính trị).
// Luồng: account list -> x_scrape.py --users (twscrape) -> lọc cửa sổ ngày
//        -> GPT chấm MỌI tweet có media xem có đúng chủ đề/từ khóa không -> giữ tweet đạt
//        -> trả article ĐÚNG HÌNH DẠNG geo ({title, source, url, keyword, images[], videos[]})
//        để process_content trộn vào pool chung: media gán vào cảnh + text làm tư liệu cho GPT-5.
// Media để dạng URL (pbs.twimg.com / video.twimg.com) — crawlMediaForPost tự tải như ảnh báo.
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, execFileSync } from 'child_process';
import https from 'https';
import { normArticleUrl } from '../news/news_feeds.js';
import { collectAccounts } from './x_crawler.js';
import { aiChat } from '../lib/ai.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VENV_PY = path.join(ROOT, '.venv', 'bin', 'python');
const OPENAI_KEY = process.env.OPENAI_KEY;
// Gọi twscrape lấy tweet mới nhất của từng account.
// Dùng CHUNG pool đa profile với x_crawler (X_PROFILES) → nhiều account = throttle nhân lên.
// Cookie đưa qua STDIN nên không lộ trong `ps`. Không có profile nào đọc được thì vẫn chạy
// bằng account đã lưu sẵn trong accounts.db (twscrape giữ phiên bền).
function scrapeUsers(users, limit) {
    const accounts = collectAccounts();
    const args = [path.join(HERE, 'x_scrape.py'),
        '--users', users.join(','),
        '--limit', String(limit),
        '--db', path.join(ROOT, 'accounts.db')];
    if (accounts.length) args.push('--accounts-stdin');
    else args.push('--cookies', 'x_session');   // fallback: dùng account đã lưu trong pool
    const r = spawnSync(VENV_PY, args, {
        encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, timeout: 180000,
        ...(accounts.length ? { input: JSON.stringify(accounts) } : {}),
    });
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error && r.error.code === 'ETIMEDOUT') { console.warn('[x-source] scrape quá 180s (rate-limit?) → bỏ qua'); return []; }
    try { return JSON.parse(r.stdout || '[]'); } catch { return []; }
}

// ---------- GPT chấm độ liên quan (gộp lô cho rẻ) ----------
function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = JSON.stringify(body);
        const req = https.request(
            { hostname: u.hostname, path: u.pathname, method: 'POST', family: 4, headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
            (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, body: raw })); }
        );
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data); req.end();
    });
}

// Trả về Set index tweet ĐÚNG chủ đề. Chấm theo lô 20 tweet/lần.
async function gptRelevant(tweets, keywords, topic) {
    const keep = new Set();
    if (!OPENAI_KEY || !tweets.length) return keep;
    const kwLine = keywords.filter(Boolean).join(', ');
    const BATCH = 20;
    for (let start = 0; start < tweets.length; start += BATCH) {
        const chunk = tweets.slice(start, start + BATCH);
        const listed = chunk.map((t, i) => `[${i}] @${t.user}: ${String(t.text || '').replace(/\s+/g, ' ').slice(0, 280)}`).join('\n');
        const sys = 'Bạn lọc tweet theo chủ đề. Người dùng cho CHỦ ĐỀ + TỪ KHÓA và danh sách tweet đánh số. '
            + 'Trả JSON {"relevant":[<các số của tweet THỰC SỰ nói về chủ đề/từ khóa>]}. '
            + 'Chỉ giữ tweet đúng nội dung (bỏ quảng cáo, tin vặt, tweet lạc đề). CHỈ trả JSON.';
        const user = `CHỦ ĐỀ: ${topic || kwLine}\nTỪ KHÓA: ${kwLine}\n\nTWEET:\n${listed}`;
        try {
            const { content } = await aiChat({
                tier: 'mini', temperature: 0, json: true,
                messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
            });
            const idxs = JSON.parse(content).relevant || [];
            for (const i of idxs) if (Number.isInteger(i) && i >= 0 && i < chunk.length) keep.add(start + i);
        } catch (e) { console.error('[x-source] GPT lọc lỗi:', e.message); }
    }
    return keep;
}

// Ảnh X (pbs.twimg.com): ép name=orig để lấy ĐỘ PHÂN GIẢI GỐC (cao nhất) thay vì bản mặc định.
function bestPhoto(url) {
    if (!/pbs\.twimg\.com/i.test(url || '')) return url;
    try {
        const [base, qs = ''] = String(url).split('?');
        const params = new URLSearchParams(qs);
        params.set('name', 'orig');
        if (!params.has('format') && /\.(jpg|jpeg|png|webp)$/i.test(base)) params.set('format', base.split('.').pop().toLowerCase());
        return base.replace(/\.(jpg|jpeg|png|webp)$/i, '') + '?' + params.toString();
    } catch { return url; }
}

// ---------- Điều phối ----------
// Trả { articles: [{title, source, pub, url, keyword, articleId, images[], videos[]}], count }
export async function collectFromXAccounts({ accounts = [], keywords = [], topic = '', limit = 20, days = 1, seenUrls = null } = {}) {
    const users = accounts.map(a => String(a).trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?]/)[0]).filter(Boolean);
    if (!users.length) return { articles: [], count: 0 };

    const raw = scrapeUsers(users, limit);
    console.log(`[x-source] ${users.length} account → ${raw.length} tweet`);

    // 1) Cửa sổ ngày + chỉ tweet CÓ media (không media thì không có gì để cào) + chưa dùng ở dự án trước
    const cutoff = Date.now() - days * 86400_000;
    const cand = [];
    for (const t of raw) {
        const media = t.media || [];
        if (!media.length) continue;
        const ts = Date.parse(t.date) || 0;
        if (ts && ts < cutoff) continue;
        if (seenUrls && seenUrls.has(normArticleUrl(t.url))) continue;
        cand.push(t);
    }
    console.log(`[x-source] ${cand.length} tweet có media trong ${days} ngày (chưa dùng)`);
    if (!cand.length) return { articles: [], count: 0 };

    // 2) GPT chấm mọi tweet ứng viên
    const keep = await gptRelevant(cand, keywords, topic);
    console.log(`[x-source] GPT giữ ${keep.size}/${cand.length} tweet đúng chủ đề`);

    // 3) Đóng gói thành article geo (media để dạng URL, crawlMediaForPost tự tải)
    const articles = [];
    for (let i = 0; i < cand.length; i++) {
        if (!keep.has(i)) continue;
        const t = cand[i];
        const images = (t.media || []).filter(m => m.type === 'photo').map(m => bestPhoto(m.url));
        const videos = (t.media || []).filter(m => m.type === 'video').map(m => m.url);
        if (!images.length && !videos.length) continue;
        articles.push({
            title: (t.text || '').replace(/\s*https?:\/\/\S+/g, '').trim().slice(0, 200) || `@${t.user}`,
            source: `X/@${t.user}`, pub: t.date || '', ts: Date.parse(t.date) || 0,
            keyword: keywords[0] || topic || '', url: t.url, articleId: 'x:' + t.url,
            images, videos,
        });
    }
    console.log(`[x-source] HOÀN TẤT: ${articles.length} tweet → ${articles.reduce((s, a) => s + a.images.length, 0)} ảnh, ${articles.reduce((s, a) => s + a.videos.length, 0)} video`);
    return { articles, count: articles.length };
}

