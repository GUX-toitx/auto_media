import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
// File: apnewsCrawler.js
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { getOldestProxy } from './proxyManager.js';
import { exec } from 'child_process'; 
import util from 'util';

const execPromise = util.promisify(exec);
puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

const globalScrapedArticles = new Set(); 
const globalDownloadedMedia = new Set();

/**
 * 🟢 HÀM BÓC TÁCH ID GỐC: Trích xuất url gốc từ link CDN ẩn của AP News
 * Giúp nhận diện chính xác ảnh sinh đôi dù bị thay đổi kích thước/crop layout
 */
function getUniqueAssetId(url) {
    try {
        const urlObj = new URL(url.startsWith('//') ? `https:${url}` : url);
        const realAssetUrl = urlObj.searchParams.get('url');
        if (realAssetUrl) return realAssetUrl; // Trả về link ảnh gốc cốt lõi
    } catch (e) {}
    return url;
}

// Hàm chuyên tải và chuyển đổi Stream HLS (.m3u8) sang MP4
async function downloadHlsStream(m3u8Url, savePath, keyword) {
    try {
        console.log(`      [${keyword}] [APNews Bot] 🎬 Phát hiện luồng HLS. Đang điều FFmpeg tải và ghép Video...`);
        const command = `ffmpeg -y -i "${m3u8Url}" -c copy -bsf:a aac_adtstoasc "${savePath}"`;
        
        await execPromise(command, { timeout: 300000 }); 
        
        if (fs.existsSync(savePath)) {
            const stats = fs.statSync(savePath);
            if (stats.size > 100 * 1024) return true;
        }
    } catch (e) {
        console.error(`      [${keyword}] [Lỗi FFmpeg] Không thể tải Stream HLS: ${e.message}`);
        if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
    }
    return false;
}

// Hàm tải trực tiếp file thường
async function downloadMedia(url, targetDir, ext, proxy = null, keyword = '') {
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) {
        return false;
    }

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const existing = fs.readdirSync(targetDir).filter(f => f.startsWith('stock_') && f.endsWith(ext)).length;
    const savePath = path.join(targetDir, `stock_${existing + 1}.${ext}`);

    if (ext === 'mp4' && url.includes('.m3u8')) {
        return await downloadHlsStream(url, savePath, keyword);
    }

    try {
        const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };
        
        if (proxy && proxy.dispatcher) {
            fetchOptions.dispatcher = proxy.dispatcher;
        }

        const timeoutMs = (ext === 'mp4') ? 180000 : 15000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        fetchOptions.signal = controller.signal;

        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId); 

        if (res.ok) {
            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            
            if (ext === 'mp4' && !contentType.includes('video')) return false;
            if (ext === 'jpg' && !contentType.includes('image')) return false;

            const buffer = await res.arrayBuffer();

            if (ext === 'mp4') {
                if (buffer.byteLength < 100 * 1024) return false; 
                if (buffer.byteLength > 50 * 1024 * 1024) return false; 
            } else if (ext === 'jpg') {
                if (buffer.byteLength < 5 * 1024) return false; 
            }

            fs.writeFileSync(savePath, Buffer.from(buffer));
            return true;
        }
    } catch (e) {
        // Bỏ qua lỗi ngầm
    }
    return false;
}

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
            }, 400);
        });
    });
}

