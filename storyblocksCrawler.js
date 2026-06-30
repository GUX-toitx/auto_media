import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { claimNextStockPath } from './stockNaming.js';
import { logCrawlError } from './crawlLogger.js';

const SETTINGS_DIR = path.join(process.cwd(), 'setting');
const COUNTER_FILE = path.join(SETTINGS_DIR, 'current_index_storyblocks.txt');

const delay = ms => new Promise(res => setTimeout(res, ms));

// Xoay vòng Profile (giống dvidsCrawler) — đếm riêng cho Storyblocks
function getNextProfilePath(keyword) {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });

    const profiles = fs.readdirSync(SETTINGS_DIR)
        .filter(f => f.startsWith('chrome-profile-') && fs.statSync(path.join(SETTINGS_DIR, f)).isDirectory())
        .sort((a, b) => {
            const numA = parseInt(a.split('-').pop()) || 0;
            const numB = parseInt(b.split('-').pop()) || 0;
            return numA - numB;
        });

    if (profiles.length === 0) {
        console.error("      [Storyblocks Bot] ⚠️ Không tìm thấy profile nào trong /setting");
        return null;
    }

    let currentIndex = 0;
    if (fs.existsSync(COUNTER_FILE)) {
        currentIndex = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8')) || 0;
    }
    const nextIndex = currentIndex % profiles.length;
    const selectedProfile = profiles[nextIndex];
    fs.writeFileSync(COUNTER_FILE, (nextIndex + 1).toString(), 'utf8');

    console.log(`      [${keyword}][Storyblocks Bot] 🔄 Xoay vòng Profile: [${selectedProfile}]`);
    return path.join(SETTINGS_DIR, selectedProfile);
}

async function downloadMedia(url, targetDir, ext, keyword) {
    const savePath = claimNextStockPath(targetDir, ext);
    let success = false;

    try {
        const timeoutMs = ext === 'mp4' ? 180000 : 15000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.storyblocks.com/'
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) return false;

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (ext === 'mp4' && !contentType.includes('video')) return false;
        if (ext === 'jpg' && !contentType.includes('image')) return false;

        const buffer = await res.arrayBuffer();
        if (ext === 'mp4') {
            const sizeMB = buffer.byteLength / (1024 * 1024);
            if (sizeMB < 0.05) return false;        // < 50KB = rác
            if (sizeMB > 150) return false;         // > 150MB = bỏ
        } else if (ext === 'jpg' && buffer.byteLength < 5 * 1024) {
            return false;
        }

        fs.writeFileSync(savePath, Buffer.from(buffer));
        success = true;
        return true;
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error(`      [${keyword}][Storyblocks Tải] ${e.message}`);
            logCrawlError({ source: 'Storyblocks', keyword, url, reason: e.message });
        }
        return false;
    } finally {
        if (!success) {
            try { fs.unlinkSync(savePath); } catch (_) {}
        }
    }
}

export async function fetchFromStoryblocksBot(keyword, type, targetDir, neededCount) {
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    const searchPath = type === 'video' ? 'all-video' : 'all-images';
    const searchUrl = `https://www.storyblocks.com/${searchPath}/search/${encodeURIComponent(keyword)}?search-origin=search_bar`;

    console.log(`      [${keyword}][Storyblocks Bot] 🌐 Cào: ${searchUrl}`);

    const profilePath = getNextProfilePath(keyword);
    if (!profilePath) return 0;

    let context;
    try {
        context = await chromium.launchPersistentContext(profilePath, {
            headless: true,
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const page = context.pages()[0] || await context.newPage();

        // Tập hợp URL preview - thu từ 2 nguồn: network response + DOM
        const previewUrls = new Set();

        // Bắt mọi response chứa mp4 (preview thường được load lazy bởi JS)
        page.on('response', (response) => {
            try {
                const url = response.url();
                if (type === 'video' && /\.mp4(\?|$)/i.test(url)) {
                    previewUrls.add(url.split('?')[0]);
                } else if (type === 'image' && /storyblocks\.com.*\.(jpe?g|webp|png)/i.test(url)) {
                    previewUrls.add(url.split('?')[0]);
                }
            } catch (_) {}
        });

        // Chặn font/css để load nhanh (ảnh thì giữ lại để bắt URL ảnh)
        await page.route('**/*', (route) => {
            const rType = route.request().resourceType();
            if (rType === 'font' || rType === 'stylesheet') return route.abort();
            return route.continue();
        });

        try {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.log(`      [${keyword}][Storyblocks Bot] ⛔ Lỗi mở trang: ${e.message}`);
            return 0;
        }

        await delay(3000);

        // Scroll xuống để trigger lazy load thêm card
        for (let i = 0; i < 4 && previewUrls.size < neededCount * 3; i++) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
            await delay(1200);
        }

        // Quét thêm từ DOM phòng trường hợp response handler bỏ sót
        const domUrls = await page.evaluate((t) => {
            const urls = new Set();
            if (t === 'video') {
                document.querySelectorAll('video').forEach(v => {
                    if (v.src) urls.add(v.src);
                    const ds = v.getAttribute('data-src') || v.getAttribute('data-preview-src');
                    if (ds) urls.add(ds);
                    v.querySelectorAll('source').forEach(s => { if (s.src) urls.add(s.src); });
                });
                // Một số card lưu URL trong data-* attributes
                document.querySelectorAll('[data-mp4-url], [data-preview-mp4]').forEach(el => {
                    const u = el.getAttribute('data-mp4-url') || el.getAttribute('data-preview-mp4');
                    if (u) urls.add(u);
                });
            } else {
                document.querySelectorAll('img').forEach(img => {
                    const src = img.currentSrc || img.src;
                    if (src && /storyblocks/i.test(src)) urls.add(src);
                });
            }
            return [...urls];
        }, type).catch(() => []);

        for (const u of domUrls) {
            try { previewUrls.add(u.split('?')[0]); } catch (_) {}
        }

        // Lọc và loại trùng
        const list = [...previewUrls].filter(u => {
            if (!u || !u.startsWith('http')) return false;
            if (type === 'video') return /\.mp4/i.test(u);
            // Bỏ thumbnail siêu nhỏ — Storyblocks thumbnail thường có "small/_xs/_thumb"
            if (/-thumb|_xs|_small/i.test(u)) return false;
            return /\.(jpe?g|webp|png)/i.test(u);
        });

        console.log(`      [${keyword}][Storyblocks Bot] Bắt được ${list.length} preview URL`);

        for (const u of list) {
            if (downloaded >= neededCount) break;
            if (await downloadMedia(u, targetDir, ext, keyword)) {
                downloaded++;
                console.log(`\x1b[33m      [${keyword}][Storyblocks Bot] 📥 ${type.toUpperCase()} bốc từ: ${u}\x1b[0m`);
            }
        }
    } catch (error) {
        console.error(`      [${keyword}][Storyblocks Lỗi Tổng] ${error.message}`);
        logCrawlError({ source: 'Storyblocks/total', keyword, reason: error.message });
    } finally {
        if (context) await context.close().catch(() => {});
    }

    return downloaded;
}
