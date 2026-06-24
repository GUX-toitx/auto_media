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
        // scribd & docs
        'scribd.com', 'scribdassets.com', 'slideshare.net', 'docplayer',
        // shopping / ecommerce
        'item-shopping.c.yimg.jp', 'shopping.yahoo.co.jp', 'amazon.', 'rakuten.',
        'mercari.', 'ebay.', 'aliexpress.', 'shopee.', 'lazada.',
        'kyoshin-k.co.jp', 'sologear', 'ledg_', 'ipros.jp',
        // science / medical / technical
        'spring8.or.jp', 'seikagaku.jbsoc', 'bpsbioscience.', 'netdekagaku.',
        'sooki.co.jp', 'fittertraining.com', 'weldinginfo.org', 'megmeet-welding.',
        'arccaptain.com', 'riselaser.net', 'thepipingmart.com', 'artizono.com',
        // indonesian food / unrelated
        'portalmadura.com', 'greatindonesia.com', 'gresiksatu.com', 'suara.com',
        'tourbanyuwangi.com', 'wisatarakyat.com', 'cdntap.com',
        // stock photo
        'deviantart.net', 'staticflickr.com', 'hippopx.com', 'pxhere.com', 'pixabay.com',
        'joeyblsphotography.com', 'photolibrary.jp', 'westend61.de',
        // travel / unrelated
        '4travel.jp', 'tripadvisor.com', 'media-cdn.tripadvisor',
        // random blog / unrelated
        'fc2.com', 'kyun2-girls.com', 'livedoor.blogimg', 'stampo.fun',
        'gkhub.in', 'gifsbuddy.com', 'tattooimprints.com', 'pngfre.com',
        'hitopedia.net', 'fantasytipsters.com', 'notrecinema.com',
        'billboard.com', 'vsthemes.org', 'entertainmentnow.com',
        'intechopen.com', 'europepmc.org', 'geocam.ru', 'astronomy.com',
        'slideplayer.com', 'prwarter.com', 'visualsp.com', 'netsolwater.com',
        // stock photo CDN
        'microcms-assets.io', 'pexels.com', 'unsplash.com',
        // travel / tourism
        'beautiful-photo.net', 'jnto.image', 'thetravelimages.com',
        'ctfassets.net', 'rurubu.jp', 'tabi-labo.com', 'retrip.jp',
        'klook.com', 'kkday.com', 'engoo.com', 'travel-zentech.jp',
        // auction
        'auctions.c.yimg.jp', 'auc-pctr.c.yimg.jp',
        // unrelated JP sites
        'kanji.reader.bz', 'haryu-korea.net', 'exblog.jp',
        'seesaa.net', 'ameba.jp', 'asayokonikki',
        // s3 / cdn random
        'all-stars-bucket.s3.amazonaws.com',
        // facebook
        'lookaside.fbsbx.com',
        // stadium shop
        'stadium-hub.com', 'shouf.io',
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
    const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(keyword)}&safesearch=off&qft=+filterui:photo-photo&setlang=ja&cc=jp&mkt=ja-JP`;

    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const proxy = getNextProxy();
        const browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'];
        if (proxy) browserArgs.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);

        const browser = await puppeteer.launch({ headless: false, args: browserArgs });
        try {
            const page = await browser.newPage();
            if (proxy?.user) await page.authenticate({ username: proxy.user, password: proxy.pass });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' });

            console.log(`      [${keyword}][Web IMAGE Bot] Đang thâm nhập Bing${proxy ? ' via ' + proxy.host : ''}: ${keyword}`);
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            console.log(`      [${keyword}][DEBUG] Page loaded, clearing and typing keyword...`);
            try {
                await page.waitForSelector('#sb_form_q', { timeout: 5000 });
                await page.click('#sb_form_q', { clickCount: 3 });
                await page.keyboard.press('Backspace');
                await page.type('#sb_form_q', keyword);
                console.log(`      [${keyword}][DEBUG] Keyword typed, clicking search button...`);
                await delay(500);
                await page.click('#sb_form_go');
                console.log(`      [${keyword}][DEBUG] Search submitted`);
            } catch(e) {
                console.log(`      [${keyword}][DEBUG] Could not submit search: ${e.message}`);
            }
            await delay(2500);
            await page.evaluate(() => window.scrollBy(0, 1000));
            await delay(2500);

            const html = await page.content();
            const $ = cheerio.load(html);
            let mediaUrls = [];
            $('li[data-idx] > div.iuscp > div.imgpt > a.iusc').each((i, el) => {
                const mData = $(el).attr('m');
                if (mData) { 
                    try { 
                        const p = JSON.parse(mData); 
                        if (p.murl) mediaUrls.push(p.murl); 
                    } catch(_) {} 
                }
            });

            if (mediaUrls.length < 5) {
                console.log(`      [${keyword}] Ít kết quả (${mediaUrls.length}), thử proxy khác...`);
                await browser.close().catch(() => {});
                continue;
            }

            mediaUrls = [...new Set(mediaUrls)];
            console.log(`      [${keyword}][DEBUG] Media URLs extracted (${mediaUrls.length}):`);
            mediaUrls.forEach((url, idx) => console.log(`        ${idx + 1}. ${url}`));
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
