import { fetchIPv4 as fetch } from './fetchIPv4.js';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { fetchFromStoryblocksBot } from './storyblocksCrawler.js';
import { fetchFromDvidsBot } from './dvidsCrawler.js';
import { fetchFromBellingcatBot } from './bellingcatCrawler.js';
import { fetchFromApnewsBot } from './apnewsCrawler.js';
import { fetchFromAlJazeeraBot } from './aljazeeraCrawler.js';
import { fetchFromGoogleImageBot } from './googleImageCrawler.js';
import { claimNextStockPath } from './stockNaming.js';

const MEDIA_DIR = process.env.MEDIA_DIR;
const DB_PATH = path.join(process.env.DB_DIR, 'media_system.sqlite');
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const VIDEOS_PER_SOURCE = 4;
const IMAGES_PER_SOURCE = 4;

const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==========================================
// HÀM TẢI FILE
// ==========================================
async function downloadFileHelper(url, targetDir, ext) {
    const savePath = claimNextStockPath(targetDir, ext);
    let success = false;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const size = res.headers.get('content-length');
            if (ext === 'mp4' && size && parseInt(size) > 35 * 1024 * 1024) return false;
            const buffer = await res.arrayBuffer();
            if (ext === 'mp4' && buffer.byteLength < 50 * 1024) return false;
            fs.writeFileSync(savePath, Buffer.from(buffer));
            success = true;
            return true;
        }
    } catch (e) {}
    finally { if (!success) { try { fs.unlinkSync(savePath); } catch (_) {} } }
    return false;
}

// ==========================================
// CÁC NGUỒN CRAWL
// ==========================================
async function fetchFromPexels(keyword, type, targetDir, neededCount) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('ĐIỀN_KEY')) return 0;
    let downloaded = 0;
    const ext = type === 'video' ? 'mp4' : 'jpg';
    const url = type === 'video'
        ? `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&per_page=${neededCount * 2}`
        : `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${neededCount * 2}`;
    try {
        const response = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
        if (!response.ok) return 0;
        const data = await response.json();
        const results = type === 'video' ? data.videos : data.photos;
        for (const item of (results || [])) {
            if (downloaded >= neededCount) break;
            let downloadUrl = null;
            if (type === 'video') {
                const hdVideo = item.video_files.sort((a, b) => (b.width || 0) - (a.width || 0)).find(v => (v.width || 0) <= 1920) || item.video_files[0];
                downloadUrl = hdVideo ? hdVideo.link : null;
            } else {
                downloadUrl = item.src.large;
            }
            if (downloadUrl) {
                const savePath = claimNextStockPath(targetDir, ext);
                let ok = false;
                try {
                    const res = await fetch(downloadUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                    if (res.ok) { fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer())); downloaded++; ok = true; }
                } catch (e) {}
                if (!ok) { try { fs.unlinkSync(savePath); } catch (_) {} }
            }
        }
    } catch (e) { console.log('Lỗi Pexels:', e.message); }
    return downloaded;
}

async function fetchFromPixabay(keyword, type, targetDir, neededCount) {
    if (!PIXABAY_API_KEY || PIXABAY_API_KEY.includes('ĐIỀN_KEY')) return 0;
    let downloaded = 0;
    const mediaType = type === 'video' ? 'videos/' : '';
    const url = `https://pixabay.com/api/${mediaType}?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(keyword)}&per_page=${Math.max(3, neededCount * 2)}&safesearch=true`;
    try {
        const response = await fetch(url);
        if (!response.ok) return 0;
        const data = await response.json();
        for (const item of (data.hits || [])) {
            if (downloaded >= neededCount) break;
            let downloadUrl = type === 'video' && item.videos ? (item.videos.large.url || item.videos.medium.url) : item.largeImageURL;
            if (downloadUrl && await downloadFileHelper(downloadUrl, targetDir, type === 'video' ? 'mp4' : 'jpg')) downloaded++;
        }
    } catch (e) { console.log('Lỗi Pixabay:', e.message); }
    return downloaded;
}

