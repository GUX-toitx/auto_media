import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import 'dotenv/config';

const CHROME_PATH = process.env.CUSTOM_CHROME === 'true'
    ? process.platform === 'win32'
        ? path.join(process.env.SETTING_DIR, 'chrome-win64', 'chrome.exe')
        : path.join(process.env.SETTING_DIR, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    : undefined;
const SETTING_DIR = process.env.SETTING_DIR || path.join(process.env.HOME, '.cache', 'ms-playwright');

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || '/usr/gux/media-team/db';

const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

async function getNextProfile() {
    const db = await getDb();
    const profile = await db.get('SELECT id, profile_dir, proxy FROM ChromeProfile ORDER BY updated_at ASC LIMIT 1');
    await db.close();
    if (!profile) return null;
    return { ...profile, profile_dir: path.join(SETTING_DIR, profile.profile_dir) };
}

async function markProfileUsed(id) {
    const db = await getDb();
    await db.run('UPDATE ChromeProfile SET updated_at = ? WHERE id = ?', [Date.now(), id]);
    await db.close();
}

function getRandomProxy() {
    const proxyFile = path.join(MEDIA_DIR, 'proxies.txt');
    if (!fs.existsSync(proxyFile)) return null;
    const lines = fs.readFileSync(proxyFile, 'utf8').trim().split('\n').filter(l => l.trim());
    if (!lines.length) return null;
    const [host, port, user, pass] = lines[Math.floor(Math.random() * lines.length)].split(':');
    return { server: `http://${host}:${port}`, username: user, password: pass };
}

export async function getBrowser(profileDir, proxy) {
    const userDataDir = profileDir || path.join(SETTING_DIR, 'chrome-profile');
    const resolvedProxy = proxy || getRandomProxy();
    const options = {
        executablePath: CHROME_PATH,
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 900 },
    };
    if (resolvedProxy) options.proxy = resolvedProxy;
    return chromium.launchPersistentContext(userDataDir, options);
}

