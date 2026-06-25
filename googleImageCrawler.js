import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { claimNextStockPath } from './stockNaming.js';

const require = createRequire(import.meta.url);
const { GOOGLE_IMG_SCRAP } = require('google-img-scrap');

const blockDomains = [
    'alamy.com', 'gettyimages.com', 'shutterstock.com', 'istockphoto.com',
    'dreamstime.com', 'depositphotos.com', '123rf.com', 'stock.adobe.com',
    'pond5.com', 'bigstockphoto.com',
    'freepik.com', 'vecteezy.com', 'flaticon.com', 'vectorstock.com',
    'pinterest.', 'tumblr.com', 'deviantart.com',
    'garena', 'freefire', 'gamerant', 'steam',
    'goodfreephotos.com', 'wallpapercave.com', 'alphacoders.com',
    'freepng', 'pngtree', 'nicepng', 'kindpng', 'cleanpng',
    'easydrawforkids', 'howtodrawforkids', 'paintingvalley', 'clipartmag',
    'clipartkey', 'ac-illust.com', 'illustmint.com',
    'blogspot.com', 'hatena.com',
];

async function downloadMedia(url, targetDir, keyword = '') {
    if (!url) return false;
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) return false;
    if (blockDomains.some(d => url.toLowerCase().includes(d))) return false;

    const savePath = claimNextStockPath(targetDir, 'jpg');
    let success = false;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            if (!contentType.includes('image')) return false;
            const buffer = await res.arrayBuffer();
            if (buffer.byteLength < 20 * 1024) return false; // < 20KB -> rác
            fs.writeFileSync(savePath, Buffer.from(buffer));
            success = true;
            return true;
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.error(`      [${keyword}][Lỗi Tải] ${url} - ${e.message}`);
    } finally {
        if (!success) { try { fs.unlinkSync(savePath); } catch (_) {} }
    }
    return false;
}

export async function fetchFromGoogleImageBot(keyword, type, targetDir, neededCount) {
    if (type === 'video') return 0;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    let downloaded = 0;
    console.log(`      [${keyword}][Google IMG Scrap] Đang tìm: "${keyword}"`);

    try {
        const result = await GOOGLE_IMG_SCRAP({ search: keyword, limit: neededCount * 3 });
        const images = result.result || [];
        console.log(`      [${keyword}] Tìm được ${images.length} ảnh, đang tải...`);

        for (const img of images) {
            if (downloaded >= neededCount) break;
            if (!img.url) continue;
            if (await downloadMedia(img.url, targetDir, keyword)) {
                downloaded++;
                console.log(`\x1b[33m      [${keyword}][Google IMG Scrap] 📥 IMAGE bốc từ: ${img.url}\x1b[0m`);
                console.log(`      [${keyword}][Google IMG Scrap] ---> Đã lấy thành công ${downloaded}/${neededCount}`);
            }
        }
    } catch (e) {
        console.error(`      [${keyword}][Google IMG Scrap Lỗi] ${e.message}`);
    }

    return downloaded;
}
