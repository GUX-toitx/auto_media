// Test nhanh: 1 từ khóa lấy được bao nhiêu bài báo, từ nguồn nào.
//
// Chạy (từ THƯ MỤC GỐC repo):
//   node scripts/test_news.mjs "高市首相"
//   node scripts/test_news.mjs "高市首相" --days 7
//   node scripts/test_news.mjs "高市首相" --sources news.yahoo.co.jp,japantimes.co.jp
//   node scripts/test_news.mjs "高市首相" --show 30   # in kèm link 30 bài (mặc định 10)
//   node scripts/test_news.mjs "高市首相" --media      # cào luôn ảnh/video trong bài (chậm, cần FlareSolverr)
//
// Mặc định: 4 nguồn trong news_feeds.js, cửa sổ 3 ngày, KHÔNG cào media (chỉ đếm bài).
import 'dotenv/config';
import { collectFromFeeds, getFeedSource, matchKeyword, FEED_SOURCES, DEFAULT_SOURCES } from '../src/news/news_feeds.js';
import { searchGoogleNews, decodeGoogleNewsUrl, collectNews } from '../src/news/news_pipeline.js';

const argv = process.argv.slice(2);
const getArg = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || d) : d; };
const keyword = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--days' && argv[argv.indexOf(a) - 1] !== '--sources');
const days = parseInt(getArg('--days', '1'), 10) || 1;   // mặc định 1 ngày, khớp pipeline thật
const withMedia = argv.includes('--media');
const showN = parseInt(getArg('--show', '10'), 10) || 10;   // số bài in kèm link (Google News phải giải mã URL nên mặc định 10)
const sources = (getArg('--sources') || '').split(',').map(s => s.trim()).filter(Boolean);
const domains = sources.length ? sources : [...DEFAULT_SOURCES];

if (!keyword) {
    console.error('Thiếu từ khóa. Ví dụ: node scripts/test_news.mjs "高市首相"');
    process.exit(1);
}

// FlareSolverr chỉ cần khi feed/bài dính Cloudflare (Japan Times)
const FS_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';
async function fsGet(url) {
    const r = await fetch(FS_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
    });
    const j = await r.json();
    if (j.status !== 'ok' || !j.solution) throw new Error(j.message || 'flaresolverr fail');
    return j.solution.response || '';
}

const line = (s = '') => console.log(s);
// Dùng ĐÚNG bộ khớp mà pipeline dùng (news_feeds.matchKeyword) → test phản ánh crawl thật
const relevant = (title) => !!matchKeyword(title, [keyword]);
line(`\n╭─ TEST TIN: "${keyword}"`);
line(`│  Cửa sổ: ${days} ngày | Nguồn: ${domains.join(', ')}`);
line(`╰─ Cào media: ${withMedia ? 'CÓ (FlareSolverr)' : 'không (chỉ đếm bài)'}\n`);

if (withMedia) {
    // Chạy đúng pipeline thật (RSS gốc + Google News + cào ảnh/video trong bài)
    const t0 = Date.now();
    const { articles } = await collectNews({ keywords: [keyword], sources: domains, days, maxArticles: 50, perKeyword: 20, hl: 'ja', gl: 'JP' });
    line(`\n═══ KẾT QUẢ: ${articles.length} bài (${((Date.now() - t0) / 1000).toFixed(0)}s) ═══`);
    const bySource = {};
    for (const a of articles) bySource[a.source || '?'] = (bySource[a.source || '?'] || 0) + 1;
    for (const [s, n] of Object.entries(bySource).sort((x, y) => y[1] - x[1])) line(`  ${String(n).padStart(3)} bài  ${s}`);
    line('');
    articles.forEach((a, i) => line(`${String(i + 1).padStart(2)}. [${a.source}] ${a.title.slice(0, 60)}\n    ${a.images.length} ảnh, ${a.videos.length} video | ${a.url}`));
    const ti = articles.reduce((s, a) => s + a.images.length, 0), tv = articles.reduce((s, a) => s + a.videos.length, 0);
    line(`\nTỔNG: ${articles.length} bài, ${ti} ảnh, ${tv} video`);
    process.exit(0);
}

// ===== Chỉ đếm bài (nhanh) =====
// 1) Nguồn có RSS gốc → đọc thẳng feed
const feedDomains = domains.filter(d => getFeedSource(d));
const noFeedDomains = domains.filter(d => !getFeedSource(d));
line('─── 1) RSS GỐC ───');
const { items, emptyDomains } = await collectFromFeeds({
    keywords: [keyword], domains: feedDomains, days, perDomain: 30, fsGet,
});
for (const it of items) line(`   • [${it.source}] ${it.title.slice(0, 55)}\n     ${it.url}`);
if (!items.length) line('   (không bài nào khớp từ khóa trong feed)');

