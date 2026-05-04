// File: dvidsCrawler.js
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
// Import trình quản lý Proxy xoay vòng
import { getOldestProxy } from './proxyManager.js';

puppeteer.use(StealthPlugin());

// Hàm tạo nhịp nghỉ (chờ Cloudflare/JS render)
const delay = ms => new Promise(res => setTimeout(res, ms));

// Nhận thêm tham số proxy để ẩn danh khi tải file
async function downloadMedia(url, targetDir, ext, proxy = null) {
    const existing = fs.readdirSync(targetDir).filter(f => f.startsWith('stock_') && f.endsWith(ext)).length;
    const savePath = path.join(targetDir, `stock_${existing + 1}.${ext}`);

    try {
        const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };
        
        // Gắn proxy dispatcher vào hàm fetch
        if (proxy && proxy.dispatcher) {
            fetchOptions.dispatcher = proxy.dispatcher;
        }

        const res = await fetch(url, fetchOptions);
        if (res.ok) {
            fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer()));
            return true;
        }
    } catch (e) {
        console.error(`      [DVIDS Lỗi Tải File] URL: ${url} - ${e.message}`);
    }
    return false;
}

export async function fetchFromDvidsBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    const searchType = type === 'video' ? 'video' : 'image';
    const searchUrl = `https://www.dvidshub.net/search?q=${encodeURIComponent(keyword)}&filter%5Btype%5D=${searchType}`;

    console.log(`      [DVIDS Bot] Đang bí mật cào: ${searchUrl}`);

    const profilePath = path.join(process.cwd(), 'chrome_profile_dvids');

    // Lấy proxy cũ nhất trong hàng đợi (nhớ dùng await)
    const proxy = await getOldestProxy();

    // Khai báo các cờ cấu hình trình duyệt
    const browserArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled', // Tắt cờ báo hiệu "Tôi là Bot" của Chrome
        '--disable-features=IsolateOrigins,site-per-process' // Giúp iframe/Cloudflare xử lý mượt hơn
    ];

    // Gắn IP Proxy vào trình duyệt nếu có
    if (proxy) {
        browserArgs.push(`--proxy-server=${proxy.server}`);
        console.log(`      [DVIDS Bot] Đang ngụy trang bằng IP: ${proxy.server}`);
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
        
        // Tăng timeout lên 60 giây để xử lý tình trạng chia nhỏ băng thông khi đa luồng
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // CHỜ 3 GIÂY CHO TRANG RENDER XONG VÀ VƯỢT QUA CLOUDFLARE
        await delay(3000); 

        const html = await page.content();
        const $ = cheerio.load(html);
        let detailLinks = [];

        // 1. Quét tìm các link bài chi tiết
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes(`/${searchType}/`) && href.match(/\d{5,}/)) {
                detailLinks.push(href.startsWith('http') ? href : `https://www.dvidshub.net${href}`);
            }
        });

        detailLinks = [...new Set(detailLinks)];

        if (detailLinks.length === 0) {
            const pageTitle = await page.title();
            console.log(`      [DVIDS Bot] ⚠️ Không có kết quả. (Page Title: "${pageTitle}")`);
            
            // Nếu bị dính Cloudflare Challenge, cho bot nghỉ ngơi 1 chút để nhả rate-limit
            if (pageTitle.includes('Just a moment') || pageTitle.includes('Cloudflare')) {
                console.log(`      [DVIDS Bot] ⛔ Đã bị Cloudflare chặn! Sẽ vượt qua ở lượt IP proxy tiếp theo...`);
                await delay(5000); 
            }
            return 0; 
        }

        console.log(`      [DVIDS Bot] Đã moi được ${detailLinks.length} bài. Đang bóc file mp4/jpg...`);

        // 2. Chui vào từng bài để bóc file
        for (const link of detailLinks) {
            if (downloaded >= neededCount) break;

            try {
                // Tăng timeout trang con lên 60 giây
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await delay(1500); // Chờ chút xíu cho thẻ meta được JS sinh ra (nếu có)

                const detailHtml = await page.content();
                const $$ = cheerio.load(detailHtml);

                let downloadUrl = null;

                if (type === 'video') {
                    // Ưu tiên cao nhất: Thẻ Meta SEO
                    downloadUrl = $$('meta[itemprop="contentURL"]').attr('content') || 
                                  $$('meta[property="og:video:url"]').attr('content') || 
                                  $$('meta[property="og:video:secure_url"]').attr('content') ||
                                  $$('meta[property="og:video"]').attr('content');
                    
                    // Dự phòng: Quét text
                    if (!downloadUrl) {
                        const mp4Match = detailHtml.match(/https?:\/\/[^"'\s<>]+?\.mp4/i);
                        if (mp4Match) downloadUrl = mp4Match[0];
                    }
                } else {
                    downloadUrl = $$('meta[property="og:image"]').attr('content') || 
                                  $$('meta[itemprop="image"]').attr('content');
                }

                // 3. Tải file về (Chuyền object proxy vào)
                if (downloadUrl) {
                    const finalUrl = downloadUrl.startsWith('//') ? `https:${downloadUrl}` : downloadUrl;
                    if (await downloadMedia(finalUrl, targetDir, ext, proxy)) {
                        downloaded++;
                        console.log(`      [DVIDS Bot] ---> Đã bế thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Ignore lỗi timeout trang con
            }
        }
    } catch (error) {
        console.error(`      [DVIDS Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}