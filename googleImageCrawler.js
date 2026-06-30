import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { claimNextStockPath } from './stockNaming.js';
import { logCrawlError } from './crawlLogger.js';
import { getRandomProxy } from './proxyPool.js';

const require = createRequire(import.meta.url);
const { GOOGLE_IMG_SCRAP } = require('google-img-scrap');
const { Impit } = require('impit');

// Khi không có ảnh, gọi lại Google (bằng impit như library) để biết mã lỗi thật (vd 429)
async function probeGoogleStatus(keyword, proxyUri) {
    try {
        const url = `https://www.google.com/search?tbm=isch&udm=2&q=${encodeURIComponent(keyword)}`;
        const impit = new Impit({ browser: 'chrome', proxyUrl: proxyUri || undefined, ignoreTlsErrors: true, followRedirects: true, timeout: 20000, maxRedirects: 5 });
        const res = await impit.fetch(url);
        const body = await res.text().catch(() => '');
        const blocked = /unusual traffic|recaptcha|\/sorry\//i.test(body);
        return { status: res.status, blocked };
    } catch (e) { return { status: null, blocked: false, err: e.message }; }
}

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

async function downloadMedia(url, targetDir, keyword = '') {
    if (!url) return false;
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) return false;
    if (blockDomains.some(d => url.toLowerCase().includes(d))) return false;

    const savePath = claimNextStockPath(targetDir, 'jpg');
    let success = false;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            if (!contentType.includes('image')) return false;
            const buffer = await res.arrayBuffer();
            if (buffer.byteLength < 20 * 1024) return false; // < 20KB -> rác
            fs.writeFileSync(savePath, Buffer.from(buffer));
            success = true;
            return true;
        }
    } catch (e) {
        if (e.name !== 'AbortError') { console.error(`      [${keyword}][Lỗi Tải] ${url} - ${e.message}`); logCrawlError({ source: 'Google Image', keyword, url, reason: e.message }); }
    } finally {
        if (!success) { try { fs.unlinkSync(savePath); } catch (_) {} }
    }
    return false;
}

export async function fetchFromGoogleImageBot(keyword, type, targetDir, neededCount) {
    if (type === 'video') return 0;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    let downloaded = 0;
    console.log(`      [${keyword}][Google IMG Scrap] Đang tìm: "${keyword}"`);

    const proxy = getRandomProxy();
    try {
        const result = await GOOGLE_IMG_SCRAP({ search: keyword, limit: neededCount * 3, proxy: proxy?.uri });
        const images = result.result || [];
        console.log(`      [${keyword}] Tìm được ${images.length} ảnh, đang tải...`);

        // 0 ảnh -> probe để biết mã lỗi thật (vd 429 do Google chặn) và log tường minh
        if (images.length === 0) {
            const probe = await probeGoogleStatus(keyword, proxy?.uri);
            const via = proxy ? ` via ${proxy.server}` : '';
            const reason = probe.status === 429
                ? `HTTP 429 (Google chặn - unusual traffic)${via}`
                : probe.blocked
                    ? `bị chặn (captcha/unusual traffic), HTTP ${probe.status}${via}`
                    : `0 ảnh, HTTP ${probe.status ?? 'N/A'}${probe.err ? ' - ' + probe.err : ''}${via}`;
            console.error(`      [${keyword}][Google IMG] ${reason}`);
            logCrawlError({ source: 'Google Image', keyword, reason });
        }

        for (const img of images) {
            if (downloaded >= neededCount) break;
            if (!img.url) continue;
            if (await downloadMedia(img.url, targetDir, keyword)) {
                downloaded++;
                console.log(`\x1b[33m      [${keyword}][Google IMG Scrap] 📥 IMAGE bốc từ: ${img.url}\x1b[0m`);
                console.log(`      [${keyword}][Google IMG Scrap] ---> Đã lấy thành công ${downloaded}/${neededCount}`);
            }
        }
    } catch (e) {
        console.error(`      [${keyword}][Google IMG Scrap Lỗi] ${e.message}`);
        logCrawlError({ source: 'Google Image/scrape', keyword, reason: e.message });
    }

    return downloaded;
}
