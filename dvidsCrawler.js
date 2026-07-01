import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
// File: dvidsCrawler.js
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
// Import trình quản lý Proxy xoay vòng
import { getOldestProxy } from './proxyManager.js';
import { claimNextStockPath } from './stockNaming.js';
import { logCrawlError, logCrawlInfo } from './crawlLogger.js';

const SETTINGS_DIR = path.join(process.cwd(), 'setting');
const COUNTER_FILE = path.join(SETTINGS_DIR, 'current_index.txt');

puppeteer.use(StealthPlugin());

// Hàm tạo nhịp nghỉ (chờ Cloudflare/JS render)
const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Lấy đường dẫn Profile tiếp theo theo cơ chế xoay vòng
 */
function getNextProfilePath(keyword) {
    if (!fs.existsSync(SETTINGS_DIR)) {
        fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }

    // 1. Lấy danh sách tất cả thư mục bắt đầu bằng 'chrome-profile-'
    const profiles = fs.readdirSync(SETTINGS_DIR)
        .filter(f => f.startsWith('chrome-profile-') && fs.statSync(path.join(SETTINGS_DIR, f)).isDirectory())
        .sort((a, b) => {
            // Sắp xếp theo số ở đuôi (nếu có) để xoay vòng chuẩn
            const numA = parseInt(a.split('-').pop()) || 0;
            const numB = parseInt(b.split('-').pop()) || 0;
            return numA - numB;
        });

    if (profiles.length === 0) {
        console.error("      [DVIDS Bot] ⚠️ Không tìm thấy profile nào trong thư mục /settings");
        return null;
    }

    // 2. Đọc index hiện tại từ file
    let currentIndex = 0;
    if (fs.existsSync(COUNTER_FILE)) {
        currentIndex = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8')) || 0;
    }

    // 3. Tính toán profile tiếp theo
    const nextIndex = currentIndex % profiles.length;
    const selectedProfile = profiles[nextIndex];
    const profilePath = path.join(SETTINGS_DIR, selectedProfile);

    // 4. Lưu lại index cho lần chạy sau
    fs.writeFileSync(COUNTER_FILE, (nextIndex + 1).toString(), 'utf8');

    console.log(`      [${keyword}][DVIDS Bot] 🔄 Xoay vòng Profile: Sử dụng [${selectedProfile}]`);
    return profilePath;
}

// Nhận thêm tham số proxy để ẩn danh khi tải file
async function downloadMedia(url, targetDir, ext, proxy = null, keyword) {
    // 🟢 1. CHẶN TỪ VÒNG GỬI XE
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) {
        return false;
    }

    const savePath = claimNextStockPath(targetDir, ext, url);
    let success = false;

    try {
        const fetchOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };

        if (proxy && proxy.dispatcher) {
            fetchOptions.dispatcher = proxy.dispatcher;
        }

        // 🟢 CẢI TIẾN 1: Tăng thời gian chờ tải Video lên 3 PHÚT (180 giây), Ảnh giữ nguyên 15s
        const timeoutMs = (ext === 'mp4') ? 180000 : 15000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        fetchOptions.signal = controller.signal;

        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        if (res.ok) {
            const contentType = (res.headers.get('content-type') || '').toLowerCase();

            // 🟢 2. BẢO VỆ ĐỊNH DẠNG
            if (ext === 'mp4' && !contentType.includes('video')) return false;
            if (ext === 'jpg' && !contentType.includes('image')) {
                console.log(`      [Bỏ qua] Server không trả về Ảnh thật! (URL: ${url})`);
                return false;
            }

            const buffer = await res.arrayBuffer();

            // 🟢 CẢI TIẾN 2: Nới rộng giới hạn Video & Bắt Bot phải báo cáo nếu vứt file
            if (ext === 'mp4') {
                const sizeMB = buffer.byteLength / (1024 * 1024);
                if (sizeMB < 0.1) return false; // Nhỏ hơn 100KB -> Rác

                // Mở rộng giới hạn lên 250MB cho DVIDS
                if (sizeMB > 250) {
                    console.log(`      [Bỏ qua] Video DVIDS quá khủng (${sizeMB.toFixed(1)}MB). Vượt mốc 250MB!`);
                    return false;
                }
            } else if (ext === 'jpg') {
                if (buffer.byteLength < 5 * 1024) return false;
            }

            // Ghi file xuống ổ cứng
            fs.writeFileSync(savePath, Buffer.from(buffer));
            success = true;
            return true;
        } else {
            logCrawlError({ source: 'DVIDS', keyword, url, reason: `HTTP ${res.status} ${res.statusText || ''}`.trim() });
        }
    } catch (e) {
        // 🟢 CẢI TIẾN 3: Hiển thị cảnh báo nếu bị đứt mạng do tải quá lâu
        if (e.name === 'AbortError') {
             console.log(`      [Cảnh báo] Mạng quá chậm, file tải hơn ${ext==='mp4'?'3 phút':'15 giây'} nên bị hủy!`);
             logCrawlError({ source: 'DVIDS', keyword, url, reason: `timeout tải file (${ext==='mp4'?'>3 phút':'>15 giây'})` });
        } else {
             console.error(`      [${keyword}][Dvids Lỗi Tải File] URL: ${url} - ${e.message}`);
             logCrawlError({ source: 'DVIDS', keyword, url, reason: e.message });
        }
    } finally {
        if (!success) {
            try { fs.unlinkSync(savePath); } catch (_) {}
        }
    }
    return false;
}

