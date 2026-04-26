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

    const ctx = await getBrowser();
    const page = ctx.pages()[0] || await ctx.newPage();

    try {
        // Vào Flow
        await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Click New project (icon add_2, xpath: /html/body/div[1]/div[2]/div/div/button)
        const newBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /add_2/ }).first();
        if (await newBtn.count()) {
            await newBtn.click();
            await page.waitForTimeout(8000);
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
            const countBtn = page.locator('button[role=tab]', { hasText: `x${count}` });
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