export async function fetchFromApnewsBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    
    const searchUrl = `https://apnews.com/search?q=${encodeURIComponent(keyword)}`;
    console.log(`      [${keyword}] [APNews Bot] Đang thâm nhập: ${searchUrl}`);

    const proxy = await getOldestProxy();
    const browserArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled'
    ];

    if (proxy) {
        browserArgs.push(`--proxy-server=${proxy.server}`);
        console.log(`      [${keyword}] [APNews Bot] Đang ngụy trang bằng IP: ${proxy.server}`);
    }

    const browser = await puppeteer.launch({ 
        headless: 'new', 
        args: browserArgs 
    });
    
    try {
        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url().toLowerCase();
            const resourceType = req.resourceType();

            if (url.includes('ad.gt') || url.includes('adnxs') || url.includes('doubleclick') || url.includes('pubmatic') || url.includes('openx') || url.includes('tapad') || url.includes('casalemedia') || url.includes('yield')) {
                return req.abort();
            }

            if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font' || resourceType === 'media') {
                return req.abort();
            }

            req.continue();
        });

        if (proxy && proxy.username && proxy.password) {
            await page.authenticate({ username: proxy.username, password: proxy.password });
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        console.log(`      [${keyword}] [APNews Bot] Đang chờ dữ liệu...`);
        try {
            // 🟢 ĐEO KÍNH 1: Bắt buộc chỉ đợi link bài báo xuất hiện ở TRONG khu vực <main>
            await page.waitForSelector('main a[href*="/article/"]', { timeout: 15000 });
        } catch (e) { }

        await humanScroll(page); 
        await delay(1000);

        const html = await page.content();
        const $ = cheerio.load(html);
        let articleLinks = [];

        // 🟢 ĐEO KÍNH 2: XÓA lệnh $('a').each... cũ đi và thay bằng lệnh khoanh vùng này
        // Phớt lờ toàn bộ link ở Sidebar, Header, Footer. Chỉ lấy link trong Main Content!
        $('main a, .PageList-items a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('/article/') && !href.includes('/author/')) {
                articleLinks.push(href.startsWith('http') ? href : `https://apnews.com${href}`);
            }
        });

        articleLinks = [...new Set(articleLinks)]; 

        if (articleLinks.length === 0) {
            console.log(`      [${keyword}] [APNews Bot] ⚠️ Không thấy bài báo.`);
            return 0;
        }

        console.log(`      [${keyword}] [APNews Bot] Tìm thấy ${articleLinks.length} tin tức. Đang bóc file...`);

        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            if (globalScrapedArticles.has(link)) continue; 
            globalScrapedArticles.add(link);

            console.log(`      [${keyword}] [APNews Bot] 🔎 Đang chui vào bài: ${link}`);

            try {
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });

                try {
                    await page.waitForSelector('.RichTextStoryBody, main, article', { timeout: 10000 });
                } catch(e) {}
                await humanScroll(page); 
                
                if (type === 'image') {
                    await delay(2000); 
                } else {
                    await delay(500); 
                }

                const articleHtml = await page.content();
                const $$ = cheerio.load(articleHtml);

                let mediaUrls = [];

                if (type === 'video') {
                    const videoRegex = /(?:https?:)?\/\/[^"'\s<>]+?\.(mp4|m3u8)/gi;
                    const matches = articleHtml.match(videoRegex);
                    
                    if (matches && matches.length > 0) {
                        const cleanUrl = matches[0].replace(/\\/g, '');
                        mediaUrls.push(cleanUrl);
                    } else {
                        console.log(`      [${keyword}] [APNews Bot] ⏭️ Bài này bị giấu video quá kỹ hoặc nhúng Youtube. Bỏ qua!`);
                    }
                } else {
                    const ogImage = $$('meta[property="og:image"]').attr('content') || $$('meta[name="twitter:image"]').attr('content');
                    if (ogImage && !ogImage.match(/logo|icon|avatar|author|branding|placeholder/i)) {
                        mediaUrls.push(ogImage); 
                    }

                    $$('figure img, .RichTextStoryBody img, .Gallery img, main img').each((i, el) => {
                        let targetSrc = $$(el).attr('data-src') || $$(el).attr('src');
                        
                        if (!targetSrc && $$(el).attr('srcset')) {
                            const links = $$(el).attr('srcset').split(',').map(s => s.trim().split(' ')[0]);
                            targetSrc = links[links.length - 1]; 
                        }

                        if (targetSrc) {
                            if (!targetSrc.match(/logo|icon|avatar|author|branding|placeholder|\.svg/i)) {
                                if (targetSrc.includes('apnews.com') || targetSrc.includes('dims.apnews.com')) {
                                    mediaUrls.push(targetSrc);
                                }
                            }
                        }
                    });
                }

                mediaUrls = [...new Set(mediaUrls)];

                for (const url of mediaUrls) {
                    if (downloaded >= neededCount) break;

                    const finalUrl = url.startsWith('//') ? `https:${url}` : url;
                    
                    // 🟢 KIỂM TRA CHỐNG TRÙNG BẰNG ID TÀI SẢN GỐC (Dứt điểm lặp ảnh)
                    const assetUniqueId = getUniqueAssetId(finalUrl);
                    if (globalDownloadedMedia.has(assetUniqueId)) continue; 
                    globalDownloadedMedia.add(assetUniqueId);

                    if (await downloadMedia(finalUrl, targetDir, ext, proxy, keyword)) {
                        downloaded++;
                        console.log(`\x1b[33m      [${keyword}] [APNews Bot] 📥 ${type.toUpperCase()} này được bốc từ bài: ${link}\x1b[0m`);
                        console.log(`      [${keyword}] [APNews Bot] ---> Đã lấy tin thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Kế thừa lỗi trang con
            }
        }
    } catch (error) {
        console.error(`      [${keyword}] [APNews Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}