export async function generateFlowImage(keyword, saveDirPath, content = '', type = 'image', count = 2, lang = 'en', customPrompt = '', ratio = '16:9', videoMode = 'Frames', veo = 'Fast', selectedImages = []) {
    const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
    let promptTemplate = customPrompt;
    if (!promptTemplate) {
        const promptFile = path.join(MEDIA_DIR, 'prompts', type, `prompt_flow_${lang}.txt`);
        const fallbackFile = path.join(MEDIA_DIR, 'prompts', type, 'prompt_flow.txt');
        const raw = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : fs.existsSync(fallbackFile) ? fs.readFileSync(fallbackFile, 'utf8') : '';
        promptTemplate = raw.trim().replace(/\n/g, ' ');
    }
    const fullPrompt = promptTemplate ? `${promptTemplate} ${content}` : content || keyword;
    if (!fs.existsSync(saveDirPath)) fs.mkdirSync(saveDirPath, { recursive: true });

    // Lấy profile có updated_at cũ nhất từ DB
    const profile = await getNextProfile();
    const profileDir = profile?.profile_dir || path.join(SETTING_DIR, 'chrome-profile');
    const profileId = profile?.id;

    const ctx = await getBrowser(profileDir, profile?.proxy);
    const page = ctx.pages()[0] || await ctx.newPage();

    try {
        // Vào Flow
        await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Nếu bị redirect về accounts.google.com (chọn account hoặc login)
        if (page.url().includes('accounts.google.com')) {
            console.log('[Flow] Đang xử lý xác thực Google...');

            // Thử click vào account đã đăng nhập (trang chọn account)
            const accountBtn = page.locator('li[data-authuser], div[data-email], [data-identifier]').first();
            if (await accountBtn.count()) {
                await accountBtn.click();
                console.log('[Flow] Đã chọn account');
            }

            // Chờ cho đến khi thoát khỏi accounts.google.com
            await page.waitForURL(url => !url.toString().includes('accounts.google.com'), { timeout: 120000 });
            await page.waitForTimeout(3000);
            console.log('[Flow] Xác thực xong, tiếp tục...');
        }

        // Nếu có nút add_2 thì click tạo project mới
        const newBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /add_2/ }).first();
        if (await newBtn.count()) {
            await newBtn.click();
            await page.waitForTimeout(8000);
            // Nếu xuất hiện confirm dialog tạo mới, click tiếp
            const createBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /add_2/ }).last();
            if (await createBtn.count() > 1) {
                await createBtn.click();
                await page.waitForTimeout(5000);
            }
        } else {
            // Landing page: click Create with Flow
            await page.locator('button').nth(0).click();
            await page.waitForURL(url => !url.toString().endsWith('/flow') && !url.toString().endsWith('/flow/'), { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(5000);
            console.log('[Flow] Đã vào tool từ landing page');
            // Chờ add_2 xuất hiện rồi click
            await page.waitForSelector('button i.google-symbols', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);
            const newBtnAfter = page.locator('button:has(i.google-symbols)').filter({ hasText: /add_2/ }).first();
            if (await newBtnAfter.count()) {
                await newBtnAfter.click();
                await page.waitForTimeout(8000);
            }
        }

        // Mở modal settings (button chứa cả ratio và count, ví dụ: "Videocrop_16_9x2")
        const settingsBtn = page.locator('button:visible').filter({ hasText: /x[1-4]$/ });
        if (await settingsBtn.count()) {
            await settingsBtn.first().click();
            await page.waitForTimeout(1000);

            // Chọn Image hoặc Video
            const typeBtn = page.locator('button[role=tab]', { hasText: type === 'video' ? 'Video' : 'Image' });
            if (await typeBtn.count()) await typeBtn.first().click();
            await page.waitForTimeout(300);

            // Chọn số lượng
            const countText = count === 1 ? '1x' : `x${count}`;
            const countBtn = page.locator('button[role=tab]', { hasText: countText });
            if (await countBtn.count()) await countBtn.first().click();
            await page.waitForTimeout(300);

            // Chọn khung hình
            const ratioBtn = page.locator('button[role=tab]', { hasText: ratio });
            if (await ratioBtn.count()) await ratioBtn.first().click();
            await page.waitForTimeout(300);

            // Video: chọn mode (Frames/Ingredients) và Veo
            if (type === 'video') {
                const modeBtn = page.locator('button[role=tab]', { hasText: videoMode });
                if (await modeBtn.count()) await modeBtn.first().click();
                await page.waitForTimeout(300);

                // Click Veo dropdown
                const veoDropdown = page.locator('button', { hasText: 'Veo' });
                if (await veoDropdown.count()) {
                    await veoDropdown.first().click({ force: true });
                    await page.waitForTimeout(800);
                    const veoOption = page.locator(`text=Veo 3.1 - ${veo}`);
                    if (await veoOption.count()) await veoOption.first().click({ force: true });
                    await page.waitForTimeout(300);
                }
            }

            // Video Ingredients: upload ảnh selected trước khi gen
            if (type === 'video' && videoMode === 'Ingredients' && selectedImages.length) {
                console.log(`[Flow] Uploading ${selectedImages.length} ingredient images...`);
                const fileInput = page.locator('input[type=file]');
                if (await fileInput.count()) {
                    const existing = selectedImages.filter(p => fs.existsSync(p));
                    console.log(`[Flow] Existing files: ${existing.length}`);
                    if (existing.length) {
                        await fileInput.setInputFiles(existing);
                        console.log(`[Flow] Uploaded ${existing.length} ingredient images`);

                        // Xử lý dialog "I agree" nếu xuất hiện
                        const agreeBtn = page.locator('button', { hasText: 'I agree' });
                        if (await agreeBtn.count()) {
                            await agreeBtn.first().click();
                            console.log('[Flow] Clicked I agree');
                        }
                        await page.waitForTimeout(5000);
                    }
                } else {
                    console.log('[Flow] No file input found');
                }
            } else if (type === 'video' && videoMode === 'Ingredients') {
                console.log('[Flow] Ingredients mode but no selected images');
            }

            // Đóng modal bằng click ra ngoài
            await page.mouse.click(10, 10);
            await page.waitForTimeout(500);
        }

        // Nhập prompt
        const promptBox = page.locator('div[contenteditable=true][role=textbox]');
        await promptBox.click({ force: true });
        await page.keyboard.type(fullPrompt, { delay: 20 });
        await page.waitForTimeout(500);

        // Click nút submit (icon arrow_forward)
        const createBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /arrow_forward/ }).first();
        await createBtn.click({ force: true });

        // Đếm media có sẵn trước khi gen
        const mediaTag = type === 'video' ? 'video' : 'img';
        const existingMediaCount = await page.evaluate((tag) => {
            let count = 0;
            for (const el of document.querySelectorAll(tag)) {
                const src = el.src || el.querySelector?.('source')?.src || '';
                if ((tag === 'img' ? el.naturalWidth > 200 : true) && src.startsWith('http') && src.includes('media')) count++;
            }
            return count;
        }, mediaTag);

        // Chờ tất cả ảnh/video gen xong (theo % progress)
        console.log(`[Flow] Generating: "${fullPrompt.slice(0, 50)}..." (${type} x${count})`);
        let imgSrcs = [];
        for (let i = 0; i < 180; i++) { // poll mỗi 2s, tối đa 6 phút
            await page.waitForTimeout(2000);

            const info = await page.evaluate((tag) => {
                const progressEls = document.querySelectorAll('.sc-55ebc859-7');
                const percents = [];
                for (const el of progressEls) {
                    const t = el.textContent?.trim();
                    if (t) percents.push(t);
                }
                const srcs = [];
                for (const el of document.querySelectorAll(tag)) {
                    const src = el.src || el.querySelector?.('source')?.src || '';
                    if ((tag === 'img' ? el.naturalWidth > 200 : true) && src.startsWith('http') && src.includes('media')) srcs.push(src);
                }
                return { percents, srcs: [...new Set(srcs)] };
            }, mediaTag);

            if (info.percents.length) {
                console.log(`[Flow] ${info.percents.join(' | ')} | done: ${info.srcs.length}/${count}`);
            }

            // Tất cả xong khi không còn progress và có media mới
            if (info.percents.length === 0 && info.srcs.length > existingMediaCount) {
                // Chờ thêm 2s để ảnh load xong hoàn toàn
                await page.waitForTimeout(2000);
                const final = await page.evaluate((tag) => {
                    const srcs = [];
                    for (const el of document.querySelectorAll(tag)) {
                        const src = el.src || el.querySelector?.('source')?.src || '';
                        if ((tag === 'img' ? el.naturalWidth > 200 : true) && src.startsWith('http') && src.includes('media')) srcs.push(src);
                    }
                    return [...new Set(srcs)];
                }, mediaTag);
                // Chỉ lấy media mới (bỏ qua cái cũ)
                imgSrcs = final.slice(existingMediaCount);
                console.log(`[Flow] All done! ${imgSrcs.length} new files`);
                break;
            }
        }

        if (!imgSrcs.length) {
            console.log('[Flow] Timeout - no image generated');
            return [];
        }

        // Tải tất cả về bằng page.request (cần cookie auth)
        const saved = [];
        const ext = type === 'video' ? '.mp4' : '.jpg';
        const existingFiles = fs.readdirSync(saveDirPath).filter(f => f.startsWith('flow_') && f.endsWith(ext)).length;
        for (let j = 0; j < imgSrcs.length; j++) {
            const fileName = `flow_${existingFiles + j + 1}${ext}`;
            try {
                const res = await page.request.get(imgSrcs[j]);
                if (res.ok()) {
                    fs.writeFileSync(path.join(saveDirPath, fileName), await res.body());
                    saved.push(fileName);
                    console.log(`[Flow] Saved: ${fileName}`);
                } else {
                    console.error(`[Flow] Download failed ${res.status()}: ${imgSrcs[j]}`);
                }
            } catch (e) { console.error(`[Flow] Download error: ${e.message}`); }

            // Video: tải thêm thumbnail
            if (type === 'video') {
                const thumbSrcs = await page.evaluate(() => {
                    const srcs = [];
                    for (const el of document.querySelectorAll('img')) {
                        if (el.naturalWidth > 200 && el.src.startsWith('http') && el.src.includes('media')) srcs.push(el.src);
                    }
                    return [...new Set(srcs)];
                });
                const thumbIdx = existingMediaCount + j;
                if (thumbSrcs[thumbIdx]) {
                    const thumbName = `flow_${existingFiles + j + 1}_thumbnail.jpg`;
                    try {
                        const thumbRes = await page.request.get(thumbSrcs[thumbIdx]);
                        if (thumbRes.ok()) {
                            fs.writeFileSync(path.join(saveDirPath, thumbName), await thumbRes.body());
                            saved.push(thumbName);
                            console.log(`[Flow] Saved: ${thumbName}`);
                        }
                    } catch (e) { console.error(`[Flow] Thumb download error: ${e.message}`); }
                }
            }
        }

        return saved;
    } catch (e) {
        console.error('[Flow] Error:', e.message);
        return [];
    } finally {
        await page.close().catch(() => {});
        try { await ctx.close(); } catch (_) {}
        if (profileId) await markProfileUsed(profileId);
    }
}

