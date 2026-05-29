import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
// File: cnnCrawler.js
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
// Dùng hàm xoay vòng tròn chuẩn xác nhất
import { getOldestProxy } from './proxyManager.js'; 

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

// Nhận thêm tham số proxy để tải file an toàn
async function downloadMedia(url, targetDir, ext, proxy = null, keyword = '') {
    // 🟢 1. CHẶN TỪ VÒNG GỬI XE: Gặp mấy link tải app này thì né luôn, khỏi tải
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) {
        return false;
    }

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const existing = fs.readdirSync(targetDir).filter(f => f.startsWith('stock_') && f.endsWith(ext)).length;
    const savePath = path.join(targetDir, `stock_${existing + 1}.${ext}`);

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
                console.log(`      [Bỏ qua] Server không trả về Ảnh thật! (Bị lỗi giả danh URL: ${url})`);
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
            return true;
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
             console.error(`      [${keyword}][CNN Lỗi Tải File] URL: ${url} - ${e.message}`);
        }
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
    
    const searchUrl = `https://edition.cnn.com/search?q=${encodeURIComponent(keyword)}&size=10`;

    console.log(`      [${keyword}][CNN Bot] Đang thâm nhập CNN: ${searchUrl}`);

    const profilePath = path.join(process.cwd(), 'chrome_profile_cnn');

    // Lấy proxy cũ nhất trong hàng đợi (nhớ dùng await)
    const proxy = await getOldestProxy();

    // Chuẩn bị các cờ cấu hình cho trình duyệt
    const browserArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled'
    ];

    // Gắn IP Proxy vào trình duyệt
    if (proxy) {
        browserArgs.push(`--proxy-server=${proxy.server}`);
        console.log(`      [${keyword}][CNN Bot] Đang ngụy trang bằng IP: ${proxy.server}`);
    }

    // Khởi tạo trình duyệt VỚI các cờ đã setup
    const browser = await puppeteer.launch({ 
        headless: "new", 
        // userDataDir: profilePath,
        args: browserArgs 
    });
    
    try {
        const page = await browser.newPage();

        // Đăng nhập Proxy nếu có User/Pass
        if (proxy && proxy.username && proxy.password) {
            await page.authenticate({ 
                username: proxy.username, 
                password: proxy.password 
            });
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Timeout đã nâng lên 60s để chịu tải đa luồng
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(4000); 
        await humanScroll(page);

        const html = await page.content();
        const $ = cheerio.load(html);
        let articleLinks = [];

        // 1. Tìm link bài báo
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            
            // 🟢 THÊM LỚP CHẶN LINK RÁC Ở ĐÂY
            if (href && (href.match(/\/\d{4}\/\d{2}\/\d{2}\//) || href.includes('/videos/'))) {
                
                // Nếu link chứa các từ khóa cấm kỵ thì BỎ QUA (return)
                const junkLinkRegex = /cnni-fast|onelink\.me|app-store|google-play/i;
                if (junkLinkRegex.test(href)) {
                    return; // Nhảy qua thẻ <a> này, không thèm nhét vào mảng
                }

                articleLinks.push(href.startsWith('http') ? href : `https://edition.cnn.com${href}`);
            }
        });

        articleLinks = [...new Set(articleLinks)]; 

        if (articleLinks.length === 0) {
            const pageTitle = await page.title();
            console.log(`      [${keyword}][CNN Bot] ⚠️ Không thấy bài báo. (Page Title: "${pageTitle}")`);
            return 0;
        }

        console.log(`      [${keyword}][CNN Bot] Tìm thấy ${articleLinks.length} tin tức. Đang bóc file...`);

        // 2. Chui vào bài báo lấy Media
        for (const link of articleLinks) {
            if (downloaded >= neededCount) break;

            try {
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await delay(2000); 

                await page.keyboard.press('Escape');
                await delay(500);

                await humanScroll(page);
                await delay(1000);

                const articleHtml = await page.content();
                const $$ = cheerio.load(articleHtml);

                // 🟢 THÊM ĐOẠN NÀY VÀO DƯỚI CHEERIO.LOAD
                // 1. Chém bay cái Div to bự chứa widget theo tên Class bạn vừa gửi
                $$('.container_lead-plus-headlines-with-images__cards-wrapper').remove();
                
                // 2. Chém bay bất cứ Element nào có thuộc tính liên kết đến cnni-fast
                $$('[data-open-link*="cnni-fast"]').remove();
                $$('[data-card-url*="cnni-fast"]').remove();
                
                // 3. Quét tóm gọn: Thấy thẻ <a> nào chứa cnni-fast hoặc onelink.me thì xóa luôn thằng cha bao bọc nó
                $$('a[href*="cnni-fast"], a[href*="onelink.me"]').parent().remove();

                let mediaUrls = [];

                if (type === 'video') {
                    const ogVideo = $$('meta[property="og:video"]').attr('content');
                    if (ogVideo && ogVideo.endsWith('.mp4')) mediaUrls.push(ogVideo);
                } else {
                    // 🟢 ĐÃ THÊM: onelink\.me và cnni-fast vào dánh sách cấm
                    const junkRegex = /cnni-fast|onelink\.me|logo|avatar|icon|tracking|app-?store|play-?store|google-?play|apple|android|badge|placeholder|blank|promo|newsletter|cnn-headlines|generic|default/i;

                    // 1. Lấy ảnh đại diện bài viết (OG Image)
                    const ogImage = $$('meta[property="og:image"]').attr('content');
                    if (ogImage && !junkRegex.test(ogImage)) {
                        mediaUrls.push(ogImage);
                    }

                    // 2. Lấy ảnh trong các thẻ picture
                    $$('picture source').each((i, el) => {
                        const srcset = $$(el).attr('srcset');
                        if (srcset) {
                            const firstLink = srcset.split(',')[0].split(' ')[0];
                            if (firstLink && firstLink.startsWith('http') && !junkRegex.test(firstLink)) {
                                mediaUrls.push(firstLink);
                            }
                        }
                    });
                    
                    // 3. Lấy ảnh trong nội dung bài
                    $$('.image__container img, .image__light img, .article__main img, figure img').each((i, el) => {
                        const src = $$(el).attr('src') || $$(el).attr('data-src'); 
                        if (src && src.startsWith('http') && !junkRegex.test(src)) {
                            mediaUrls.push(src);
                        }
                    });
                }

                mediaUrls = [...new Set(mediaUrls)];

                // 3. Tiến hành tải (Đã truyền thêm proxy)
                for (const url of mediaUrls) {
                    if (downloaded >= neededCount) break;

                    const finalUrl = url.startsWith('//') ? `https:${url}` : url;
                    
                    // Truyền object proxy vào hàm để ẩn IP lúc tải file
                    if (await downloadMedia(finalUrl, targetDir, ext, proxy, keyword)) {
                        downloaded++;
                        console.log(`\x1b[33m      [${keyword}][CNN Bot] 📥 ${type.toUpperCase()} bốc từ: ${link}\x1b[0m`);
                        console.log(`      [${keyword}][CNN Bot] ---> Đã lấy tin thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Bỏ qua bài lỗi
            }
        }
    } catch (error) {
        console.error(`      [${keyword}][CNN Lỗi Tổng] ${error.message}`);
    } finally {
        await browser.close();
    }

    return downloaded;
}
