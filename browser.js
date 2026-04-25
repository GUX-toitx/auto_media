import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const CHROME_PATH = process.env.CUSTOM_CHROME === 'true'
    ? path.join(process.env.SETTING_DIR, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    : undefined;
const USER_DATA_DIR = path.join(process.env.SETTING_DIR || path.join(process.env.HOME, '.cache', 'ms-playwright'), 'chrome-profile');

let _browserContext = null;

export async function getBrowser() {
    if (_browserContext) return _browserContext;
    _browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
        executablePath: CHROME_PATH,
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 900 },
    });
    _browserContext.on('close', () => { _browserContext = null; });
    return _browserContext;
}

export async function generateFlowImage(keyword, saveDirPath, content = '', type = 'image', count = 4) {
    const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
    const promptFile = path.join(MEDIA_DIR, 'prompt_flow.txt');
    const promptTemplate = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8').trim().replace(/\n/g, ' ') : '';
    const fullPrompt = promptTemplate ? `${promptTemplate} ${content}` : content || keyword;
    if (!fs.existsSync(saveDirPath)) fs.mkdirSync(saveDirPath, { recursive: true });

    const ctx = await getBrowser();
    const page = await ctx.newPage();

    try {
        // Vào Flow
        await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Click New project
        const newBtn = page.locator('button', { hasText: 'New project' });
        if (await newBtn.count()) {
            await newBtn.first().click();
            await page.waitForTimeout(8000);
        }

        // Mở modal settings
        const settingsBtn = page.locator('button').filter({ hasText: 'Nano Banana' });
        if (await settingsBtn.count()) {
            await settingsBtn.first().click();
            await page.waitForTimeout(1000);

            // Chọn Image hoặc Video
            const typeBtn = page.locator('button[role=tab]', { hasText: type === 'video' ? 'Video' : 'Image' });
            if (await typeBtn.count()) await typeBtn.first().click();
            await page.waitForTimeout(300);

            // Chọn số lượng
            const countBtn = page.locator('button[role=tab]', { hasText: `x${count}` });
            if (await countBtn.count()) await countBtn.first().click();
            await page.waitForTimeout(300);

            // Đóng modal bằng click ra ngoài
            await page.mouse.click(10, 10);
            await page.waitForTimeout(500);
        }

        // Nhập prompt
        const promptBox = page.locator('div[contenteditable=true][role=textbox]');
        await promptBox.click({ force: true });
        await page.keyboard.type(fullPrompt, { delay: 20 });
        await page.waitForTimeout(500);

        // Click Create
        const createBtn = page.locator('button', { hasText: 'Create' }).last();
        await createBtn.click();

        // Chờ tất cả ảnh/video gen xong (theo % progress)
        console.log(`[Flow] Generating: "${fullPrompt.slice(0, 50)}..." (${type} x${count})`);
        let imgSrcs = [];
        for (let i = 0; i < 180; i++) { // poll mỗi 2s, tối đa 6 phút
            await page.waitForTimeout(2000);

            const info = await page.evaluate(() => {
                const progressEls = document.querySelectorAll('.sc-55ebc859-7');
                const percents = [];
                for (const el of progressEls) {
                    const t = el.textContent?.trim();
                    if (t) percents.push(t);
                }
                const srcs = [];
                for (const el of document.querySelectorAll('img, video')) {
                    const src = el.src || el.querySelector?.('source')?.src || '';
                    if ((el.tagName === 'IMG' && el.naturalWidth > 200 || el.tagName === 'VIDEO') && src.startsWith('http') && src.includes('media')) srcs.push(src);
                }
                return { percents, srcs: [...new Set(srcs)] };
            });

            if (info.percents.length) {
                console.log(`[Flow] ${info.percents.join(' | ')} | done: ${info.srcs.length}/${count}`);
            }

            // Tất cả xong khi không còn progress và có ảnh
            if (info.percents.length === 0 && info.srcs.length > 0) {
                // Chờ thêm 2s để ảnh load xong hoàn toàn
                await page.waitForTimeout(2000);
                const final = await page.evaluate(() => {
                    const srcs = [];
                    for (const el of document.querySelectorAll('img, video')) {
                        const src = el.src || el.querySelector?.('source')?.src || '';
                        if ((el.tagName === 'IMG' && el.naturalWidth > 200 || el.tagName === 'VIDEO') && src.startsWith('http') && src.includes('media')) srcs.push(src);
                    }
                    return [...new Set(srcs)];
                });
                imgSrcs = final;
                console.log(`[Flow] All done! ${imgSrcs.length} files`);
                break;
            }
        }

        if (!imgSrcs.length) {
            console.log('[Flow] Timeout - no image generated');
            return [];
        }

        // Tải tất cả về
        const saved = [];
        const ext = type === 'video' ? '.mp4' : '.jpg';
        const existing = fs.readdirSync(saveDirPath).filter(f => f.startsWith('flow_') && f.endsWith(ext)).length;
        for (let j = 0; j < imgSrcs.length; j++) {
            const fileName = `flow_${existing + j + 1}${ext}`;
            const res = await page.request.get(imgSrcs[j]);
            if (res.ok()) {
                fs.writeFileSync(path.join(saveDirPath, fileName), await res.body());
                saved.push(fileName);
                console.log(`[Flow] Saved: ${fileName}`);
            }
        }

        return saved;
    } catch (e) {
        console.error('[Flow] Error:', e.message);
        return [];
    } finally {
        await page.close();
        try { await ctx.close(); } catch (_) {}
        _browserContext = null;
    }
}

// Chạy trực tiếp để test
if (process.argv[1]?.endsWith('browser.js')) {
    const ctx = await getBrowser();
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://www.google.com');
    console.log('[OK] Chrome áo đã mở. Nhấn Ctrl+C để đóng.');
}
