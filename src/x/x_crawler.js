// Orchestrator cào X cho 1 project: cookies -> scrape (keyword JA + url) -> tải ảnh/video
// -> chụp ảnh + quay màn hình từng bài -> xuất manifest JSON để naze_content lưu vào DB.
//
// CLI test:
//   node x_crawler.js --profile chrome-profile-4 --out <dir> --keywords "尖閣諸島|海上保安庁" \
//        --urls "https://x.com/..." --limit 15 --max 8 --captureMax 3
//
// Dùng như module: import { crawlX } from '../x/x_crawler.js'
import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';

// Script anh em nằm cùng src/x → gọi bằng đường dẫn tuyệt đối (không phụ thuộc cwd).
// .venv và accounts.db vẫn ở gốc repo.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VENV_PY = path.join(ROOT, '.venv', 'bin', 'python');

function readCookies(profileName) {
    const out = execFileSync('node', [path.join(HERE, 'x_cookies.js'), profileName], { encoding: 'utf8' });
    const j = JSON.parse(out);
    return `auth_token=${j.auth_token}; ct0=${j.ct0}`;
}

// Danh sách profile dùng cho pool twscrape. Nhiều profile = nhiều account = throttle nhân lên
// (X giới hạn ~50 request/15 phút cho MỖI account trên endpoint SearchTimeline).
//   .env:  X_PROFILES=chrome-profile-4,chrome-profile-6      (ưu tiên)
//          X_PROFILE=chrome-profile-4                        (cũ, vẫn chạy)
export function listXProfiles(profileName) {
    const raw = process.env.X_PROFILES || profileName || process.env.X_PROFILE || 'chrome-profile-4';
    return [...new Set(String(raw).split(',').map(s => s.trim()).filter(Boolean))];
}

