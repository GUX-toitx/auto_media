// File: cnnCrawler.js
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
        console.error(`      [CNN Lỗi Tải] URL: ${url} - ${e.message}`);
    }
    return false;
}

// Hàm cuộn trang để kích hoạt Lazy Load
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

export async function fetchFromCnnBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    
    // Trang tìm kiếm của CNN
    const searchUrl = `https://edition.cnn.com/search?q=${encodeURIComponent(keyword)}&size=10`;

    console.log(`      [CNN Bot] Đang thâm nhập CNN: ${searchUrl}`);

    const profilePath = path.join(process.cwd(), 'chrome_profile_cnn');

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
        
        // CNN load tìm kiếm bằng JS rất chậm, phải dùng networkidle2 và đợi thêm
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await delay(4000); 
        await humanScroll(page);

        const html = await page.content();
        const $ = cheerio.load(html);
        let articleLinks = [];

        // 1. Tìm link bài báo trong kết quả
        // Bài báo của CNN thường có định dạng URL chứa ngày tháng: /2023/10/10/world/... hoặc chuyên mục /videos/
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && (href.match(/\/\d{4}\/\d{2}\/\d{2}\//) || href.includes('/videos/'))) {
                articleLinks.push(href.startsWith('http') ? href : `https://edition.cnn.com${href}`);
            }
        });

        articleLinks = [...new Set(articleLinks)]; 

        if (articleLinks.length === 0) {
            const pageTitle = await page.title();
            console.log(`      [CNN Bot] ⚠️ Không thấy bài báo. (Page Title: "${pageTitle}")`);
            return 0;
        }

        console.log(`      [CNN Bot] Tìm thấy ${articleLinks.length} tin tức. Đang bóc file...`);

        // 2. Chui vào bài báo lấy Media
        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            try {
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(2000); 

                // Tắt các popup Cookie Consent hoặc Newsletter
                await page.keyboard.press('Escape');
                await delay(500);

                await humanScroll(page);
                await delay(1000);

                const articleHtml = await page.content();
                const $$ = cheerio.load(articleHtml);

                let mediaUrls = [];

                if (type === 'video') {
                    // Cào video mp4 từ Meta tag (CNN giấu khá kỹ, hên xui mới có thẻ này)
                    const ogVideo = $$('meta[property="og:video"]').attr('content');
                    if (ogVideo && ogVideo.endsWith('.mp4')) mediaUrls.push(ogVideo);
                } else {
                    // Ưu tiên 1: Lấy ảnh bìa từ thẻ Meta
                    const ogImage = $$('meta[property="og:image"]').attr('content');
                    if (ogImage) {
                         mediaUrls.push(ogImage);
                    }

                    // Ưu tiên 2: Cào ảnh trong nội dung bài (thường nằm trong thẻ picture)
                    $$('picture source').each((i, el) => {
                        const srcset = $$(el).attr('srcset');
                        if (srcset) {
                            // CNN thường nối nhiều link vào srcset, ta lấy link lớn nhất
                            const firstLink = srcset.split(',')[0].split(' ')[0];
                            if (firstLink && !firstLink.includes('logo') && !firstLink.includes('blank')) {
                                mediaUrls.push(firstLink);
                            }
                        }
                    });
                    
                    // Dự phòng thẻ img thông thường
                    $$('.image__container img, .image__light img').each((i, el) => {
                        const src = $$(el).attr('src');
                        if (src && src.startsWith('http') && !src.match(/logo|avatar|icon|tracking/i)) {
                            mediaUrls.push(src);
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
                        console.log(`      [CNN Bot] ---> Đã lấy tin thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Bỏ qua bài lỗi
            }
        }
    } catch (error) {
        console.error(`      [CNN Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}