// Chạy trực tiếp để đăng nhập profile
// node browser.js <profile_dir> [email] [password]
if (process.argv[1]?.endsWith('browser.js')) {
    const profileDirArg = process.argv[2];
    // Chế độ "mở lấy cookie": node browser.js <profileDir> --open [url] [proxy]
    const openOnly = process.argv[3] === '--open';
    const openUrl = openOnly ? (process.argv[4] || 'https://x.com') : null;
    const email = openOnly ? null : (process.argv[3] || null);
    const password = openOnly ? null : (process.argv[4] || null);
    const proxy = process.argv[5] || null;

    const profileDir = profileDirArg
        ? (path.isAbsolute(profileDirArg) ? profileDirArg : path.join(SETTING_DIR, profileDirArg))
        : path.join(SETTING_DIR, 'chrome-profile');

    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

    const profileDirName = path.basename(profileDir);
    const ctx = await getBrowser(profileDir, proxy);
    const page = ctx.pages()[0] || await ctx.newPage();

    if (openOnly) {
        console.log('[OK] Mở profile để lấy cookie: ' + profileDirName + ' → ' + openUrl);
        await page.goto(openUrl).catch(() => {});
        console.log('[OK] Đăng nhập/thao tác trên trang, xong thì đóng trình duyệt để lưu cookie.');
        await ctx.waitForEvent('close').catch(() => {});
        process.exit(0);
    }

    console.log('[OK] Đang mở profile: ' + profileDirName + (email ? ` (${email})` : ''));
    await page.goto('https://accounts.google.com');

    if (email) {
        try {
            await page.waitForSelector('input[type="email"]', { timeout: 10000 });
            await page.fill('input[type="email"]', email);
            await page.click('#identifierNext, button:has-text("Next"), button:has-text("Tiếp theo")');

            if (password) {
                await page.waitForSelector('input[type="password"]', { timeout: 10000 });
                await page.fill('input[type="password"]', password);
                await page.click('#passwordNext, button:has-text("Next"), button:has-text("Tiếp theo")');
            }
            console.log('[OK] Đã điền email/password, chờ xác nhận...');

            // Chờ đăng nhập xong
            await page.waitForURL(url => !url.toString().includes('accounts.google.com'), { timeout: 60000 });

            // Tự động đóng các modal xác nhận của Google
            for (let i = 0; i < 5; i++) {
                await page.waitForTimeout(2000);
                const confirmBtn = page.locator('button').filter({ hasText: /confirm|done|continue|yes|got it|ok|dismiss|not now|skip/i }).first();
                if (await confirmBtn.count()) {
                    await confirmBtn.click();
                    console.log('[OK] Đã đóng modal xác nhận');
                }
            }
            console.log('[OK] Đăng nhập thành công, bạn có thể tắt trình duyệt.');
        } catch (e) {
            console.log('[WARN] Tự điền thất bại:', e.message);
        }
    }

    await ctx.waitForEvent('close').catch(() => {});
    process.exit(0);
}
