// File: bellingcatCrawler.js
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

async function downloadMedia(url, targetDir, ext) {
    const existing = fs.readdirSync(targetDir).filter(f => f.startsWith('stock_') && f.endsWith(ext)).length;
    const savePath = path.join(targetDir, `stock_${existing + 1}.${ext}`);

    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) {
            fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer()));
            return true;
        }
    } catch (e) {
        console.error(`      [Bellingcat Lỗi Tải] URL: ${url} - ${e.message}`);
    }
    return false;
}

export async function fetchFromBellingcatBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    
    // Bellingcat tìm kiếm chung qua tham số ?s=
    const searchUrl = `https://www.bellingcat.com/?s=${encodeURIComponent(keyword)}`;

    console.log(`      [Bellingcat Bot] Đang thâm nhập OSINT: ${searchUrl}`);

    // Dùng một Profile riêng cho Bellingcat để tránh đụng độ với DVIDS
    const profilePath = path.join(process.cwd(), 'chrome_profile_bellingcat');

    const browser = await puppeteer.launch({ 
        headless: "new", 
        userDataDir: profilePath,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled'
        ] 
    });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
            console.log(`      [Bellingcat Bot] ⚠️ Không có kết quả. (Page Title: "${pageTitle}")`);
            if (pageTitle.includes('Just a moment') || pageTitle.includes('Cloudflare')) {
                console.log(`      [Bellingcat Bot] ⛔ Đã bị Cloudflare chặn! Cần nghỉ ngơi giảm nhịp độ...`);
                await delay(5000); 
            }
            return 0;
        }

        console.log(`      [Bellingcat Bot] Tìm thấy ${articleLinks.length} bài điều tra. Đang trích xuất...`);

        // 2. Chui vào từng bài để bóc File
        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            try {
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
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

                // 3. Tải file về
                for (const url of mediaUrls) {
                    if (downloaded >= neededCount) break;

                    const finalUrl = url.startsWith('//') ? `https:${url}` : url;
                    
                    if (await downloadMedia(finalUrl, targetDir, ext)) {
                        downloaded++;
                        console.log(`      [Bellingcat Bot] ---> Đã lấy OSINT thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Bỏ qua bài lỗi
            }
        }
    } catch (error) {
        console.error(`      [Bellingcat Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}
