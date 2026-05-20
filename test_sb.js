// Test bot Storyblocks (Playwright)
// Cách chạy:
//   node test_sb.js                                    -> mặc định: video, keyword "Louisiana primary election", 2 file
//   node test_sb.js "stock market crashing"            -> đổi keyword
//   node test_sb.js "military helicopter" video 4      -> keyword + type + số file
//   node test_sb.js "city skyline" image 3             -> tải ảnh

import path from 'path';
import fs from 'fs';
import { fetchFromStoryblocksBot } from './storyblocksCrawler.js';

const keyword = process.argv[2] || 'Louisiana primary election';
const type = process.argv[3] || 'video';            // 'video' hoặc 'image'
const count = parseInt(process.argv[4] || '2', 10);

const outDir = path.join(process.cwd(), '_test_storyblocks', type);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

console.log('=== TEST STORYBLOCKS BOT (Playwright) ===');
console.log('Keyword :', keyword);
console.log('Type    :', type);
console.log('Cần     :', count, 'file');
console.log('Lưu tại :', outDir);
console.log('-------------------------------------------');

const t0 = Date.now();
const got = await fetchFromStoryblocksBot(keyword, type, outDir, count);
const dt = ((Date.now() - t0) / 1000).toFixed(1);

console.log('-------------------------------------------');
console.log(`✅ Xong sau ${dt}s. Tải được ${got}/${count} ${type}.`);
if (got > 0) {
    const files = fs.readdirSync(outDir).filter(f => f.startsWith('stock_'));
    console.log('Files:', files);
}
process.exit(0);
