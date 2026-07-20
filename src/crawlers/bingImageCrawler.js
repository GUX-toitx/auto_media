import { fetchIPv4 as fetch } from '../lib/fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'fs';
import { claimNextStockPath } from '../lib/stockNaming.js';
import { logCrawlError, logCrawlInfo } from '../lib/crawlLogger.js';
import { getRandomProxy } from '../lib/proxyPool.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Cùng danh sách chặn như Google để khỏi dính stock/clipart/wallpaper rác
const blockDomains = [
    'alamy.com', 'gettyimages.com', 'shutterstock.com', 'istockphoto.com',
    'dreamstime.com', 'depositphotos.com', '123rf.com', 'stock.adobe.com',
    'pond5.com', 'bigstockphoto.com',
    'freepik.com', 'vecteezy.com', 'flaticon.com', 'vectorstock.com',
    'pinterest.', 'tumblr.com', 'deviantart.com',
    'garena', 'freefire', 'gamerant', 'steam',
    'goodfreephotos.com', 'wallpapercave.com', 'alphacoders.com',
    'freepng', 'pngtree', 'nicepng', 'kindpng', 'cleanpng',
    'easydrawforkids', 'howtodrawforkids', 'paintingvalley', 'clipartmag',
    'clipartkey', 'ac-illust.com', 'illustmint.com',
    'blogspot.com', 'hatena.com',
    // Du lịch / khách sạn / đặt phòng / hàng không -> hay ra ảnh phong cảnh, không liên quan
    'tripadvisor', 'tripcdn', 'trip.com', 'ctrip', 'c-ctrip',
    'booking.com', 'bstatic.com', 'agoda', 'expedia',
    'hotels.com', 'cdn-hotels', 'hotelscombined', 'hotelscdn',
    'kayak', 'skyscanner', 'trivago', 'airbnb', 'hostelworld', 'ostrovok', 'makemytrip',
    'klook', 'kkday', 'veltra', 'asoview', 'getyourguide',
    'skyticket', 'jalan.net', 'rurubu', 'ikyu.com', 'jtb', 'his-j.com',
    'hankyu-travel', 'nta.co.jp', 'rakutentravel', 'travel.rakuten',
    'navitime', 'jorudan', 'tabikobo', 'tour.ne.jp', 'yokoso',
    'gltjp.com', 'japan-web-magazine', 'simpleviewinc', 'tourism', 'travel.',
    'airport.or.jp', 'kansai-airport', 'narita-airport', 'haneda-airport', 'centrair',
];

// Lấy danh sách URL ảnh gốc (murl) từ HTML trang Bing Images
function parseBingMurls(html) {
    const urls = [];
    const re = /murl&quot;:&quot;(.*?)&quot;/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const u = m[1].replace(/\\u002f/gi, '/').replace(/&amp;/g, '&').trim();
        if (u) urls.push(u);
    }
    return urls;
}

async function downloadMedia(url, targetDir, keyword = '', dispatcher = null) {
    if (!url) return false;
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) return false;
    if (blockDomains.some(d => url.toLowerCase().includes(d))) return false;

    const savePath = claimNextStockPath(targetDir, 'jpg');
    let success = false;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal, dispatcher });
        clearTimeout(timeoutId);
        if (!res.ok) {
            logCrawlError({ source: 'Bing/download', keyword, url, reason: `HTTP ${res.status}` });
            return false;
        }
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('image')) { logCrawlError({ source: 'Bing/download', keyword, url, reason: `not-image (${contentType || 'no content-type'})` }); return false; }
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength < 20 * 1024) return false; // < 20KB -> rác
        fs.writeFileSync(savePath, Buffer.from(buffer));
        success = true;
        return true;
    } catch (e) {
        if (e.name !== 'AbortError') logCrawlError({ source: 'Bing/download', keyword, url, reason: e.message });
        else logCrawlError({ source: 'Bing/download', keyword, url, reason: 'timeout 15s' });
    } finally {
        if (!success) { try { fs.unlinkSync(savePath); } catch (_) {} }
    }
    return false;
}

export async function fetchFromBingImageBot(keyword, type, targetDir, neededCount) {
    if (type === 'video') return 0;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // Dùng endpoint /images/async (AJAX mà trình duyệt gọi thật) thay vì /images/search.
    // Trang /images/search no-JS bị Bing "nới lỏng truy vấn" -> trả ảnh chệch ngữ cảnh
    // (vd "ドーハの悲劇 日本サッカー" ra ảnh du lịch Doha). /images/async khớp đúng full query.
    const count = Math.max(35, neededCount * 3);
    const searchUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(keyword)}&first=1&count=${count}`;
    const headers = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };

    let downloaded = 0;
    console.log(`      [${keyword}][Bing IMG] Đang tìm: "${keyword}" | URL: ${searchUrl}`);
    logCrawlInfo({ source: 'Bing/search', keyword, url: searchUrl }); // ghi URL query vào file

    // Thử qua proxy (nếu bật USE_PROXY), lỗi thì fallback đi thẳng
    let html = '';
    const proxy = getRandomProxy();
    for (const attempt of (proxy ? ['proxy', 'direct'] : ['direct'])) {
        const dispatcher = attempt === 'proxy' ? proxy.dispatcher : undefined;
        const via = attempt === 'proxy' ? ` via ${proxy.server}` : '';
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(searchUrl, { headers, signal: controller.signal, dispatcher });
            clearTimeout(timeoutId);
            if (res.status !== 200) {
                // Log tường minh mã lỗi, vd 429
                logCrawlError({ source: 'Bing', keyword, url: searchUrl, reason: `HTTP ${res.status}${via}` });
                console.error(`      [${keyword}][Bing IMG] HTTP ${res.status}${via}`);
                continue; // thử cách tiếp theo
            }
            html = await res.text();
            break;
        } catch (e) {
            const reason = e.name === 'AbortError' ? 'timeout 20s' : e.message;
            logCrawlError({ source: 'Bing', keyword, url: searchUrl, reason: `${reason}${via}` });
            console.error(`      [${keyword}][Bing IMG] Lỗi tìm${via}: ${reason}`);
        }
    }
    if (!html) return 0;

    const urls = parseBingMurls(html);
    console.log(`      [${keyword}][Bing IMG] Tìm được ${urls.length} ảnh, đang tải...`);
    if (urls.length === 0) {
        logCrawlError({ source: 'Bing', keyword, url: searchUrl, reason: '0 ảnh (parse murl rỗng - có thể đổi cấu trúc HTML)' });
        return 0;
    }

    for (const u of urls) {
        if (downloaded >= neededCount) break;
        if (await downloadMedia(u, targetDir, keyword)) {
            downloaded++;
            logCrawlInfo({ source: 'Bing/ok', keyword, url: u }); // ghi URL ảnh tải được vào file
            console.log(`\x1b[36m      [${keyword}][Bing IMG] 📥 IMAGE bốc từ: ${u}\x1b[0m`);
            console.log(`      [${keyword}][Bing IMG] ---> Đã lấy ${downloaded}/${neededCount}`);
        }
    }
    return downloaded;
}