const withTimeout = (promise, ms, name) => {
    let timeoutId;
    const timeoutPromise = new Promise(resolve => {
        timeoutId = setTimeout(() => { console.log(`[TIMEOUT] Bot ${name} treo quá ${ms/1000}s`); resolve(0); }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

async function runConcurrently(tasks, limit) {
    const results = [];
    const executing = new Set();
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        results.push(p);
        const safeP = p.catch(() => {});
        executing.add(safeP);
        safeP.then(() => executing.delete(safeP));
        if (executing.size >= limit) await Promise.race(executing);
    }
    return Promise.allSettled(results);
}

async function fetchAndDownloadStock(keyword, type, targetDir, countPerSource = VIDEOS_PER_SOURCE) {
    if (!keyword) return 0;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const providers = [
        { name: 'Storyblocks (Bot)', fetcher: fetchFromStoryblocksBot },
        { name: 'Pexels', fetcher: fetchFromPexels },
        { name: 'DVIDS (Bot)', fetcher: fetchFromDvidsBot },
        { name: 'Bellingcat (Bot)', fetcher: fetchFromBellingcatBot },
        { name: 'AP News (Bot)', fetcher: fetchFromApnewsBot },
        { name: 'Al Jazeera (Bot)', fetcher: fetchFromAlJazeeraBot },
        { name: 'Google Image (Bot)', fetcher: fetchFromGoogleImageBot },
    ];

    console.log(`   -> [${type.toUpperCase()}] Tìm "${keyword}" | Mỗi nguồn: ${countPerSource}`);

    const tasks = providers.map(p => async () => {
        try {
            const got = await withTimeout(p.fetcher(keyword, type, targetDir, countPerSource), 300000, p.name);
            if (got > 0) console.log(`      [${p.name}] Tải được: ${got}/${countPerSource} ${type}`);
            return typeof got === 'number' ? got : 0;
        } catch (e) { console.log(`      [${p.name}] Lỗi: ${e.message}`); return 0; }
    });

    const results = await runConcurrently(tasks, 10);
    let total = 0;
    for (const r of results) if (r.status === 'fulfilled') total += (r.value || 0);
    console.log(`   -> [${type.toUpperCase()}] "${keyword}" xong: ${total} ${type}`);
    return total;
}

// ==========================================
// SYNC ASSET VÀO DB
// ==========================================
async function syncAssetsToDB(db, folderPath, assetType, paragraphId, sentenceId, projectId, gid) {
    const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    const validExts = assetType === 'video' ? videoExts : imageExts;
    const subDir = assetType === 'video' ? '_raw_videos' : '_raw_images';
    if (!fs.existsSync(folderPath)) return;
    const files = fs.readdirSync(folderPath).filter(f => f.startsWith('stock_') && validExts.has(path.extname(f).toLowerCase()));
    for (const file of files) {
        const relativePath = path.join(projectId, 'assets', subDir, gid, file);
        const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [relativePath]);
        if (!exists) {
            await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, ?, ?, ?)', [paragraphId, sentenceId || null, assetType, relativePath]);
            console.log(`      [SYNC] ${assetType} -> ${file}`);
        }
    }
}

// ==========================================
// MAIN - chạy loop liên tục
// ==========================================
async function main() {
    console.log('[sync-assets] Đã khởi động, đang chờ project mới...');
    while (true) {
        const db = await getDb();
        // Lấy các post có keyword image/video nhưng chưa có asset
        const paragraphsToProcess = await db.all(`
            SELECT DISTINCT para.id, para."order", p.project_id
            FROM Paragraph para
            JOIN Post p ON p.id = para.post_id
            JOIN Keyword k ON k.paragraph_id = para.id
            WHERE p.status IS NULL
            AND (
                NOT EXISTS (SELECT 1 FROM Asset a WHERE a.paragraph_id = para.id AND a.type = 'image')
                OR NOT EXISTS (SELECT 1 FROM Asset a WHERE a.paragraph_id = para.id AND a.type = 'video')
            )
            ORDER BY para.id ASC LIMIT 20
        `);

        if (paragraphsToProcess.length === 0) {
            await db.close();
            await sleep(30000);
            continue;
        }

        const byProject = {};
        for (const row of paragraphsToProcess) {
            if (!byProject[row.project_id]) byProject[row.project_id] = [];
            byProject[row.project_id].push(row);
        }

        for (const [projectId, paras] of Object.entries(byProject)) {
            for (const para of paras) {
                const gid = String(para.order);
                const kws = await db.all('SELECT content FROM Keyword WHERE paragraph_id = ?', [para.id]);
                if (!kws.length) continue;
                const keywords = kws.map(k => k.content);

                const hasImage = await db.get('SELECT id FROM Asset WHERE paragraph_id = ? AND type = ?', [para.id, 'image']);
                const hasVideo = await db.get('SELECT id FROM Asset WHERE paragraph_id = ? AND type = ?', [para.id, 'video']);

                const vFolder = path.join(MEDIA_DIR, projectId, 'assets', '_raw_videos', gid);
                const iFolder = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', gid);
                [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

                const mediaTasks = [];
                if (!hasVideo) for (const kw of keywords) mediaTasks.push(() => fetchAndDownloadStock(kw, 'video', vFolder, VIDEOS_PER_SOURCE));
                if (!hasImage) for (const kw of keywords) mediaTasks.push(() => fetchAndDownloadStock(kw, 'image', iFolder, IMAGES_PER_SOURCE));
                if (!mediaTasks.length) continue;

                let downloading = true;
                const liveSyncTask = async () => {
                    while (downloading) {
                        try {
                            await syncAssetsToDB(db, vFolder, 'video', para.id, null, projectId, gid);
                            await syncAssetsToDB(db, iFolder, 'image', para.id, null, projectId, gid);
                        } catch (_) {}
                        await sleep(2000);
                    }
                };
                const syncPromise = liveSyncTask();
                await runConcurrently(mediaTasks, 4);
                downloading = false;
                await syncPromise;

                await syncAssetsToDB(db, vFolder, 'video', para.id, null, projectId, gid);
                await syncAssetsToDB(db, iFolder, 'image', para.id, null, projectId, gid);
                await sleep(2000);
            }
            console.log(`[✓] Xong project: ${projectId}`);
        }

        await db.close();
        await sleep(5000);
    }
}

main().catch(e => console.error('LỖI:', e.message));