// Đọc cookie của MỌI profile -> [{name, cookies}]. Profile nào chưa đăng nhập X thì bỏ qua (cảnh báo).
export function collectAccounts(profileName) {
    const accs = [];
    for (const p of listXProfiles(profileName)) {
        try {
            accs.push({ name: p, cookies: readCookies(p) });
        } catch (e) {
            console.warn(`[x_crawler] bỏ qua profile "${p}": ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
        }
    }
    return accs;
}

// Chạy scrape. Cookie đưa qua STDIN (không qua argv) -> không lộ trong `ps`.
// timeoutMs: gặp rate-limit twscrape sẽ CHỜ tới lúc reset (có thể 15 phút+) -> cắt sớm để pipeline không treo.
function runScrape(accounts, { keywords = '', urls = '', users = '', limit = 15, db = path.join(ROOT, 'accounts.db'), timeoutMs = 90000 }) {
    if (!accounts.length) throw new Error('không có account X nào khả dụng (kiểm tra X_PROFILES / đăng nhập lại)');
    const args = [path.join(HERE, 'x_scrape.py'), '--accounts-stdin', '--limit', String(limit), '--db', db];
    if (keywords) args.push('--search', keywords);
    if (urls) args.push('--urls', urls);
    if (users) args.push('--users', users);
    const r = spawnSync(VENV_PY, args, {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        input: JSON.stringify(accounts), timeout: timeoutMs,
    });
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error && r.error.code === 'ETIMEDOUT') {
        console.warn(`[x_crawler] scrape quá ${Math.round(timeoutMs / 1000)}s (nhiều khả năng dính rate-limit) → bỏ qua`);
        return [];
    }
    if (r.status !== 0) throw new Error('x_scrape.py exit ' + r.status);
    return JSON.parse(r.stdout || '[]');
}

async function download(url, dest) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return buf.length;
}

function capture(profileName, url, outDir, base) {
    const r = spawnSync('node', [path.join(HERE, 'x_capture.js'), '--profile', profileName, '--url', url, '--out', outDir, '--name', base],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 150000 });
    if (r.stderr) process.stderr.write(r.stderr);
    try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}

// Cào X -> trả về manifest [{id,url,user,date,text, images[], videos[], screenshot, recording}]
export async function crawlX({ profileName, outDir, keywords = '', urls = '', users = '', limit = 15, max = 8, captureMax = 3, maxImages = Infinity, maxVideos = Infinity, scrapeTimeoutMs = 90000 }) {
    const accounts = collectAccounts(profileName);
    const scrapedRaw = runScrape(accounts, { keywords, urls, users, limit, timeoutMs: scrapeTimeoutMs });
    // Bản ghi nhẹ MỌI tweet "lướt qua" (trước khi cắt còn `max`) — để log ra cho người xem biết
    // đã duyệt những bài nào, dù có dùng hay không. Đếm ảnh/video thay vì giữ nguyên object nặng.
    const scraped = (scrapedRaw || []).map(t => ({
        id: t.id, url: t.url, user: t.user, date: t.date, text: t.text || '',
        images: (t.media || []).filter(m => m.type === 'photo').length,
        videos: (t.media || []).filter(m => m.type === 'video').length,
    }));
    // GIỮ NGUYÊN THỨ TỰ XẾP HẠNG của X (tab Top = liên quan nhất) — chỉ ĐẨY tweet có media lên trước
    // tweet không media (ổn định, không xáo trộn nội bộ). Trước đây sort theo SỐ media giảm dần khiến
    // bài "nhiều media" (thread/tổng hợp/spam) luôn được tải trước → video tải về KHÁC hẳn kết quả tự search.
    const hasMedia = (t) => (t.media?.length || 0) > 0;
    let tweets = [...scrapedRaw.filter(hasMedia), ...scrapedRaw.filter(t => !hasMedia(t))];
    tweets = tweets.slice(0, max);

    const dirs = {
        images: path.join(outDir, 'images'),
        videos: path.join(outDir, 'videos'),
        shots: path.join(outDir, 'shots'),
        recs: path.join(outDir, 'recordings'),
    };
    Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));

    const manifest = [];
    let captured = 0;
    let totImg = 0, totVid = 0;   // tổng ảnh/video đã tải — để dừng khi đạt maxImages/maxVideos
    for (const t of tweets) {
        // Đủ chỉ tiêu cả ảnh lẫn video → dừng sớm (khỏi tải/chụp thêm)
        if (totImg >= maxImages && totVid >= maxVideos) break;
        const rec = { id: t.id, url: t.url, user: t.user, date: t.date, text: t.text, images: [], videos: [], screenshot: null, recording: null };
        let mi = 0, vi = 0;
        for (const m of (t.media || [])) {
            try {
                if (m.type === 'photo') {
                    if (totImg >= maxImages) continue;   // đủ ảnh rồi → bỏ qua
                    const dest = path.join(dirs.images, `x_${t.id}_${mi++}.jpg`);
                    await download(m.url, dest); rec.images.push(dest); totImg++;
                } else if (m.type === 'video') {
                    if (totVid >= maxVideos) continue;   // đủ video rồi → bỏ qua
                    const dest = path.join(dirs.videos, `x_${t.id}_${vi++}.mp4`);
                    await download(m.url, dest); rec.videos.push(dest); totVid++;
                }
            } catch (e) { console.error(`[x_crawler] tải media ${t.id}: ${e.message}`); }
        }
        if (captured < captureMax) {
            const cap = capture(profileName, t.url, outDir, `x_${t.id}`);
            if (cap.screenshot) { rec.screenshot = cap.screenshot; }
            if (cap.recording === undefined && cap.video) rec.recording = cap.video;
            else if (cap.video) rec.recording = cap.video;
            captured++;
        }
        manifest.push(rec);
        console.log(`[x_crawler] ${t.user}: ${rec.images.length} ảnh, ${rec.videos.length} video${rec.screenshot ? ', +chụp' : ''}${rec.recording ? ', +quay' : ''}`);
    }
    const manifestPath = path.join(outDir, 'x_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { manifest, manifestPath, count: manifest.length, scraped };
}

// CLI
if (process.argv[1]?.endsWith('x_crawler.js')) {
    const a = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
    const res = await crawlX({
        profileName: a('--profile', 'chrome-profile-4'),
        outDir: a('--out', './_x_out'),
        keywords: a('--keywords', ''),
        urls: a('--urls', ''),
        limit: parseInt(a('--limit', '15')),
        max: parseInt(a('--max', '8')),
        captureMax: parseInt(a('--captureMax', '3')),
    });
    console.log(`\n✅ Xong: ${res.count} bài. Manifest: ${res.manifestPath}`);
    process.exit(0);
}
