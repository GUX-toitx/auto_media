import { fetchIPv4 as fetch } from '../lib/fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
// File: aljazeeraCrawler.js
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
// Import trình quản lý Proxy xoay vòng
import { getOldestProxy } from '../lib/proxyManager.js';
import { claimNextStockPath } from '../lib/stockNaming.js';

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

// Nhận thêm tham số proxy để tải file an toàn
async function downloadMedia(url, targetDir, ext, proxy = null, keyword = '') {
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) {
        return false;
    }

    const savePath = claimNextStockPath(targetDir, ext);
    let success = false;

    try {
        const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };
        if (proxy && proxy.dispatcher) fetchOptions.dispatcher = proxy.dispatcher;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        fetchOptions.signal = controller.signal;
        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);
        if (res.ok) {
            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            if (ext === 'mp4' && !contentType.includes('video')) return false;
            if (ext === 'jpg' && !contentType.includes('image')) {
                console.log(`      [${keyword}][Aljazeera][Bỏ qua] Server không trả về Ảnh thật! (URL: ${url})`);
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
             console.error(`      [${keyword}][Aljazeera Lỗi Tải File] URL: ${url} - ${e.message}`);
        }
    } finally {
        if (!success) {
            try { fs.unlinkSync(savePath); } catch (_) {}
        }
    }
    return false;
}

// Hàm cuộn trang để kích hoạt Lazy Load ảnh
async function humanScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 300;
            let timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if(totalHeight >= 3000){ 
                    clearInterval(timer);
                    resolve();
                }
            }, 300);
        });
    });
}

export async function fetchFromAlJazeeraBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    
    // Al Jazeera có trang search chuẩn
    const searchUrl = `https://www.aljazeera.com/search/${encodeURIComponent(keyword)}`;

    console.log(`      [${keyword}][AlJazeera Bot] Đang thâm nhập Hãng tin Trung Đông: ${searchUrl}`);

    const profilePath = path.join(process.cwd(), 'chrome_profile_aljazeera');

    // Lấy proxy cũ nhất trong hàng đợi để tối đa hóa thời gian nghỉ của IP
    const proxy = await getOldestProxy();

    // Chuẩn bị các cờ cấu hình trình duyệt
    const browserArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled'
    ];

    // Gắn proxy vào trình duyệt nếu có
    if (proxy) {
        browserArgs.push(`--proxy-server=${proxy.server}`);
        console.log(`      [${keyword}][AlJazeera Bot] Đang ngụy trang bằng IP: ${proxy.server}`);
    }

    const browser = await puppeteer.launch({ 
        headless: "new", 
        // userDataDir: profilePath,
        args: browserArgs 
    });
    
    try {
        const page = await browser.newPage();

        // CỰC KỲ QUAN TRỌNG: Xác thực User/Pass cho Proxy
        if (proxy && proxy.username && proxy.password) {
            await page.authenticate({ 
                username: proxy.username, 
                password: proxy.password 
            });
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Nâng timeout lên 60 giây để xử lý tình trạng chia nhỏ băng thông mạng
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(3000); 
        await humanScroll(page);
        await delay(2000);

        const html = await page.content();
        const $ = cheerio.load(html);
        let articleLinks = [];

        // 1. Quét bài báo trong trang kết quả
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && (href.includes('/news/') || href.includes('/features/') || href.includes('/gallery/'))) {
                articleLinks.push(href.startsWith('http') ? href : `https://www.aljazeera.com${href}`);
            }
        });

        articleLinks = [...new Set(articleLinks)]; 

        if (articleLinks.length === 0) {
            const pageTitle = await page.title();
            console.log(`      [${keyword}][AlJazeera Bot] ⚠️ Không thấy bài báo. (Page Title: "${pageTitle}")`);
            if (pageTitle.includes('Cloudflare') || pageTitle.includes('Attention')) {
                 console.log(`      [${keyword}][AlJazeera Bot] ⛔ Bị Cloudflare chặn! Sẽ vượt qua ở lượt IP proxy tiếp theo...`);
            }
            return 0;
        }

        console.log(`      [${keyword}][AlJazeera Bot] Tìm thấy ${articleLinks.length} tin tức. Đang bóc file...`);

        // 2. Chui vào bài báo lấy Media
        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            try {
                // Timeout cho trang con cũng phải là 60s
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await delay(2000);
                
                // Trị Modal (nếu có popup newsletter)
                await page.keyboard.press('Escape');
                await delay(500);

                const articleHtml = await page.content();
                const $$ = cheerio.load(articleHtml);

                let mediaUrls = [];

                if (type === 'video') {
                    const ogVideo = $$('meta[property="og:video"]').attr('content');
                    if (ogVideo && ogVideo.endsWith('.mp4')) mediaUrls.push(ogVideo);
                } else {
                    // 🟢 ĐÃ THÊM: Bộ lọc từ khóa rác của Al Jazeera (aj-english_meta, aj-logo...)
                    const junkRegex = /logo|avatar|icon|tracking|app-?store|play-?store|google-?play|apple|android|badge|placeholder|blank|promo|newsletter|generic|default|aj-english_meta|aj-logo|aj-breaking/i;

                    // 1. Kiểm tra ảnh đại diện (og:image) qua bộ lọc
                    const ogImage = $$('meta[property="og:image"]').attr('content');
                    if (ogImage && !junkRegex.test(ogImage)) {
                         mediaUrls.push(ogImage);
                    }

                    // 2. Lấy ảnh trong bài viết và quét qua bộ lọc
                    $$('figure img, .wp-block-image img').each((i, el) => {
                        let src = $$(el).attr('src');
                        let srcset = $$(el).attr('srcset');

                        if (srcset) {
                            // Lấy link ảnh nét nhất ở cuối srcset
                            const links = srcset.split(',').map(s => s.trim().split(' ')[0]);
                            src = links[links.length - 1]; 
                        }

                        // Kiểm tra chặt chẽ bằng junkRegex
                        if (src && src.startsWith('http') && !junkRegex.test(src)) {
                             mediaUrls.push(src.split('?')[0]); // Bỏ các tham số tracking phía sau dấu ?
                        }
                    });
                }

                mediaUrls = [...new Set(mediaUrls)];

                // 3. Tiến hành tải (Chuyền Object Proxy vào)
                for (const url of mediaUrls) {
                    if (downloaded >= neededCount) break;

                    const finalUrl = url.startsWith('//') ? `https:${url}` : url;
                    
                    if (await downloadMedia(finalUrl, targetDir, ext, proxy, keyword)) {
                        downloaded++;
                        console.log(`\x1b[33m      [${keyword}][AlJazeera Bot] 📥 ${type.toUpperCase()} bốc từ: ${link}\x1b[0m`);
                        console.log(`      [${keyword}][AlJazeera Bot] ---> Đã lấy tin thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Bỏ qua bài lỗi
            }
        }
    } catch (error) {
        console.error(`      [${keyword}][AlJazeera Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}
