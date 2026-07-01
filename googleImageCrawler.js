import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
// File: googleImageCrawler.js (Bản 4.0 - Ảnh từ Google Images qua google-img-scrap, thay Bing)
import fs from 'fs';
import proxyChain from 'proxy-chain';
import { getOldestProxy } from './proxyManager.js';
import { claimNextStockPath } from './stockNaming.js';
import { logCrawlError, logCrawlInfo } from './crawlLogger.js';
import googleImgScrap from 'google-img-scrap';
const { GOOGLE_IMG_SCRAP } = googleImgScrap;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Giảm nhịp: serialize TOÀN CỤC các call google-img-scrap + giãn cách tối thiểu để tránh Google chặn
const GI_MIN_GAP = 2500;
let _giChain = Promise.resolve();
let _giLast = 0;
function throttledScrap(config) {
    const run = async () => {
        const wait = GI_MIN_GAP - (Date.now() - _giLast);
        if (wait > 0) await sleep(wait);
        try { return await GOOGLE_IMG_SCRAP(config); }
        finally { _giLast = Date.now(); }
    };
    const p = _giChain.then(run, run);   // nối đuôi -> chạy lần lượt
    _giChain = p.catch(() => {});
    return p;
}

// Scrape có retry; từ lần 2 dùng PROXY XOAY VÒNG (bọc proxyChain để chromium dùng proxy có auth)
async function scrapImages(keyword, limit, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let anon = null, proxyArg;
        try {
            if (attempt >= 2) {
                const px = await getOldestProxy().catch(() => null);
                if (px && px.server) {
                    const authUrl = px.server.replace('http://', `http://${px.username}:${px.password}@`);
                    try { anon = await proxyChain.anonymizeProxy(authUrl); proxyArg = anon; } catch (_) {}
                }
            }
            const res = await throttledScrap({ search: keyword, limit, ...(proxyArg ? { proxy: proxyArg } : {}) });
            const result = res?.result || [];
            if (result.length) return result;
            console.log(`      [${keyword}][GoogleImage] lần ${attempt} rỗng${proxyArg ? ' (proxy)' : ''}, thử lại...`);
        } catch (e) {
            console.error(`      [${keyword}][GoogleImage] lần ${attempt} lỗi: ${e.message}`);
            logCrawlError({ source: 'Google Image/scrape', keyword, reason: `lần ${attempt}: ${e.message}` });
        } finally {
            if (anon) await proxyChain.closeAnonymizedProxy(anon, true).catch(() => {});
        }
        await sleep(1500 * attempt);
    }
    return [];
}

async function downloadMedia(url, targetDir, ext, proxy = null, keyword = '', source = '') {
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) {
        logCrawlError({ source: 'Google Image', keyword, url, reason: 'bỏ qua url app-store/onelink' });
        return false;
    }

    const savePath = claimNextStockPath(targetDir, ext, source || url);   // lưu trang nguồn (hoặc URL ảnh) làm tag
    let success = false;

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
            success = true;
            return true;
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
             console.error(`      [${keyword}][Bing Lỗi Tải File] URL: ${url} - ${e.message}`);
             logCrawlError({ source: 'Google Image/download', keyword, url, reason: e.message });
        } else {
             logCrawlError({ source: 'Google Image/download', keyword, url, reason: 'timeout 15s' });
        }
    } finally {
        if (!success) {
            try { fs.unlinkSync(savePath); } catch (_) {}
        }
    }
    return false;
}

export async function fetchFromGoogleImageBot(keyword, type, targetDir, neededCount) {
    // Chỉ ảnh — dùng Google Images (google-img-scrap) thay cho Bing. Video không hỗ trợ ở provider này.
    if (type === 'video') return 0;

    let downloaded = 0;
    const ext = 'jpg';
    logCrawlInfo({ source: 'Google Image/search', keyword, note: `cần ${neededCount} ảnh` });

    let images = [];
    // lấy dư (x3) để bù ảnh tải lỗi; giữ originalUrl (trang nguồn) để gắn tag
    const result = await scrapImages(keyword, Math.max(neededCount * 3, 20));
    const seen = new Set();
    for (const r of result) {
        if (!r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        const src = (r.originalUrl || r.url).replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&').replace(/\\u003f/gi, '?').replace(/\\\//g, '/');
        images.push({ url: r.url, source: src });
    }

    if (!images.length) {
        console.log(`      [${keyword}][GoogleImage] ⚠️ Không thấy ảnh.`);
        logCrawlError({ source: 'Google Image', keyword, reason: '0 ảnh (scrape rỗng - có thể Google chặn/429)' });
        return 0;
    }
    console.log(`      [${keyword}][GoogleImage] Tìm thấy ${images.length} ảnh. Đang tải...`);

    for (const { url, source } of images) {
        if (downloaded >= neededCount) break;
        if (await downloadMedia(url, targetDir, ext, null, keyword, source)) {
            downloaded++;
            logCrawlInfo({ source: 'Google Image/ok', keyword, url: source });
            console.log(`\x1b[33m      [${keyword}][GoogleImage] 📥 ${downloaded}/${neededCount} <- ${source.slice(0, 70)}\x1b[0m`);
        }
    }
    return downloaded;
}