// 2) Nguồn không có RSS (+ nguồn feed ra 0 bài) → Google News site: search
// Google News chỉ cho link redirect → giải mã sang URL báo gốc (đúng bước pipeline làm) rồi in ra.
const gnews = [...noFeedDomains, ...emptyDomains];
line(`\n─── 2) GOOGLE NEWS (site:) cho: ${gnews.join(', ') || '—'} ───`);
let gItems = [];
if (gnews.length) {
    gItems = await searchGoogleNews(keyword, gnews, { days, max: 100, hl: 'ja', gl: 'JP' });
    const show = gItems.slice(0, showN);
    // Chỉ hiện dòng chờ khi chạy trên terminal (pipe ra file thì \r không xoá được, dính vào kết quả)
    if (process.stdout.isTTY) process.stdout.write(`   (đang giải mã ${show.length} URL báo gốc...)`);
    await Promise.all(show.map(async (it) => { it.url = await decodeGoogleNewsUrl(it.articleId); }));
    if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(42) + '\r');
    for (const it of show) {
        line(`   ${relevant(it.title) ? '✔' : '✘'} [${it.source}] ${it.title.slice(0, 55)}`);
        line(`     ${it.url || '✘ không giải mã được URL — https://news.google.com/rss/articles/' + it.articleId.slice(0, 25) + '...'}`);
    }
    if (gItems.length > show.length) line(`   ... và ${gItems.length - show.length} bài nữa (xem hết: --show ${gItems.length})`);
    const nOk = gItems.filter(it => relevant(it.title)).length;
    const nUrl = show.filter(it => it.url).length;
    line(`   → ${nOk}/${gItems.length} bài có từ khóa trong tiêu đề | giải mã URL gốc: ${nUrl}/${show.length}`);
}

// 3) Google News KHÔNG lọc nguồn — để biết tin có tồn tại không, chỉ là 4 nguồn kia không đăng
line('\n─── 3) GOOGLE NEWS (mọi nguồn, để đối chiếu) ───');
const all = await searchGoogleNews(keyword, [], { days, max: 100, hl: 'ja', gl: 'JP', filterTitle: false });
const srcCount = {};
for (const it of all) srcCount[it.source || '?'] = (srcCount[it.source || '?'] || 0) + 1;
Object.entries(srcCount).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([s, n]) => line(`   ${String(n).padStart(2)} bài  ${s}`));
// Vài bài tiêu biểu KHÔNG thuộc 4 nguồn mặc định — kèm link, để biết mình đang bỏ lỡ gì
const ownNames = domains.map(d => (FEED_SOURCES[Object.keys(FEED_SOURCES).find(k => d.includes(k)) || ''] || {}).name).filter(Boolean).map(n => n.toLowerCase());
const isOwnSource = (src) => { const s2 = (src || '').toLowerCase(); return ownNames.some(n => s2.includes(n) || n.includes(s2)); };
const outside = all.filter(it => relevant(it.title) && !isOwnSource(it.source));
if (outside.length) {
    line(`\n   Tin ngoài 4 nguồn (${Math.min(showN, outside.length)}/${outside.length} bài đúng chủ đề):`);
    const showOut = outside.slice(0, showN);
    await Promise.all(showOut.map(async (it) => { it.url = await decodeGoogleNewsUrl(it.articleId); }));
    for (const it of showOut) {
        line(`   • [${it.source}] ${it.title.slice(0, 55)}`);
        line(`     ${it.url || '(không giải mã được URL)'}`);
    }
}

line('\n═══ TỔNG KẾT ═══');
const gOk = gItems.filter(it => relevant(it.title)).length;
const allOk = all.filter(it => relevant(it.title)).length;
line(`  RSS gốc (4 nguồn mặc định) : ${items.length} bài  (đã lọc từ khóa → đúng chủ đề 100%)`);
line(`  Google News (lọc nguồn)    : ${gItems.length} bài, trong đó ${gOk} bài thật sự có từ khóa`);
line(`  → Pipeline sẽ lấy          : ${items.length + gItems.length} bài (${items.length + gOk} bài đúng chủ đề)`);
line(`  Google News (mọi nguồn)    : ${all.length} bài, ${allOk} có từ khóa  ← tin ngoài kia`);
line('');
process.exit(0);
