// File: aljazeeraCrawler.js
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
        console.error(`      [AlJazeera Lỗi Tải] URL: ${url} - ${e.message}`);
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

    console.log(`      [AlJazeera Bot] Đang thâm nhập Hãng tin Trung Đông: ${searchUrl}`);

    const profilePath = path.join(process.cwd(), 'chrome_profile_aljazeera');

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
        
        // Al Jazeera load cũng khá nặng, cần đợi
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await delay(3000); 
        await humanScroll(page);
        await delay(2000);

        const html = await page.content();
        const $ = cheerio.load(html);
        let articleLinks = [];

        // 1. Quét bài báo trong trang kết quả
        // Các bài viết của Al Jazeera thường nằm trong thẻ <a> có class gc__title-link hoặc có URL dạng /news/ /features/
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && (href.includes('/news/') || href.includes('/features/') || href.includes('/gallery/'))) {
                articleLinks.push(href.startsWith('http') ? href : `https://www.aljazeera.com${href}`);
            }
        });

        articleLinks = [...new Set(articleLinks)]; 

        if (articleLinks.length === 0) {
            const pageTitle = await page.title();
            console.log(`      [AlJazeera Bot] ⚠️ Không thấy bài báo. (Page Title: "${pageTitle}")`);
            if (pageTitle.includes('Cloudflare') || pageTitle.includes('Attention')) {
                 console.log(`      [AlJazeera Bot] ⛔ Bị Cloudflare chặn! Cần đợi hoặc check IP...`);
                 await delay(5000);
            }
            return 0;
        }

        console.log(`      [AlJazeera Bot] Tìm thấy ${articleLinks.length} tin tức. Đang bóc file...`);

        // 2. Chui vào bài báo lấy Media
        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            try {
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await delay(2000);
                
                // Trị Modal (nếu có popup newsletter)
                await page.keyboard.press('Escape');
                await delay(500);

                const articleHtml = await page.content();
                const $$ = cheerio.load(articleHtml);

                let mediaUrls = [];

                if (type === 'video') {
                    // Video trên Al Jazeera thường giấu qua API hoặc Brightcove, nhưng meta og:video thỉnh thoảng vẫn có
                    const ogVideo = $$('meta[property="og:video"]').attr('content');
                    if (ogVideo && ogVideo.endsWith('.mp4')) mediaUrls.push(ogVideo);
                } else {
                    // Ưu tiên 1: Lấy ảnh Cover từ thẻ Meta (Chuẩn nhất)
                    const ogImage = $$('meta[property="og:image"]').attr('content');
                    if (ogImage) {
                         mediaUrls.push(ogImage);
                    }

                    // Ưu tiên 2: Al Jazeera có một chuyên mục là /gallery/ (rất nhiều ảnh).
                    // Ta cào trong class wp-block-image hoặc thẻ figure
                    $$('figure img, .wp-block-image img').each((i, el) => {
                        // Al Jazeera hay để ảnh xịn ở tham số srcset hoặc src
                        let src = $$(el).attr('src');
                        let srcset = $$(el).attr('srcset');

                        if (srcset) {
                            // Lấy link có độ phân giải lớn nhất trong srcset
                            const links = srcset.split(',').map(s => s.trim().split(' ')[0]);
                            src = links[links.length - 1]; 
                        }

                        if (src && src.startsWith('http') && !src.includes('avatar')) {
                             // Cắt tham số w=... để ép lấy ảnh gốc
                             mediaUrls.push(src.split('?')[0]);
                        }
                    });
                }

                mediaUrls = [...new Set(mediaUrls)];

                // 3. Tiến hành tải
                for (const url of mediaUrls) {
                    if (downloaded >= neededCount) break;

                    const finalUrl = url.startsWith('//') ? `https:${url}` : url;
                    
                    if (await downloadMedia(finalUrl, targetDir, ext)) {
                        downloaded++;
                        console.log(`      [AlJazeera Bot] ---> Đã lấy tin thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Bỏ qua bài lỗi
            }
        }
    } catch (error) {
        console.error(`      [AlJazeera Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}