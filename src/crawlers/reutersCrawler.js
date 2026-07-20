import { fetchIPv4 as fetch } from '../lib/fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
// File: reutersCrawler.js
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
        console.error(`      [Reuters Lỗi Tải] URL: ${url} - ${e.message}`);
    }
    return false;
}

// Lăn chuột từ từ để qua mặt hệ thống theo dõi hành vi của Akamai/DataDome
async function humanScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 200;
            let timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if(totalHeight >= 2000){ // Chỉ cuộn 1 đoạn ngắn, không cần cuộn hết
                    clearInterval(timer);
                    resolve();
                }
            }, 300);
        });
    });
}

export async function fetchFromReutersBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    
    // Trang tìm kiếm của Reuters
    const searchUrl = `https://www.reuters.com/site-search/?query=${encodeURIComponent(keyword)}`;

    console.log(`      [Reuters Bot] Đang thâm nhập Hãng thông tấn: ${searchUrl}`);

    // BẮT BUỘC dùng Profile riêng
    const profilePath = path.join(process.cwd(), 'chrome_profile_reuters');

    const browser = await puppeteer.launch({ 
        headless: "new", 
        // userDataDir: profilePath,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--window-size=1366,768', // Màn hình phổ thông để ít bị nghi ngờ
            '--disable-blink-features=AutomationControlled'
        ] 
    });
    
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Reuters tải bằng React rất nặng, cần chờ networkidle2
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await delay(2000); 
        await humanScroll(page); // Cuộn giả người
        await delay(2000);

        const html = await page.content();
        const $ = cheerio.load(html);
        let articleLinks = [];

        // 1. Tìm link bài báo trong kết quả tìm kiếm
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            // Link bài Reuters thường có dạng /world/europe/ten-bai-bao-2023-10-10/ hoặc /business/
            // Ta loại bỏ các link navigation, author, about...
            if (href && href.match(/\/[a-z-]+\/[a-z-]+\/.*-\d{4}-\d{2}-\d{2}\/$/)) {
                articleLinks.push(href.startsWith('http') ? href : `https://www.reuters.com${href}`);
            }
        });

        articleLinks = [...new Set(articleLinks)]; 

        if (articleLinks.length === 0) {
            const pageTitle = await page.title();
            console.log(`      [Reuters Bot] ⚠️ Không thấy bài báo. (Page Title: "${pageTitle}")`);
            if (pageTitle.includes('Access Denied') || pageTitle.includes('Robot')) {
                console.log(`      [Reuters Bot] ⛔ Bị tường lửa DataDome tóm cổ! Cần dùng trình duyệt thật cày Cookie...`);
            }
            return 0;
        }

        console.log(`      [Reuters Bot] Tìm thấy ${articleLinks.length} tin tức. Đang bóc file...`);

        // 2. Chui vào bài báo lấy Media
        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            try {
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await delay(2000); // Phải chờ để JS bung ảnh ra

                const articleHtml = await page.content();
                const $$ = cheerio.load(articleHtml);

                let mediaUrls = [];

                if (type === 'video') {
                    // Cào thẻ video mp4 (Reuters thường giấu video trong iframe hoặc m3u8, nhưng đôi khi vẫn có og:video)
                    const ogVideo = $$('meta[property="og:video"]').attr('content') || $$('meta[property="og:video:url"]').attr('content');
                    if (ogVideo && ogVideo.endsWith('.mp4')) mediaUrls.push(ogVideo);

                    $$('video source[src$=".mp4"]').each((i, el) => {
                        mediaUrls.push($$(el).attr('src'));
                    });
                } else {
                    // Tuyệt chiêu: Lấy ảnh Cover nét căng nhất của bài báo
                    const ogImage = $$('meta[property="og:image"]').attr('content');
                    if (ogImage) {
                        // Thỉnh thoảng og:image bị chèn tham số width=800, ta xóa nó đi để lấy ảnh gốc bự nhất
                        mediaUrls.push(ogImage.split('?')[0]); 
                    }

                    // Quét thêm ảnh trong bài (thường nằm trong thẻ picture)
                    $$('picture source').each((i, el) => {
                        const srcset = $$(el).attr('srcset');
                        if (srcset && !srcset.includes('avatar') && !srcset.includes('logo')) {
                            // Lấy link đầu tiên trong srcset
                            const firstLink = srcset.split(' ')[0];
                            mediaUrls.push(firstLink);
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
                        console.log(`\x1b[33m      [Reuters Bot] 📥 ${type.toUpperCase()} bốc từ: ${link}\x1b[0m`);
                        console.log(`      [Reuters Bot] ---> Đã lấy tin thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Bỏ qua bài lỗi
            }
        }
    } catch (error) {
        console.error(`      [Reuters Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}
