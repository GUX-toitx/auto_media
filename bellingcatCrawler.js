import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
// File: bellingcatCrawler.js
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
// Import trình quản lý Proxy xoay vòng
import { getOldestProxy } from './proxyManager.js';
import { claimNextStockPath } from './stockNaming.js';
import { logCrawlError } from './crawlLogger.js';

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

// Nhận thêm tham số proxy để tải file ẩn danh
async function downloadMedia(url, targetDir, ext, proxy = null, keyword = '') {
    // 🟢 1. CHẶN TỪ VÒNG GỬI XE: Gặp mấy link tải app này thì né luôn, khỏi tải
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) {
        return false;
    }

    const savePath = claimNextStockPath(targetDir, ext);
    let success = false;

    try {
        const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };

        if (proxy && proxy.dispatcher) {
            fetchOptions.dispatcher = proxy.dispatcher;
        }

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
                console.log(`      [${keyword}][Bỏ qua] Server không trả về Ảnh thật! (Bị lỗi giả danh URL: ${url})`);
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
             console.error(`      [${keyword}][Bellingcat Lỗi Tải File] URL: ${url} - ${e.message}`);
        }
        logCrawlError({ source: 'Bellingcat', keyword, url, reason: e.name === 'AbortError' ? 'timeout' : e.message });
    } finally {
        if (!success) {
            try { fs.unlinkSync(savePath); } catch (_) {}
        }
    }
    return false;
}

export async function fetchFromBellingcatBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    
    // Bellingcat tìm kiếm chung qua tham số ?s=
    const searchUrl = `https://www.bellingcat.com/?s=${encodeURIComponent(keyword)}`;

    console.log(`      [${keyword}][Bellingcat Bot] Đang thâm nhập OSINT: ${searchUrl}`);

    const profilePath = path.join(process.cwd(), 'chrome_profile_bellingcat');

    // Lấy proxy cũ nhất trong hàng đợi (nhớ dùng await)
    const proxy = await getOldestProxy();

    // Khai báo mảng args chuẩn trước
    const browserArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled'
    ];

    // Gắn IP Proxy vào trình duyệt nếu có
    if (proxy) {
        browserArgs.push(`--proxy-server=${proxy.server}`);
        console.log(`      [${keyword}][Bellingcat Bot] Đang ngụy trang bằng IP: ${proxy.server}`);
    }

    const browser = await puppeteer.launch({ 
        headless: "new", 
        // userDataDir: profilePath,
        args: browserArgs 
    });
    
    try {
        const page = await browser.newPage();

        // Xác thực Proxy bằng Username & Password
        if (proxy && proxy.username && proxy.password) {
            await page.authenticate({ 
                username: proxy.username, 
                password: proxy.password 
            });
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Tăng timeout lên 60 giây để hệ thống đa luồng không bị nghẽn mạng
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(3000); // Chờ check Cloudflare

        const html = await page.content();
        const $ = cheerio.load(html);
        let articleLinks = [];

        // 1. Quét tìm các bài báo trong trang kết quả tìm kiếm
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            // Các bài điều tra của Bellingcat thường nằm trong /news/ hoặc /resources/
            if (href && (href.includes('/news/') || href.includes('/resources/')) && !href.includes('/category/')) {
                articleLinks.push(href);
            }
        });

        articleLinks = [...new Set(articleLinks)]; // Lọc trùng

        if (articleLinks.length === 0) {
            const pageTitle = await page.title();
            console.log(`      [${keyword}][Bellingcat Bot] ⚠️ Không có kết quả. (Page Title: "${pageTitle}")`);
            if (pageTitle.includes('Just a moment') || pageTitle.includes('Cloudflare')) {
                console.log(`      [${keyword}][Bellingcat Bot] ⛔ Bị Cloudflare chặn! Sẽ vượt qua ở lượt IP proxy tiếp theo...`);
                await delay(5000); 
            }
            return 0;
        }

        console.log(`      [${keyword}][Bellingcat Bot] Tìm thấy ${articleLinks.length} bài điều tra. Đang trích xuất...`);

        // 2. Chui vào từng bài để bóc File
        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            try {
                // Tăng timeout trang con lên 60s
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await delay(1500); 

                const articleHtml = await page.content();
                const $$ = cheerio.load(articleHtml);

                let mediaUrls = [];

                if (type === 'video') {
                    // Cào thẻ video mp4 (Rất hiếm ở Bellingcat, nhưng cứ quét dự phòng)
                    $$('video source[src$=".mp4"], a[href$=".mp4"]').each((i, el) => {
                        const src = $$(el).attr('src') || $$(el).attr('href');
                        if (src) mediaUrls.push(src);
                    });
                } else {
                    // Ưu tiên 1: Lấy ảnh Thumbnail lớn nhất của bài báo (Thường là ảnh chất lượng cao nhất)
                    const ogImage = $$('meta[property="og:image"]').attr('content');
                    if (ogImage) mediaUrls.push(ogImage);

                    // Ưu tiên 2: Cào toàn bộ ảnh trong thân bài báo (Ảnh vệ tinh, bản đồ)
                    // Bellingcat dùng WordPress, nội dung chính thường nằm trong thẻ <article>
                    $$('article img').each((i, el) => {
                        let src = $$(el).attr('src') || $$(el).attr('data-src');
                        // Bỏ qua ảnh logo, avatar, ảnh icon quá nhỏ
                        if (src && !src.includes('logo') && !src.includes('avatar') && !src.includes('svg')) {
                            // Mẹo: WordPress thường có chữ -150x150.jpg ở cuối ảnh thu nhỏ. Ta cắt đuôi đó đi để lấy ảnh gốc nét căng
                            src = src.replace(/-\d+x\d+(\.\w+)$/, '$1');
                            mediaUrls.push(src);
                        }
                    });
                }

                // Lọc trùng link ảnh trong cùng 1 bài
                mediaUrls = [...new Set(mediaUrls)];

                // 3. Tiến hành tải (Chuyền proxy vào)
                for (const url of mediaUrls) {
                    if (downloaded >= neededCount) break;

                    const finalUrl = url.startsWith('//') ? `https:${url}` : url;
                    
                    if (await downloadMedia(finalUrl, targetDir, ext, proxy, keyword)) {
                        downloaded++;
                        console.log(`\x1b[33m      [${keyword}][Bellingcat Bot] 📥 ${type.toUpperCase()} bốc từ: ${link}\x1b[0m`);
                        console.log(`      [${keyword}][Bellingcat Bot] ---> Đã lấy OSINT thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Bỏ qua bài lỗi
            }
        }
    } catch (error) {
        console.error(`      [${keyword}][Bellingcat Lỗi Tổng] ${error.message}`);
        logCrawlError({ source: 'Bellingcat/total', keyword, reason: error.message });
    } finally {
        await browser.close();
    }

    return downloaded;
}