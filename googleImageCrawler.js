import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
// File: googleImageCrawler.js (Bản 4.0 - Ảnh từ Google Images qua google-img-scrap, thay Bing)
import fs from 'fs';
import { claimNextStockPath } from './stockNaming.js';
import googleImgScrap from 'google-img-scrap';
const { GOOGLE_IMG_SCRAP } = googleImgScrap;

async function downloadMedia(url, targetDir, ext, proxy = null, keyword = '', source = '') {
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) {
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

    let images = [];
    try {
        // lấy dư (x3) để bù ảnh tải lỗi; giữ originalUrl (trang nguồn) để gắn tag
        const res = await GOOGLE_IMG_SCRAP({ search: keyword, limit: Math.max(neededCount * 3, 20) });
        const seen = new Set();
        for (const r of (res?.result || [])) {
            if (!r.url || seen.has(r.url)) continue;
            seen.add(r.url);
            const src = (r.originalUrl || r.url).replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&').replace(/\\u003f/gi, '?').replace(/\\\//g, '/');
            images.push({ url: r.url, source: src });
        }
    } catch (err) {
        console.error(`      [${keyword}][GoogleImage] Lỗi scrape: ${err.message}`);
        return 0;
    }

    if (!images.length) {
        console.log(`      [${keyword}][GoogleImage] ⚠️ Không thấy ảnh.`);
        return 0;
    }
    console.log(`      [${keyword}][GoogleImage] Tìm thấy ${images.length} ảnh. Đang tải...`);

    for (const { url, source } of images) {
        if (downloaded >= neededCount) break;
        if (await downloadMedia(url, targetDir, ext, null, keyword, source)) {
            downloaded++;
            console.log(`\x1b[33m      [${keyword}][GoogleImage] 📥 ${downloaded}/${neededCount} <- ${source.slice(0, 70)}\x1b[0m`);
        }
    }
    return downloaded;
}