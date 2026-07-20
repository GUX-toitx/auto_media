import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'fs';
import { exec } from 'child_process';
import util from 'util';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { fetchIPv4 as fetch } from '../lib/fetchIPv4.js';
import { claimNextStockPath } from '../lib/stockNaming.js';

const execPromise = util.promisify(exec);

puppeteer.use(StealthPlugin());
const delay = ms => new Promise(r => setTimeout(r, ms));

const VN_SOURCES = [
    {
        name: 'VnExpress',
        search: kw => `https://timkiem.vnexpress.net/?q=${encodeURIComponent(kw)}`,
        waitUntil: 'networkidle2',
        waitMs: 5000,
        selector: '#result_search a[href], .item-news a[href], article a[href]',
        articlePattern: /vnexpress\.net\/[a-z][a-z0-9-]+-\d+\.html$/,
        exclude: /box_comment|\/author\/|\/tag\/|\/topic\//,
        imgSelector: '.sidebar-1 img, .fck_detail img',
    },
    {
        name: 'Thanh Niên',
        search: kw => `https://thanhnien.vn/tim-kiem.htm?keywords=${encodeURIComponent(kw)}`,
        waitUntil: 'domcontentloaded',
        waitMs: 5000,
        selector: 'a[href]',
        articlePattern: /thanhnien\.vn\/[a-z][a-z0-9-]+-\d+\.htm$/,
        exclude: /banggia\.|datbao\.|my\.|tien-ich|thoi-tiet|lien-he|ban-can-biet|tags|tim-kiem|tin-nhanh|chu-de|video\.|trang-|topic/,
        imgSelector: '.detail__image-main img, .detail__body img',
        imgExclude: /ava_inter|logo|avatar/,
    },
    {
        name: 'Dân Trí',
        search: kw => `https://dantri.com.vn/tim-kiem/${encodeURIComponent(kw.toLowerCase()).replace(/%20/g, '+').replace(/%[A-F0-9]{2}/g, m => m.toLowerCase())}.htm`,
        waitUntil: 'networkidle2',
        waitMs: 5000,
        selector: 'a[href]',
        articlePattern: /dantri\.com\.vn\/[a-z][a-z0-9-\/]+-\d{14,}\.htm/,
        exclude: /\/event\/|\/collection\/|\/tag\/|tim-kiem/,
        intermediatePattern: /dantri\.com\.vn\/event\/[a-z][a-z0-9-]+-\d+\.htm/,
        imgSelector: 'article img, .dt-news__body img',
    },
];

const globalDownloaded = new Set();

async function downloadMedia(url, targetDir, ext, downloaded) {
    if (downloaded.has(url)) return false;
    const savePath = claimNextStockPath(targetDir, ext);
    let success = false;

    // HLS stream
    if (ext === 'mp4' && url.includes('.m3u8')) {
        try {
            console.log(`      [VN] 🎥 HLS stream, dùng ffmpeg: ${url}`);
            await execPromise(`ffmpeg -y -headers "Referer: https://vnexpress.net/" -i "${url}" -c copy -bsf:a aac_adtstoasc "${savePath}"`, { timeout: 300000 });
            if (fs.existsSync(savePath) && fs.statSync(savePath).size > 100 * 1024) {
                downloaded.add(url);
                return true;
            }
        } catch (e) {
            console.error(`      [VN] ffmpeg lỗi: ${e.message.split('\n').slice(0,2).join(' ')}`);
        }
        try { fs.unlinkSync(savePath); } catch (_) {}
        return false;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ext === 'mp4' ? 120000 : 15000);
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vnexpress.net/' }, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) return false;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ext === 'jpg' && !ct.includes('image')) return false;
        if (ext === 'mp4' && !ct.includes('video')) return false;
        const buf = await res.arrayBuffer();
        if (ext === 'jpg' && buf.byteLength < 10 * 1024) return false;
        if (ext === 'mp4' && buf.byteLength < 100 * 1024) return false;
        if (ext === 'mp4' && buf.byteLength > 50 * 1024 * 1024) return false;
        fs.writeFileSync(savePath, Buffer.from(buf));
        downloaded.add(url);
        success = true;
        return true;
    } catch (e) { console.error(`[VN catch] ${e.message}`); }
    finally { if (!success) { try { fs.unlinkSync(savePath); } catch (_) {} } }
    return false;
}

