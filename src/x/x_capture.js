// Chụp ảnh card + quay màn hình 1 bài viết X, dùng profile Playwright đã login.
// Chạy: node x_capture.js --profile chrome-profile-4 --url <tweetUrl> --out <dir> [--name base] [--headless false]
// In stdout JSON: {"screenshot": "...png", "video": "...mp4", "url": "..."}
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

const SETTING_DIR = process.env.SETTING_DIR || path.join(process.env.HOME, '.cache', 'ms-playwright');
const getArg = (flag, def) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; };

const profileName = getArg('--profile', 'chrome-profile-x');
const url = getArg('--url');
const outDir = getArg('--out', '.');
const base = getArg('--name', 'tweet_' + String(url || '').split('/').pop().split('?')[0]);
const headless = getArg('--headless', 'true') !== 'false';

if (!url) { console.error('Thiếu --url'); process.exit(1); }
const profileDir = path.isAbsolute(profileName) ? profileName : path.join(SETTING_DIR, profileName);

(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const videoTmp = fs.mkdtempSync(path.join(outDir, '_vidtmp_'));
    const ctx = await chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: { width: 800, height: 1000 },
        args: ['--disable-blink-features=AutomationControlled'],
        recordVideo: { dir: videoTmp, size: { width: 800, height: 1000 } },
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    const result = { screenshot: null, video: null, url };
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const article = page.locator('article[data-testid="tweet"]').first();
        await article.waitFor({ state: 'visible', timeout: 30000 });
        await page.waitForTimeout(2500); // chờ ảnh/video trong tweet load

        const shotPath = path.join(outDir, base + '.png');
        await article.screenshot({ path: shotPath });
        result.screenshot = shotPath;

        // Quay: cuộn chậm qua bài + phần trả lời rồi về đầu
        for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 480); await page.waitForTimeout(850); }
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
        await page.waitForTimeout(800);
    } catch (e) {
        console.error('[x_capture] ' + e.message);
    }

    await ctx.close(); // flush video ra thư mục recordVideo
    try {
        const webmFile = fs.readdirSync(videoTmp).find(f => f.endsWith('.webm'));
        if (webmFile) {
            const webm = path.join(videoTmp, webmFile);
            const mp4 = path.join(outDir, base + '.mp4');
            execFileSync('ffmpeg', ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'ignore' });
            result.video = mp4;
        }
    } catch (e) { console.error('[x_capture] video: ' + e.message); }
    try { fs.rmSync(videoTmp, { recursive: true, force: true }); } catch (_) {}
    process.stdout.write(JSON.stringify(result));
})();
