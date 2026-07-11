// Test nhanh: MỖI keyword ĐỊA CHÍNH TRỊ tìm được BAO NHIÊU tin trên Google News RSS Nhật (gl=JP, hl=ja, when:1d).
// Dùng để thử bộ từ khoá + nguồn TRƯỚC khi đưa vào tab 'dia_chinh_tri'.
//
// Cách chạy (trong thư mục media-team):
//   node test_geo_topic.mjs                 // test HẾT bộ keyword bên dưới, LỌC theo SOURCES
//   node test_geo_topic.mjs nosrc           // test HẾT bộ keyword nhưng KHÔNG lọc nguồn (để so sánh)
//   node test_geo_topic.mjs "台湾有事 日本"   // test 1 keyword tuỳ ý (vẫn lọc theo SOURCES)
//
// LƯU Ý: RSS luôn là bản Nhật -> từ khoá TIẾNG NHẬT ra nhiều tin nhất; tiếng Anh/Việt thường ít hoặc 0 bài.

import { searchGoogleNews } from './news_pipeline.js';

const DAYS = 1;                     // cửa sổ tin (khớp monitor: when:1d)
const HL = 'ja', GL = 'JP';         // luôn RSS Nhật

// ===== BỘ TỪ KHOÁ (chủ đề Nhật - Trung) =====
const KEYWORDS = [
    'Japan - China',
    'Japan and China',
    'Japan-China relations',
    'Sino-Japanese tensions',
    'Senkaku Diaoyu islands dispute',
    'Taiwan Strait Japan defense',
    'Japan counterstrike capabilities',
    '日中関係',
    '日中緊張',
    '外交摩擦',
    '尖閣諸島問題',
    '東シナ海',
    '台湾有事 日本',
    '日本 - 中国',
    '日本と中国',
    'Senkaku',
    '尖閣諸島',
    'Senkaku-shotō',
];

// ===== NGUỒN CHO PHÉP (site: OR) =====
const SOURCES = [
    'nhk.or.jp',
    'japantimes.co.jp',
    'japan-forward.com',
    'nippon.com',
    'nikkei.com',
    'yomiuri.co.jp',
    'asahi.com',
    'mainichi.jp',
    'jiji.com',
    'kyodo.co.jp',
    'sankei.com',
    'x.com',
];

// --- xử lý tham số ---
const arg = process.argv[2];
const noSrc = arg === 'nosrc';
const sources = noSrc ? [] : SOURCES;
const keywords = (arg && !noSrc) ? [arg] : KEYWORDS;

console.log(`Cấu hình: ${keywords.length} keyword · nguồn: ${sources.length ? sources.join(', ') : '(không lọc)'} · cửa sổ ${DAYS} ngày (RSS Nhật)\n`);

const seen = new Set();     // dedup theo articleId để đếm tổng bài không trùng
const rows = [];            // { kw, count }

for (const kw of keywords) {
    try {
        const arts = await searchGoogleNews(kw, sources, { days: DAYS, max: 30, hl: HL, gl: GL });
        arts.forEach(a => seen.add(a.articleId));
        rows.push({ kw, count: arts.length });
        console.log(`===== "${kw}" -> ${arts.length} bài =====`);
        arts.slice(0, 5).forEach((a, i) => console.log(`  ${i + 1}. [${a.source || '?'}] ${a.title}`));
        if (!arts.length) console.log('  (0 bài — cân nhắc bỏ hoặc đổi keyword)');
        console.log('');
    } catch (e) {
        rows.push({ kw, count: -1 });
        console.log(`===== "${kw}" -> LỖI: ${e.message} =====\n`);
    }
}

// ===== TỔNG KẾT =====
console.log('================ TỔNG KẾT ================');
rows.sort((a, b) => b.count - a.count);
for (const r of rows) {
    const mark = r.count > 0 ? '✅' : (r.count === 0 ? '⚠️ ' : '❌');
    console.log(`  ${mark} ${String(r.count).padStart(3)}  ${r.kw}`);
}
const okCount = rows.filter(r => r.count > 0).length;
const zeroCount = rows.filter(r => r.count === 0).length;
console.log(`\n  CÓ TIN: ${okCount}/${keywords.length} keyword · 0 BÀI: ${zeroCount} keyword · TỔNG ${seen.size} bài KHÔNG TRÙNG (24h).`);
console.log('  Ký hiệu: ✅ = có tin (dùng được) · ⚠️ = 0 bài (nên bỏ) · ❌ = lỗi mạng.');
if (zeroCount === 0) console.log('  => Tất cả keyword đều có tin, dùng được hết cho tab dia_chinh_tri. 👍');
