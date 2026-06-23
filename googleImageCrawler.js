import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { claimNextStockPath } from './stockNaming.js';

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(res => setTimeout(res, ms));

// Load proxies từ file, xoay vòng
const PROXY_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'proxies.txt');
let _proxies = null;
let _proxyIndex = 0;
function getNextProxy() {
    if (!_proxies) {
        try {
            _proxies = fs.readFileSync(PROXY_FILE, 'utf8').trim().split('\n')
                .map(l => l.trim()).filter(Boolean)
                .map(l => { const [host, port, user, pass] = l.split(':'); return { host, port, user, pass }; })
                .filter(p => p.host && p.port);
            console.log(`[Proxy] Loaded ${_proxies.length} proxies`);
        } catch (_) { _proxies = []; }
    }
    if (!_proxies.length) return null;
    const proxy = _proxies[_proxyIndex % _proxies.length];
    _proxyIndex++;
    return proxy;
}

async function downloadMedia(url, targetDir, ext, keyword = '') {
    if (url.includes('onelink.me') || url.includes('app-store') || url.includes('play.google')) return false;
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
    ];
    if (blockDomains.some(d => url.toLowerCase().includes(d))) return false;

    const savePath = claimNextStockPath(targetDir, ext);
    let success = false;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            if (ext === 'jpg' && !contentType.includes('image')) return false;
            const buffer = await res.arrayBuffer();
            if (ext === 'jpg' && buffer.byteLength < 20 * 1024) return false; // < 20KB -> rác
            fs.writeFileSync(savePath, Buffer.from(buffer));
            success = true;
            return true;
        }
    } catch (e) {
        if (e.name !== 'AbortError') console.error(`      [${keyword}][Lỗi Tải] ${url} - ${e.message}`);
    } finally {
        if (!success) { try { fs.unlinkSync(savePath); } catch (_) {} }
    }
    return false;
}

export async function fetchFromGoogleImageBot(keyword, type, targetDir, neededCount) {
    if (type === 'video') return 0;
    let downloaded = 0;
    const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(keyword)}&safesearch=off&qft=+filterui:photo-photo`;

    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const proxy = getNextProxy();
        const browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'];
        if (proxy) browserArgs.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);

        const browser = await puppeteer.launch({ headless: 'new', args: browserArgs });
        try {
            const page = await browser.newPage();
            if (proxy?.user) await page.authenticate({ username: proxy.user, password: proxy.pass });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');

            console.log(`      [${keyword}][Web IMAGE Bot] Đang thâm nhập Bing${proxy ? ' via ' + proxy.host : ''}: ${keyword}`);
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.evaluate(() => window.scrollBy(0, 1000));
            await delay(2500);

            const html = await page.content();
            const $ = cheerio.load(html);
            let mediaUrls = [];
            $('a.iusc').each((i, el) => {
                const mData = $(el).attr('m');
                if (mData) { try { const p = JSON.parse(mData); if (p.murl) mediaUrls.push(p.murl); } catch(_) {} }
            });
            console.log(`      [${keyword}] iusc count: ${mediaUrls.length}`);

            if (mediaUrls.length < 5) {
                console.log(`      [${keyword}] Ít kết quả (${mediaUrls.length}), thử proxy khác...`);
                await browser.close().catch(() => {});
                continue;
            }

            mediaUrls = [...new Set(mediaUrls)];
            for (const url of mediaUrls) {
                if (downloaded >= neededCount) break;
                if (await downloadMedia(url, targetDir, 'jpg', keyword)) {
                    downloaded++;
                    console.log(`\x1b[33m      [${keyword}][Web IMAGE Bot] 📥 IMAGE bốc từ: ${url}\x1b[0m`);
                    console.log(`      [${keyword}][Web IMAGE Bot] ---> Đã lấy thành công ${downloaded}/${neededCount}`);
                }
            }
            break; // thành công
        } catch (e) {
            console.error(`      [${keyword}][Web Lỗi Tổng] ${e.message}`);
        } finally {
            await browser.close().catch(() => {});
        }
    }
    return downloaded;
}
