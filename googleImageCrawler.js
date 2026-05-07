// File: googleImageCrawler.js (Bản 3.0 - Săn Video OVP của Bing)
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import proxyChain from 'proxy-chain';
import { getOldestProxy } from './proxyManager.js';

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

async function downloadMedia(url, targetDir, ext, proxy = null) {
    const existing = fs.readdirSync(targetDir).filter(f => f.startsWith('stock_') && f.endsWith(ext)).length;
    const savePath = path.join(targetDir, `stock_${existing + 1}.${ext}`);
    try {
        if (url.startsWith('data:image')) {
            const buffer = Buffer.from(url.split(',')[1], 'base64');
            fs.writeFileSync(savePath, buffer);
            return true;
        }
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
        if (res.ok) {
            fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer()));
            return true;
        }
    } catch (e) {}
    return false;
}

export async function fetchFromGoogleImageBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';

    // ĐỊNH TUYẾN TÌM KIẾM
    const searchUrl = type === 'video' 
        ? `https://www.bing.com/videos/search?q=${encodeURIComponent(keyword)}`
        : `https://www.bing.com/images/search?q=${encodeURIComponent(keyword)}&form=HDRSC3`;

    const proxy = await getOldestProxy();
    let anonymizedProxyUrl = null;
    const browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'];

    if (proxy) {
        const proxyServerClean = proxy.server.replace('http://', '').replace('https://', '');
        if (proxy.username && proxy.password) {
            try {
                anonymizedProxyUrl = await proxyChain.anonymizeProxy(`http://${proxy.username}:${proxy.password}@${proxyServerClean}`);
                browserArgs.push(`--proxy-server=${anonymizedProxyUrl}`);
            } catch (e) { return 0; }
        } else {
            browserArgs.push(`--proxy-server=http://${proxyServerClean}`);
        }
    }

    const browser = await puppeteer.launch({ headless: "new", args: browserArgs });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');

        console.log(`      [Web ${type.toUpperCase()} Bot] Đang thâm nhập Bing: ${keyword}`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        let mediaUrls = [];

        if (type === 'video') {
            // 🟢 THUẬT TOÁN BÓC VIDEO 3.0: Săn tìm các link OVP (Online Video Preview) của Bing
            
            // Cuộn trang để Bing nạp thêm video
            await page.evaluate(() => window.scrollBy(0, 1500));
            await delay(2500);
            
            const html = await page.content();
            const $ = cheerio.load(html);

            // 1. Lọc từ thuộc tính data-metadata (JSON chuẩn)
            $('[data-metadata]').each((i, el) => {
                const meta = $(el).attr('data-metadata');
                if (meta) {
                    try {
                        const parsed = JSON.parse(meta);
                        // Bing lưu link video xem trước vào biến videoUrl
                        if (parsed.videoUrl && parsed.videoUrl.includes('OVP')) {
                            mediaUrls.push(parsed.videoUrl);
                        }
                    } catch (e) {}
                }
            });

            // 2. Vét cạn bằng Regex để không lọt lưới (Tìm mọi link có chứa OVP)
            const ovpRegex = /https:\/\/th\.bing\.com\/th\/id\/OVP\.[a-zA-Z0-9_-]+(?:[^\s"'<>\\]*)?/g;
            const matches = html.match(ovpRegex) || [];
            
            // Xử lý chuỗi Unicode nếu có (\u0026 -> &)
            matches.forEach(url => {
                mediaUrls.push(url.replace(/\\u0026/g, '&'));
            });

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
            if (mediaUrls.length === 0) {
                $('img.mimg').each((i, el) => {
                    const src = $(el).attr('src') || $(el).attr('data-src');
                    if (src) mediaUrls.push(src);
                });
            }
        }

        // Lọc trùng lặp
        mediaUrls = [...new Set(mediaUrls)];

        if (mediaUrls.length === 0) {
            console.log(`      [Web ${type.toUpperCase()} Bot] ⚠️ Không thấy ${type}.`);
            await page.screenshot({ path: path.join(targetDir, `debug_bing_${type}_${Date.now()}.jpg`) });
            return 0;
        }

        console.log(`      [Web ${type.toUpperCase()} Bot] Tìm thấy ${mediaUrls.length} tài nguyên. Đang tải...`);

        for (const url of mediaUrls) {
            if (downloaded >= neededCount) break;
            // Hàm downloadMedia sẽ tự động thêm đuôi .mp4 vào cuối file khi lưu
            if (await downloadMedia(url, targetDir, ext, proxy)) {
                downloaded++;
                console.log(`      [Web ${type.toUpperCase()} Bot] ---> Đã lấy thành công ${downloaded}/${neededCount}`);
            }
        }
    } catch (error) {
        console.error(`      [Web Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close().catch(() => {});
        if (anonymizedProxyUrl) await proxyChain.closeAnonymizedProxy(anonymizedProxyUrl, true).catch(() => {});
    }
    return downloaded;
}