async function crawlSource(source, keyword, vFolder, iFolder, neededVideo, neededImage, downloaded) {
    let dlVideo = 0, dlImage = 0;
    const searchUrl = source.search(keyword);
    console.log(`      [${keyword}][${source.name}] Đang tìm: ${searchUrl}`);

    // Không dùng proxy - báo VN cần truy cập trực tiếp
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', req => {
            const rt = req.resourceType();
            if (['stylesheet', 'font'].includes(rt)) return req.abort();
            req.continue();
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

        try {
            await page.goto(searchUrl, { waitUntil: source.waitUntil, timeout: 30000 });
        } catch (e) {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        await delay(source.waitMs);

        let articleLinks = await page.evaluate((selector, pattern, exclude) => {
            return [...new Set(
                Array.from(document.querySelectorAll(selector))
                    .map(a => a.href)
                    .filter(h => new RegExp(pattern).test(h) && (!exclude || !new RegExp(exclude).test(h)))
            )];
        }, source.selector, source.articlePattern.source, source.exclude?.source || null);

        // Bước trung gian: Dân Trí search -> event page -> bài viết
        if (!articleLinks.length && source.intermediatePattern) {
            const eventLinks = await page.evaluate((pattern) => {
                return [...new Set(
                    Array.from(document.querySelectorAll('a[href]'))
                        .map(a => a.href)
                        .filter(h => new RegExp(pattern).test(h))
                )].slice(0, 3);
            }, source.intermediatePattern.source);

            for (const eventLink of eventLinks) {
                try {
                    await page.goto(eventLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
                    await delay(2000);
                    const links = await page.evaluate((pattern, exclude) => {
                        return [...new Set(
                            Array.from(document.querySelectorAll('a[href]'))
                                .map(a => a.href)
                                .filter(h => new RegExp(pattern).test(h) && (!exclude || !new RegExp(exclude).test(h)))
                        )];
                    }, source.articlePattern.source, source.exclude?.source || null);
                    articleLinks.push(...links);
                } catch (e) { console.error(`[VN catch] ${e.message}`); }
            }
            articleLinks = [...new Set(articleLinks)];
        }

        const uniqueLinks = articleLinks.slice(0, 15);
        console.log(`      [${keyword}][${source.name}] Tìm thấy ${uniqueLinks.length} bài`);
        if (!uniqueLinks.length) return { dlVideo: 0, dlImage: 0 };

        for (const link of uniqueLinks) {
            if (dlVideo >= neededVideo && dlImage >= neededImage) break;
            try {
                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await delay(1500);
                // Scroll để trigger lazy load ảnh
                await page.evaluate(() => {
                    window.scrollTo(0, 300);
                    setTimeout(() => window.scrollTo(0, document.body.scrollHeight / 2), 300);
                    setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 600);
                });
                await delay(1500);
                const rawHtml = await page.content();

                // --- IMAGE ---
                if (dlImage < neededImage) {
                    const imgUrls = [];
                    let m;
                    // Lấy ảnh từ selector cụ thể của từng source
                    const imgSrcs = await page.evaluate((sel, excl) => {
                        const urls = [];
                        document.querySelectorAll(sel).forEach(img => {
                            const src = img.src || img.dataset.src || img.dataset.original
                                || img.getAttribute('data-src') || img.getAttribute('data-original');
                            if (src && src.startsWith('http') && !src.includes('data:') && !src.includes('.gif')
                                && src.match(/\.(?:jpg|jpeg|png|webp)/i)
                                && !src.match(/logo|icon|avatar|banner|ads|sprite|thumb_small/i)) {
                                if (!excl || !new RegExp(excl).test(src)) urls.push(src);
                            }
                        });
                        return [...new Set(urls)];
                    }, source.imgSelector || 'article img', source.imgExclude?.source || null);
                    imgUrls.push(...imgSrcs);
                    // og:image fallback nếu không có ảnh từ selector
                    if (!imgUrls.length) {
                        const ogMatch = rawHtml.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
                            || rawHtml.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
                        if (ogMatch) imgUrls.push(ogMatch[1]);
                    }
                    // Dedup: filename làm key để i1/i2 server không bị dedup nhầm
                    const seenBase = new Map();
                    for (const url of imgUrls) {
                        const filename = url.split('?')[0].split('/').pop();
                        if (!seenBase.has(filename)) {
                            seenBase.set(filename, url);
                        } else {
                            const prevW = parseInt(seenBase.get(filename).match(/[?&]w=(\d+)/)?.[1] || '0');
                            const curW = parseInt(url.match(/[?&]w=(\d+)/)?.[1] || '0');
                            if (curW > prevW) seenBase.set(filename, url);
                        }
                    }
                    // Lấy cookie từ browser để fetch ảnh CDN
                    const cookies = await page.cookies();
                    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    const referer = new URL(link).origin + '/';
                    for (const url of seenBase.values()) {
                        if (dlImage >= neededImage) break;
                        if (downloaded.has(url.split('?')[0].split('/').pop())) continue;
                        try {
                            const controller = new AbortController();
                            const tid = setTimeout(() => controller.abort(), 15000);
                            const res = await fetch(url, { headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                                'Referer': referer,
                                'Cookie': cookieStr,
                            }, signal: controller.signal });
                            clearTimeout(tid);
                            const ct = (res.headers.get('content-type') || '').toLowerCase();
                            if (!res.ok || !ct.includes('image')) continue;
                            const buf = await res.arrayBuffer();
                            if (buf.byteLength < 10 * 1024) continue;
                            const savePath = claimNextStockPath(iFolder, 'jpg');
                            fs.writeFileSync(savePath, Buffer.from(buf));
                            downloaded.add(url.split('?')[0].split('/').pop());
                            dlImage++;
                            console.log(`\x1b[36m      [${keyword}][${source.name}] ✅ image ${dlImage}/${neededImage} từ: ${link}\x1b[0m`);
                        } catch (e) { console.error(`[VN img] ${e.message}`); }
                    }
                }

                // --- VIDEO ---
                if (dlVideo < neededVideo) {
                    const videoUrls = [];
                    let m;
                    const mp4Regex = /https?:\/\/[^\s"'<>]+?\.mp4/gi;
                    while ((m = mp4Regex.exec(rawHtml)) !== null) videoUrls.push(m[0].replace(/\\/g, '').replace(/&amp;/g, '&'));
                    const m3u8Regex = /https?:\/\/[^\s"'<>]+?\.m3u8/gi;
                    const allM3u8 = [];
                    while ((m = m3u8Regex.exec(rawHtml)) !== null) allM3u8.push(m[0].replace(/\\/g, '').replace(/&amp;/g, '&'));
                    const qualityM3u8 = allM3u8.filter(u => u.match(/480p|720p|360p/));
                    const masterM3u8 = allM3u8.filter(u => u.includes('master'));
                    // Bỏ master nếu đã có quality cụ thể cùng video
                    const useMaster = masterM3u8.filter(mu => {
                        const videoId = mu.match(/\/([^/]+)\/vne\/master/)?.[1];
                        return !videoId || !qualityM3u8.some(q => q.includes(videoId));
                    });
                    // Dedup video theo base path (bỏ query)
                    const seenV = new Set();
                    const dedupedVideos = [];
                    for (const u of [...videoUrls, ...qualityM3u8, ...useMaster]) {
                        const base = u.split('?')[0];
                        if (!seenV.has(base)) { seenV.add(base); dedupedVideos.push(u); }
                    }
                    const contentUrlRegex = /"contentUrl"\s*:\s*"([^"]+\.(mp4|m3u8)[^"]*)"/g;
                    while ((m = contentUrlRegex.exec(rawHtml)) !== null) {
                        const base = m[1].split('?')[0];
                        if (!seenV.has(base)) { seenV.add(base); dedupedVideos.push(m[1]); }
                    }
                    for (const url of dedupedVideos) {
                        if (dlVideo >= neededVideo) break;
                        if (await downloadMedia(url, vFolder, 'mp4', downloaded)) {
                            dlVideo++;
                            console.log(`\x1b[36m      [${keyword}][${source.name}] ✅ video ${dlVideo}/${neededVideo} từ: ${link}\x1b[0m`);
                        }
                    }
                }
            } catch (e) { console.error(`[VN catch] ${e.message}`); }
        }
    } catch (e) {
        console.error(`      [${keyword}][${source.name} Lỗi] ${e.message}`);
    } finally {
        await browser.close();
    }
    return { dlVideo, dlImage };
}

export async function fetchFromVnBot(keyword, vFolder, iFolder, neededVideo, neededImage) {
    [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
    const downloaded = new Set();
    let totalVideo = 0, totalImage = 0;
    const perSourceVideo = Math.ceil(neededVideo / VN_SOURCES.length);
    const perSourceImage = Math.ceil(neededImage / VN_SOURCES.length);
    for (const source of VN_SOURCES) {
        try {
            const { dlVideo, dlImage } = await crawlSource(
                source, keyword, vFolder, iFolder,
                perSourceVideo,
                perSourceImage,
                downloaded
            );
            totalVideo += dlVideo;
            totalImage += dlImage;
        } catch (e) {
            console.error(`      [${source.name}] Lỗi: ${e.message}`);
        }
    }
    console.log(`   -> [VN] "${keyword}" xong: ${totalVideo} video, ${totalImage} image`);
    return { totalVideo, totalImage };
}
