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

let _profileColChecked = false;
async function ensureProfileCols(db) {
    if (_profileColChecked) return;
    await db.run('ALTER TABLE ChromeProfile ADD COLUMN proxy TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE ChromeProfile ADD COLUMN logged_out INTEGER DEFAULT 0').catch(() => {});
    _profileColChecked = true;
}

// Danh sách profile theo thứ tự ưu tiên: chưa logout trước, dùng lâu nhất trước.
async function getProfiles(limit = 6) {
    const db = await getDb();
    await ensureProfileCols(db);
    const rows = await db.all(
        'SELECT id, profile_dir, proxy FROM ChromeProfile ORDER BY COALESCE(logged_out, 0) ASC, updated_at ASC LIMIT ?',
        [limit]
    );
    await db.close();
    return rows.map(p => ({ ...p, profile_dir: path.join(SETTING_DIR, p.profile_dir) }));
}

async function markProfileUsed(id) {
    const db = await getDb();
    await ensureProfileCols(db);
    await db.run('UPDATE ChromeProfile SET updated_at = ?, logged_out = 0 WHERE id = ?', [Date.now(), id]);
    await db.close();
}

// Đánh dấu profile bị logout -> lần sau bị đẩy xuống cuối hàng đợi
async function markLoggedOut(id) {
    const db = await getDb();
    await ensureProfileCols(db);
    await db.run('UPDATE ChromeProfile SET logged_out = 1, updated_at = ? WHERE id = ?', [Date.now(), id]);
    await db.close();
}

// Mở Flow bằng page hiện tại, xử lý màn chọn account. Trả về true nếu ĐÃ đăng nhập,
// false nếu bị kẹt ở accounts.google.com (profile logout / cần nhập mật khẩu).
async function openFlowLoggedIn(page) {
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    console.log('[Flow] Đã mở Flow | URL:', page.url());

    if (page.url().includes('accounts.google.com')) {
        console.log('[Flow] Bị đưa tới trang đăng nhập, thử chọn account đã lưu...');
        const accountBtn = page.locator('li[data-authuser], div[data-email], [data-identifier]').first();
        if (await accountBtn.count()) {
            await accountBtn.click().catch(() => {});
            console.log('[Flow] Đã click account');
        }
        // Chờ NGẮN (20s) để quay lại Flow; nếu vẫn ở accounts -> coi như logout
        const back = await page.waitForURL(u => !u.toString().includes('accounts.google.com'), { timeout: 20000 })
            .then(() => true).catch(() => false);
        if (!back) { console.warn('[Flow] Vẫn kẹt ở accounts.google.com -> profile LOGOUT'); return false; }
        await page.waitForTimeout(3000);
        console.log('[Flow] Xác thực xong | URL:', page.url());
    }
    return true;
}