export async function fetchFromDvidsBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    const searchType = type === 'video' ? 'video' : 'image';
    const searchUrl = `https://www.dvidshub.net/search?q=${encodeURIComponent(keyword)}&filter%5Btype%5D=${searchType}`;

    console.log(`      [${keyword}][DVIDS Bot] Đang bí mật cào: ${searchUrl}`);
    logCrawlInfo({ source: 'DVIDS', keyword, url: searchUrl, note: 'bắt đầu tìm' });

    // Lấy Profile theo cơ chế xoay vòng
    const profilePath = getNextProfilePath(keyword);

    // Lấy proxy cũ nhất trong hàng đợi (nhớ dùng await)
    // const proxy = await getOldestProxy();
    const proxy = null;

    // Khai báo các cờ cấu hình trình duyệt
    const browserArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', 
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled', // Tắt cờ báo hiệu "Tôi là Bot" của Chrome
        '--disable-features=IsolateOrigins,site-per-process', // Giúp iframe/Cloudflare xử lý mượt hơn
        '--disable-restore-session-state',
    ];

    // Gắn IP Proxy vào trình duyệt nếu có
    if (proxy) {
        browserArgs.push(`--proxy-server=${proxy.server}`);
        console.log(`      [${keyword}][DVIDS Bot] Đang ngụy trang bằng IP: ${proxy.server}`);
    }

    const browser = await puppeteer.launch({ 
        headless: 'new', 
        userDataDir: profilePath,
        args: browserArgs 
    });
    
    try {
        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font' || resourceType === 'media') {
                req.abort(); // Chặn tải ảnh, css, font trên trình duyệt ảo
            } else {
                req.continue();
            }
        });

        // 🟢 1. PHẢI XÁC THỰC PROXY TRƯỚC TIÊN (Trình diện bảo vệ)
        if (proxy && proxy.username && proxy.password) {
            await page.authenticate({ 
                username: proxy.username, 
                password: proxy.password 
            });
        }

        // 🟢 2. CÀI USER AGENT (Ngụy trang thành người thật)
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // 🟢 3. TIẾN VÀO DVIDS BẰNG TRY-CATCH (Bắt lỗi nếu Proxy chết thật)
        try {
            await page.goto('https://www.dvidshub.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            if (e.message.includes('ERR_INVALID_AUTH_CREDENTIALS') || e.message.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
                console.log(`      [${keyword}][DVIDS Bot] ⛔ Proxy ${proxy.server} bị lỗi xác thực hoặc đã chết. Đang bỏ qua luồng này!`);
                logCrawlError({ source: 'DVIDS', keyword, url: searchUrl, reason: `proxy chết/lỗi xác thực: ${e.message}` });
                return 0; // Proxy tạch thì trả về 0 cho hệ thống chạy tiếp, không crash tool
            }
            throw e; 
        }

        // 🟢 4. KIỂM TRA TRẠNG THÁI LOGIN PROFILE
        const isLoggedIn = await page.evaluate(() => {
            // Check các nút đặc trưng của DVIDS khi đã login (đổi lại class nếu cần)
            return document.querySelector('.logout-link') !== null || document.querySelector('a[href="/login"]') === null; 
        });

        if (!isLoggedIn) {
            // console.log(`      [${keyword}][DVIDS Bot] ⚠️ Profile chưa login. Vui lòng login tay vào profile này!`);
            // Vẫn có thể cào tiếp vì DVIDS cho phép khách xem, hoặc bạn cho return 0 tùy logic dự án
        }

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
            console.log(`      [${keyword}][DVIDS Bot] ⚠️ Không có kết quả. (Page Title: "${pageTitle}")`);
            
            // Nếu bị dính Cloudflare Challenge
            if (pageTitle.includes('Just a moment') || pageTitle.includes('Cloudflare')) {
                console.log(`      [${keyword}][DVIDS Bot] ⛔ Đã bị Cloudflare chặn!`);
                await delay(5000);
            }
            logCrawlError({ source: 'DVIDS', keyword, url: searchUrl, reason: `không có kết quả (Page Title: "${pageTitle}")` });
            return 0;
        }

        console.log(`      [${keyword}][DVIDS Bot] Đã moi được ${detailLinks.length} bài. Đang bóc file mp4/jpg...`);

        // 2. Chui vào từng bài để bóc file
        for (const link of detailLinks) {
            if (downloaded >= neededCount) break;

            try {
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await delay(1500); 

                const detailHtml = await page.content();
                const $$ = cheerio.load(detailHtml);

                let downloadUrl = null;

                if (type === 'video') {
                    // Ưu tiên 1: Tìm qua thẻ Meta SEO gốc (Các video bình thường)
                    downloadUrl = $$('meta[itemprop="contentURL"]').attr('content') || 
                                  $$('meta[property="og:video:url"]').attr('content') || 
                                  $$('meta[property="og:video:secure_url"]').attr('content') ||
                                  $$('meta[property="og:video"]').attr('content');
                    
                    // Ưu tiên 2: Quét regex tìm đuôi mp4 ở toàn bộ HTML
                    if (!downloadUrl) {
                        const mp4Match = detailHtml.match(/https?:\/\/[^"'\s<>]+?\.mp4/i);
                        if (mp4Match) downloadUrl = mp4Match[0];
                    }

                    // 🟢 TUYỆT CHIÊU MỚI: Nếu trang bị giấu MP4, chui vào trang Embed để tìm!
                    if (!downloadUrl) {
                        // Tìm link embed từ thẻ twitter:player
                        const embedLink = $$('meta[name="twitter:player"]').attr('content');
                        if (embedLink) {
                            console.log(`      [${keyword}][DVIDS Bot] 🔍 Video bị giấu MP4, đang luồn vào trang Embed: ${embedLink}`);
                            try {
                                await page.goto(embedLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
                                const embedHtml = await page.content();
                                
                                // Quét Regex tìm đuôi MP4 trong mã nguồn của trang nhúng
                                const embedMp4Match = embedHtml.match(/https?:\/\/[^"'\s<>]+?\.mp4/i);
                                if (embedMp4Match) {
                                    downloadUrl = embedMp4Match[0];
                                }
                            } catch(e) {
                                // Lỗi timeout trang embed thì bỏ qua
                                logCrawlError({ source: 'DVIDS', keyword, url: embedLink, reason: `embed: ${e.message}` });
                            }
                        }
                    }
                } else {
                    downloadUrl = $$('meta[property="og:image"]').attr('content') || 
                                  $$('meta[itemprop="image"]').attr('content');
                }

                // 3. Tải file về (Chuyền object proxy vào)
                if (downloadUrl) {
                    const finalUrl = downloadUrl.startsWith('//') ? `https:${downloadUrl}` : downloadUrl;
                    if (await downloadMedia(finalUrl, targetDir, ext, proxy, keyword)) {
                        downloaded++;
                        logCrawlInfo({ source: 'DVIDS/ok', keyword, url: finalUrl });
                        console.log(`\x1b[33m      [${keyword}][DVIDS Bot] 📥 ${type.toUpperCase()} bốc từ: ${finalUrl}\x1b[0m`);
                        console.log(`      [${keyword}][DVIDS Bot] ---> Đã bế thành công ${downloaded}/${neededCount} ${type}`);
                    }
                }
            } catch (err) {
                // Ignore lỗi timeout trang con
                logCrawlError({ source: 'DVIDS', keyword, url: link, reason: err.message });
            }
        }
    } catch (error) {
        console.error(`      [${keyword}][DVIDS Lỗi Tổng] ${error.message}`);
        logCrawlError({ source: 'DVIDS', keyword, url: searchUrl, reason: error.message });
    } finally {
        await browser.close();
    }

    if (downloaded === 0) {
        logCrawlError({ source: 'DVIDS', keyword, url: searchUrl, reason: 'kết thúc với 0 file tải được' });
    }
    return downloaded;
}