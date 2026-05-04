// File: apnewsCrawler.js
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
// Import trình quản lý Proxy xoay vòng
import { getOldestProxy } from './proxyManager.js';

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

// Nhận thêm tham số proxy để ẩn IP khi tải file
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
        console.error(`      [APNews Lỗi Tải File] URL: ${url} - ${e.message}`);
    }
    return false;
}

// Hàm cuộn trang mô phỏng người thật
async function humanScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 300;
            let timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if(totalHeight >= 3000){ // Cuộn khoảng 3000px để load đủ bài
                    clearInterval(timer);
                    resolve();
                }
            }, 400);
        });
    });
}

export async function fetchFromApnewsBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    
    // Trang tìm kiếm của AP News
    const searchUrl = `https://apnews.com/search?q=${encodeURIComponent(keyword)}`;

    console.log(`      [APNews Bot] Đang thâm nhập Hãng AP: ${searchUrl}`);

    const profilePath = path.join(process.cwd(), 'chrome_profile_apnews');

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
        console.log(`      [APNews Bot] Đang ngụy trang bằng IP: ${proxy.server}`);
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
        
        // Tăng timeout lên 60 giây để hệ thống đa luồng không bị rớt mạng
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(3000); 
        await humanScroll(page); 
        await delay(2000);

        const html = await page.content();
        const $ = cheerio.load(html);
        let articleLinks = [];

        // 1. Tìm link bài báo trong kết quả tìm kiếm
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('/article/') && !href.includes('/author/')) {
                articleLinks.push(href.startsWith('http') ? href : `https://apnews.com${href}`);
            }
        });

        articleLinks = [...new Set(articleLinks)]; 

        if (articleLinks.length === 0) {
            const pageTitle = await page.title();
            console.log(`      [APNews Bot] ⚠️ Không thấy bài báo. (Page Title: "${pageTitle}")`);
            if (pageTitle.includes('Just a moment') || pageTitle.includes('Cloudflare')) {
                 console.log(`      [APNews Bot] ⛔ Bị chặn! Sẽ vượt qua ở lượt IP proxy tiếp theo...`);
                 await delay(5000);
            }
            return 0;
        }

        console.log(`      [APNews Bot] Tìm thấy ${articleLinks.length} tin tức. Đang bóc file...`);

        // 2. Chui vào bài báo lấy Media
        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            try {
                // Tăng timeout trang con lên 60s
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
                await delay(2000); 

                // TUYỆT CHIÊU TRỊ MODAL: Bấm phím ESCAPE 2 lần để tắt mọi popup/modal chặn màn hình
                await page.keyboard.press('Escape');
                await delay(500);
                await page.keyboard.press('Escape');
                await delay(1000);

                // Sau khi dẹp Modal, mới bắt đầu cuộn trang lấy ảnh Lazy Load
                await humanScroll(page); 
                await delay(2000);

                const articleHtml = await page.content();
                const $$ = cheerio.load(articleHtml);

                let mediaUrls = [];

                if (type === 'video') {
                    const ogVideo = $$('meta[property="og:video"]').attr('content');
                    if (ogVideo && ogVideo.endsWith('.mp4')) mediaUrls.push(ogVideo);
                } else {
                    // Lấy ảnh Cover (đã gọt bỏ tham số size phía sau dấu ? để lấy ảnh gốc nét nhất)
                    const ogImage = $$('meta[property="og:image"]').attr('content');
                    if (ogImage) mediaUrls.push(ogImage.split('?')[0]);

                    // Quét toàn diện thẻ img trong bài báo (mở rộng vùng tìm kiếm)
                    $$('img').each((i, el) => {
                        const src = $$(el).attr('src') || $$(el).attr('data-src');
                        // Bỏ qua các icon, logo rác
                        if (src && src.startsWith('http') && !src.match(/logo|avatar|icon|tracking/i)) {
                            mediaUrls.push(src.split('?')[0]);
                        }
                    });
                }

                mediaUrls = [...new Set(mediaUrls)];

                // 3. Tiến hành tải (Chuyền proxy vào)
                for (const url of mediaUrls) {
                    if (downloaded >= neededCount) break;

                    const finalUrl = url.startsWith('//') ? `https:${url}` : url;
                    
                    if (await downloadMedia(finalUrl, targetDir, ext, proxy)) {
                        downloaded++;
                        console.log(`      [APNews Bot] ---> Đã lấy tin thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Bỏ qua bài lỗi
            }
        }
    } catch (error) {
        console.error(`      [APNews Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}