// Vào tận editor của Flow (đăng nhập + bấm Create + tạo project mới).
// Trả false nếu bất kỳ lúc nào bị đẩy sang accounts.google.com (profile chưa đăng nhập Flow) -> nên xoay profile.
async function enterFlowEditor(page) {
    const authed = await openFlowLoggedIn(page);
    if (!authed) return false;

    const newBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /add_2/ }).first();
    if (await newBtn.count()) {
        // Đang ở trong tool -> tạo project mới
        await newBtn.click();
        await page.waitForTimeout(8000);
        const createBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /add_2/ }).last();
        if (await createBtn.count() > 1) { await createBtn.click(); await page.waitForTimeout(5000); }
    } else {
        // Trang landing: bấm "Create with Google Flow"
        console.log('[Flow] Ở trang landing, bấm "Create with Google Flow"...');
        const createFlowBtn = page.locator('button, a').filter({ hasText: /create with (google )?flow/i }).first();
        if (await createFlowBtn.count()) {
            await createFlowBtn.scrollIntoViewIfNeeded().catch(() => {});
            await createFlowBtn.click({ force: true });
            console.log('[Flow] Đã bấm "Create with Google Flow"');
        } else {
            console.warn('[Flow] Không thấy nút "Create with Google Flow" -> thử nút khả kiến đầu tiên');
            await page.locator('button:visible').first().click({ force: true }).catch(() => {});
        }
        await page.waitForTimeout(6000);
        // Bấm Create mà nhảy sang đăng nhập => profile CHƯA đăng nhập Flow
        if (page.url().includes('accounts.google.com')) {
            console.warn('[Flow] Bấm Create -> chuyển sang trang đăng nhập => profile logout');
            return false;
        }
        console.log('[Flow] Đã vào tool từ landing | URL:', page.url());
        await page.waitForSelector('button i.google-symbols', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2000);
        const newBtnAfter = page.locator('button:has(i.google-symbols)').filter({ hasText: /add_2/ }).first();
        if (await newBtnAfter.count()) {
            await newBtnAfter.click();
            await page.waitForTimeout(8000);
            console.log('[Flow] Đã bấm add_2 tạo project');
        }
    }

    if (page.url().includes('accounts.google.com')) {
        console.warn('[Flow] Sau tạo project vẫn ở accounts.google.com => logout');
        return false;
    }
    return true;
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

    // Xoay vòng profile: thử lần lượt tới khi gặp profile CÒN đăng nhập.
    // Profile logout -> đánh dấu logged_out + đóng + thử profile kế tiếp.
    let ctx = null, page = null, activeProfileId = null;
    const candidates = await getProfiles(6);
    const list = candidates.length ? candidates : [null]; // fallback profile mặc định
    for (const profile of list) {
        const pDir = profile?.profile_dir || path.join(SETTING_DIR, 'chrome-profile');
        const tryCtx = await getBrowser(pDir, profile?.proxy);
        const tryPage = tryCtx.pages()[0] || await tryCtx.newPage();
        const loggedIn = await enterFlowEditor(tryPage).catch((e) => { console.warn('[Flow] enterFlowEditor lỗi:', e.message); return false; });
        if (loggedIn) {
            ctx = tryCtx; page = tryPage; activeProfileId = profile?.id ?? null;
            console.log(`[Flow] ✅ Dùng profile #${activeProfileId ?? 'default'} (đã vào editor)`);
            break;
        }
        if (profile?.id) await markLoggedOut(profile.id);
        console.warn(`[Flow] ⟳ Profile #${profile?.id ?? 'default'} logout -> xoay profile khác`);
        await tryPage.close().catch(() => {});
        await tryCtx.close().catch(() => {});
    }
    if (!ctx) {
        console.error('[Flow] ❌ Không có profile nào đăng nhập được (tất cả logout). Hãy login lại profile.');
        return [];
    }

    try {
        console.log('[Flow] Trong editor | URL:', page.url());

        // Mở modal settings (button chứa cả ratio và count, ví dụ: "Videocrop_16_9x2")
        const settingsBtn = page.locator('button:visible').filter({ hasText: /x[1-4]$/ });
        console.log(`[Flow] Nút settings tìm thấy: ${await settingsBtn.count()}`);
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
        if (!fullPrompt.trim()) {
            console.error('[Flow] ❌ Prompt rỗng -> dừng (kiểm tra content/template).');
            return [];
        }
        // Chọn ĐÚNG ô prompt (tránh nhầm ô tìm kiếm). Liệt kê ứng viên rồi tag phần tử chọn được.
        const pick = await page.evaluate(() => {
            const cands = [...document.querySelectorAll('textarea, input[type=text], input:not([type]), [contenteditable=""], [contenteditable="true"]')];
            const meta = cands.map((el, i) => {
                const r = el.getBoundingClientRect();
                const ph = (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.textContent || '').trim().slice(0, 60);
                const editable = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.getAttribute('contenteditable') !== null;
                return { i, tag: el.tagName.toLowerCase(), ce: el.getAttribute('contenteditable') !== null, ph, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), visible: r.width > 3 && r.height > 3 && editable };
            });
            const isSearch = s => /search|tìm kiếm/i.test(s);
            const isPrompt = s => /prompt|idea|describe|generat|animate|create|mô tả|ý tưởng|nhập/i.test(s);
            const vis = meta.filter(x => x.visible && !isSearch(x.ph));
            // Ưu tiên: có chữ prompt-ish -> contenteditable rộng nhất/thấp nhất -> ô rộng nhất/thấp nhất
            let chosen = vis.find(x => isPrompt(x.ph))
                || vis.filter(x => x.ce).sort((a, b) => b.w - a.w || b.top - a.top)[0]
                || vis.sort((a, b) => b.w - a.w || b.top - a.top)[0];
            if (chosen) cands[chosen.i].setAttribute('data-flow-prompt', '1');
            return { meta, chosenIdx: chosen?.i ?? -1 };
        });
        console.log('[Flow] Ứng viên ô nhập:', JSON.stringify(pick.meta));
        console.log('[Flow] Chọn ô prompt idx =', pick.chosenIdx);

        const promptBox = pick.chosenIdx >= 0
            ? page.locator('[data-flow-prompt="1"]')
            : page.locator('div[contenteditable=true][role=textbox]').last();
        try {
            await promptBox.waitFor({ state: 'visible', timeout: 20000 });
        } catch {
            console.error('[Flow] ❌ Không thấy ô nhập prompt sau 20s. URL:', page.url());
            return [];
        }
        console.log(`[Flow] Nhập ${fullPrompt.length} ký tự vào ô prompt...`);
        await promptBox.click({ force: true });
        await page.keyboard.type(fullPrompt, { delay: 20 });
        await page.waitForTimeout(500);

        // Click nút submit (icon arrow_forward)
        const createBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /arrow_forward/ }).first();
        await createBtn.click({ force: true });
        await page.waitForTimeout(3000);

        // Flow có thể hỏi "chọn hướng" (radio options) trước khi tạo. Chọn phương án ĐẦU TIÊN
        // trong DOM — dù nó đang là radio_button_checked (chọn sẵn) hay radio_button_unchecked.
        for (let r = 0; r < 3; r++) {
            const info = await page.evaluate(() => {
                const icons = [...document.querySelectorAll('i.google-symbols, span')]
                    .filter(e => { const t = (e.textContent || '').trim(); return t === 'radio_button_unchecked' || t === 'radio_button_checked'; });
                if (!icons.length) return { n: 0 };
                const first = icons[0]; // option đầu tiên theo thứ tự DOM
                const alreadyChecked = (first.textContent || '').trim() === 'radio_button_checked';
                let el = first;
                for (let k = 0; k < 6 && el; k++) {
                    const role = el.getAttribute && el.getAttribute('role');
                    if (el.tagName === 'BUTTON' || role === 'radio' || role === 'option' || role === 'menuitemradio') break;
                    el = el.parentElement;
                }
                (el || first).setAttribute('data-flow-opt', '1');
                return { n: icons.length, alreadyChecked };
            });
            if (!info.n) break;
            console.log(`[Flow] Màn chọn hướng (${info.n} lựa chọn) -> phương án ĐẦU TIÊN${info.alreadyChecked ? ' (đã chọn sẵn)' : ''}`);
            if (!info.alreadyChecked) await page.locator('[data-flow-opt="1"]').click({ force: true }).catch(() => {});
            await page.evaluate(() => document.querySelector('[data-flow-opt="1"]')?.removeAttribute('data-flow-opt'));
            await page.waitForTimeout(1200);
            // Gửi/tiếp tục
            const sendBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /arrow_forward|send/ }).first();
            if (await sendBtn.count()) await sendBtn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(3000);
        }

        // Nếu Flow chuyển sang hội thoại (viết script/hỏi ngược) mà chưa sinh ảnh -> gõ lệnh ÉP sinh ảnh ngay.
        {
            const alreadyMedia = await page.evaluate((tag) => {
                for (const el of document.querySelectorAll(tag)) {
                    const src = el.src || '';
                    if ((tag === 'img' ? el.naturalWidth > 200 : true) && src.startsWith('http') && src.includes('media')) return true;
                }
                return false;
            }, type === 'video' ? 'video' : 'img');
            if (!alreadyMedia) {
                const forceMsg = `Generate the image NOW. Output exactly ONE 16:9 thumbnail image only — do not ask questions, do not write any script/plan/text, just render the image. ${fullPrompt}`;
                const box = page.locator('div[contenteditable=true][role=textbox], textarea').last();
                if (await box.count()) {
                    console.log('[Flow] Flow đang hội thoại -> gõ lệnh ép sinh ảnh');
                    await box.click({ force: true }).catch(() => {});
                    await page.keyboard.type(forceMsg, { delay: 12 });
                    await page.waitForTimeout(400);
                    const send2 = page.locator('button:has(i.google-symbols)').filter({ hasText: /arrow_forward|send/ }).first();
                    if (await send2.count()) await send2.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(4000);
                }
            }
        }

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
        if (activeProfileId) await markProfileUsed(activeProfileId);
    }
}

// Chạy trực tiếp để đăng nhập profile
// node browser.js <profile_dir> [email] [password]
if (process.argv[1]?.endsWith('browser.js')) {
    const profileDirArg = process.argv[2];
    const email = process.argv[3] || null;
    const password = process.argv[4] || null;
    const proxy = process.argv[5] || null;

    const profileDir = profileDirArg
        ? (path.isAbsolute(profileDirArg) ? profileDirArg : path.join(SETTING_DIR, profileDirArg))
        : path.join(SETTING_DIR, 'chrome-profile');

    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

    const profileDirName = path.basename(profileDir);
    console.log('[OK] Đang mở profile: ' + profileDirName + (email ? ` (${email})` : ''));
    const ctx = await getBrowser(profileDir, proxy);
    const page = ctx.pages()[0] || await ctx.newPage();
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
