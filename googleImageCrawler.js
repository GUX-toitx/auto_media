import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { claimNextStockPath } from './stockNaming.js';

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

async function downloadMedia(url, targetDir, ext, keyword = '') {
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) return false;
    // Bỏ qua stock photo site chặn hotlink - sẽ tải ảnh rác
    const stockDomains = ['alamy.com', 'gettyimages.com', 'shutterstock.com', 'istockphoto.com', 'dreamstime.com', 'depositphotos.com', '123rf.com', 'stock.adobe.com', 'pond5.com', 'bigstockphoto.com'];
    if (stockDomains.some(d => url.includes(d))) return false;

    const savePath = claimNextStockPath(targetDir, ext);
    let success = false;

    try {
        const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };

        // Ép Timeout 15s để chống treo Bot
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        fetchOptions.signal = controller.signal;

        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        if (res.ok) {
            const contentType = (res.headers.get('content-type') || '').toLowerCase();

            // 🟢 2. BẢO VỆ CHO VIDEO: Bắt buộc phải là video thật
            if (ext === 'mp4' && !contentType.includes('video')) {
                return false;
            }

            // 🟢 3. BẢO VỆ CHO ẢNH (Vừa thêm): Bắt buộc phải là ảnh thật (loại trừ HTML từ onelink.me)
            if (ext === 'jpg' && !contentType.includes('image')) {
                console.log(`      [Bỏ qua] Server không trả về Ảnh thật! (Bị lỗi giả danh URL: ${url})`);
                return false;
            }

            const buffer = await res.arrayBuffer();

            // 🟢 4. BẢO VỆ DUNG LƯỢNG
            if (ext === 'mp4') {
                if (buffer.byteLength < 100 * 1024) return false; // Nhỏ hơn 100KB -> Rác
                if (buffer.byteLength > 35 * 1024 * 1024) return false; // Lớn hơn 35MB -> Treo RAM
            } else if (ext === 'jpg') {
                if (buffer.byteLength < 5 * 1024) return false; // Ảnh bé hơn 5KB -> Rác/Icon nhỏ
            }

            // Vượt qua TẤT CẢ rào cản thì mới được lưu
            fs.writeFileSync(savePath, Buffer.from(buffer));
            success = true;
            return true;
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
             console.error(`      [${keyword}][Bing Lỗi Tải File] URL: ${url} - ${e.message}`);
        }
    } finally {
        if (!success) {
            try { fs.unlinkSync(savePath); } catch (_) {}
        }
    }
    return false;
}

export async function fetchFromGoogleImageBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';

    // ĐỊNH TUYẾN TÌM KIẾM
    const searchUrl = type === 'video' 
        ? `https://www.bing.com/videos/search?q=${encodeURIComponent(keyword)}&safesearch=off`
        : `https://www.bing.com/images/search?q=${encodeURIComponent(keyword)}&safesearch=off`;

    const browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'];

    const browser = await puppeteer.launch({ headless: "new", args: browserArgs });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');

        console.log(`      [${keyword}][Web ${type.toUpperCase()} Bot] Đang thâm nhập Bing: ${keyword}`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        let mediaUrls = [];

        if (type === 'video') {
            return 0;
        } else {
            // BÓC ẢNH (Giữ nguyên thuật toán bóc ảnh Full HD cực tốt)
            await page.evaluate(() => window.scrollBy(0, 1000));
            await delay(2000);
            const html = await page.content();
            const $ = cheerio.load(html);

            $('a.iusc').each((i, el) => {
                const mData = $(el).attr('m');
                if (mData) {
                    try {
                        const parsed = JSON.parse(mData);
                        if (parsed.murl) mediaUrls.push(parsed.murl);
                    } catch (e) {}
                }
            });
            console.log(`      [${keyword}] iusc count: ${mediaUrls.length}`);
            if (mediaUrls.length === 0) {
                // Lưu screenshot để debug
                await page.screenshot({ path: path.join(targetDir, `debug_bing_${Date.now()}.jpg`) });
                $('img.mimg').each((i, el) => {
                    const src = $(el).attr('src') || $(el).attr('data-src');
                    if (src && src.startsWith('http')) mediaUrls.push(src);
                });
            }        }

        // Lọc trùng lặp
        mediaUrls = [...new Set(mediaUrls)];

        if (mediaUrls.length === 0) {
            console.log(`      [${keyword}][Web ${type.toUpperCase()} Bot] ⚠️ Không thấy ${type}.`);
            await page.screenshot({ path: path.join(targetDir, `debug_bing_${type}_${Date.now()}.jpg`) });
            return 0;
        }

        console.log(`      [${keyword}][Web ${type.toUpperCase()} Bot] Tìm thấy ${mediaUrls.length} tài nguyên. Đang tải...`);

        for (const url of mediaUrls) {
            if (downloaded >= neededCount) break;
            // Hàm downloadMedia sẽ tự động thêm đuôi .mp4 vào cuối file khi lưu
            if (await downloadMedia(url, targetDir, ext, keyword)) {
                downloaded++;
                console.log(`\x1b[33m      [${keyword}][Web ${type.toUpperCase()} Bot] 📥 ${type.toUpperCase()} bốc từ: ${url}\x1b[0m`);
                console.log(`      [${keyword}][Web ${type.toUpperCase()} Bot] ---> Đã lấy thành công ${downloaded}/${neededCount}`);
            }
        }
    } catch (error) {
        console.error(`      [${keyword}][Web Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close().catch(() => {});
    }
    return downloaded;
}