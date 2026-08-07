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
    // CHỈ chọn profile có profile_dir hợp lệ + chưa bị đăng xuất. Trước đây thiếu điều kiện này nên
    // trúng row profile_dir=NULL (profile mới thêm email nhưng chưa gán thư mục) → path.join(SETTING_DIR, null)
    // ném lỗi 'The "path" argument must be of type string. Received null' → hỏng cả AI Generate.
    const profile = await db.get(
        `SELECT id, profile_dir, proxy FROM ChromeProfile
         WHERE profile_dir IS NOT NULL AND profile_dir != '' AND (logged_out IS NULL OR logged_out = 0)
         ORDER BY updated_at ASC LIMIT 1`);
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

// ===== Gỡ popup onboarding/giới thiệu của Flow =====
// Thi thoảng Flow chặn cả UI bằng một popup giới thiệu, phải bấm "Bắt đầu" mới dùng tiếp được.
// Google đổi popup này khá thường xuyên (đổi chữ, đổi số bước, có lúc dùng role=dialog có lúc không),
// nên KHÔNG bắt bằng selector cứng. Muốn hỗ trợ chữ mới: thêm 1 dòng vào POPUP_BUTTON_PATTERNS —
// khi gặp popup lạ, hàm này in ra sẵn toàn bộ nhãn nút của popup đó trong log.
//
// Xếp theo ĐỘ ƯU TIÊN: nút đi tiếp trước, nút bỏ qua sau — để không "Skip" mất một luồng
// mà lẽ ra chỉ cần bấm "Bắt đầu" là vào thẳng.
const POPUP_BUTTON_PATTERNS = [
    'bắt đầu|get started|start now|let\'s go|dùng thử|try it',
    'tiếp tục|continue|tiếp theo|^tiếp$|^next$|kế tiếp',
    'đã hiểu|tôi hiểu|got it|i understand|^understood$|^ok$|^oke$',
    'đồng ý|i agree|^agree$|^accept$|chấp nhận',
    'xong|hoàn tất|^done$|^finish$|^close$|^đóng$',
    'bỏ qua|^skip$|dismiss|not now|no thanks|để sau|không phải bây giờ|maybe later',
];
// Nút TUYỆT ĐỐI không bấm dù có khớp pattern nào ở trên (tránh tự phá tài khoản/dự án).
const POPUP_BUTTON_BLOCKLIST = 'đăng xuất|sign out|log out|xoá|xóa|delete|remove|huỷ đăng ký|unsubscribe|nâng cấp|upgrade|mua|buy|subscribe|thanh toán';

/**
 * Tìm và bấm nút đóng popup. Gọi được nhiều lần, không có popup thì trả về null và không làm gì.
 * KHÔNG BAO GIỜ throw — popup chỉ là vật cản phụ, lỗi ở đây không được làm hỏng cả lượt tạo media.
 * @returns {Promise<string|null>} nhãn nút đã bấm, hoặc null nếu không bấm gì
 */
async function dismissFlowPopup(page) {
    try {
        const found = await page.evaluate(({ patterns, blocklist }) => {
            const rxs = patterns.map(s => new RegExp(s, 'i'));
            const blockRx = new RegExp(blocklist, 'i');
            // Bỏ icon-font ra khỏi nhãn: <i class="google-symbols">arrow_forward</i> nằm TRONG nút
            // sẽ lẫn chữ "arrow_forward" vào innerText, làm mọi regex khớp sai.
            const label = (el) => {
                const c = el.cloneNode(true);
                c.querySelectorAll('i, svg, .google-symbols, .material-icons, .material-symbols-outlined, .material-symbols-rounded')
                    .forEach(n => n.remove());
                return (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim();
            };
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const st = getComputedStyle(el);
                return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
            };
            const buttonsIn = (root) => [...root.querySelectorAll('button, [role=button], a[role=button]')]
                .filter(visible)
                .map(el => ({ el, text: label(el) }))
                .filter(b => b.text && b.text.length <= 40);   // nhãn dài = đoạn văn, không phải nút

            // 1) Ưu tiên hộp thoại thật: quét trong đó thì không thể bấm nhầm nút của trang chính.
            const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open]')].filter(visible);
            let scope = dialogs.length ? dialogs[dialogs.length - 1] : null;   // popup trên cùng
            let cands = scope ? buttonsIn(scope) : [];

            // 2) Không có hộp thoại chuẩn → quét toàn trang, nhưng CHỈ nhóm từ đặc trưng onboarding
            //    (rxs[0]) để tránh bấm nhầm nút bình thường của Flow.
            let onlyFirstPattern = false;
            if (!cands.length) {
                cands = buttonsIn(document);
                onlyFirstPattern = true;
            }
            cands = cands.filter(b => !blockRx.test(b.text));

            const active = onlyFirstPattern ? rxs.slice(0, 1) : rxs;
            for (const rx of active) {
                const hit = cands.find(b => rx.test(b.text));
                if (hit) {
                    hit.el.setAttribute('data-auto-popup-target', '1');
                    return { text: hit.text, inDialog: !!scope };
                }
            }
            // 3) Có popup mà không nút nào khớp → trả nhãn về để log, KHÔNG đoán bừa.
            if (scope) return { unknown: true, labels: cands.map(b => b.text).slice(0, 12) };
            return null;
        }, { patterns: POPUP_BUTTON_PATTERNS, blocklist: POPUP_BUTTON_BLOCKLIST });

        if (!found) return null;
        if (found.unknown) {
            console.warn('[Flow] ⚠️ Gặp popup LẠ chưa biết cách đóng. Nhãn các nút:', JSON.stringify(found.labels));
            console.warn('[Flow]    → thêm chữ tương ứng vào POPUP_BUTTON_PATTERNS trong src/services/browser.js');
            return null;
        }
        // Bấm bằng Playwright (không dùng el.click() trong evaluate) để đi qua đúng chuỗi
        // sự kiện chuột thật — nút của Flow có chỗ chỉ phản hồi pointer event.
        const target = page.locator('[data-auto-popup-target="1"]').first();
        await target.click({ timeout: 5000 }).catch(async () => {
            await page.evaluate(() => document.querySelector('[data-auto-popup-target="1"]')?.click());
        });
        await page.evaluate(() => document.querySelector('[data-auto-popup-target="1"]')?.removeAttribute('data-auto-popup-target'));
        console.log(`[Flow] Đã đóng popup: "${found.text}"${found.inDialog ? '' : ' (không nằm trong dialog)'}`);
        return found.text;
    } catch (e) {
        console.warn('[Flow] Bỏ qua lỗi khi gỡ popup:', e.message);
        return null;
    }
}

/**
 * Chữ ký trạng thái popup, để biết cú bấm vừa rồi CÓ đổi được gì không.
 *
 * Phải gồm cả NỘI DUNG popup chứ không chỉ nhãn nút: onboarding nhiều bước thường giữ nguyên
 * chữ trên nút ("Tiếp tục" ở cả bước 1 và 2), chỉ đổi phần nội dung — so bằng nhãn nút sẽ
 * tưởng nhầm là đứng yên rồi bỏ dở onboarding giữa chừng.
 */
async function popupSignature(page) {
    try {
        return await page.evaluate(() => {
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const st = getComputedStyle(el);
                return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
            };
            // Cùng cách chọn phạm vi với dismissFlowPopup: hộp thoại trên cùng, không có thì cả trang.
            const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open]')].filter(visible);
            const scope = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
            return ((scope.innerText || scope.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 400);
        });
    } catch { return ''; }
}

/**
 * Gỡ popup nhiều bước (onboarding kiểu Tiếp → Tiếp → Xong).
 * Dừng ngay khi một vòng không bấm được gì nữa, nên không tốn thời gian khi không có popup.
 */
async function dismissFlowPopups(page, maxSteps = 5) {
    const clicked = [];
    for (let i = 0; i < maxSteps; i++) {
        const before = await popupSignature(page);
        const hit = await dismissFlowPopup(page);
        if (!hit) break;
        clicked.push(hit);
        await page.waitForTimeout(1200);   // chờ bước kế của onboarding vẽ xong
        // Bấm mà UI y nguyên = nút không đóng được popup (Google đổi cách hoạt động, hoặc
        // nút chỉ là link). Bấm tiếp chỉ tổ spam đúng nút đó -> dừng và báo để còn biết mà sửa.
        if (await popupSignature(page) === before) {
            console.warn(`[Flow] ⚠️ Đã bấm "${hit}" nhưng popup không đổi → dừng để không bấm lặp.`);
            break;
        }
    }
    return clicked;
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
    // Guard BẮT BUỘC ra media: nếu không nêu rõ, Flow (Gemini) hiểu content dài thành chủ đề rồi
    // CHAT / viết truyện thay vì tạo ảnh/video (xem create-thumbnail đã phải làm tương tự). Prepend
    // chỉ thị cứng vào TRƯỚC mọi prompt để luôn buộc Flow xuất media, không hỏi lại, không viết chữ.
    const mediaWord = type === 'video' ? 'video clip' : 'image';
    const mediaPlural = type === 'video' ? 'video clips' : 'images';
    // UI agent mới của Flow BỎ QUA setting số lượng cũ → mặc định tự tạo 4. Phải RA LỆNH số lượng trong prompt.
    const nMedia = count > 1 ? `EXACTLY ${count} distinct ${mediaPlural}` : `EXACTLY one ${mediaWord}`;
    const MEDIA_ONLY_GUARD =
        `Immediately generate ${nMedia} now — do not produce more or fewer than ${count}. This is a direct generation command, NOT a conversation. ` +
        `Output ONLY the ${mediaPlural} — do NOT chat, do NOT narrate, do NOT ask questions, do NOT reply with any story, script, outline, plan or explanation. ` +
        `If there are several possible interpretations or options, ALWAYS choose the first / most reasonable one and proceed right away. ` +
        `NEVER wait for my confirmation and NEVER ask me to choose — just start generating immediately. `;
    const promptBody = promptTemplate ? `${promptTemplate} ${content}` : content || keyword;
    const fullPrompt = `${MEDIA_ONLY_GUARD}${promptBody}`;
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
        // Popup giới thiệu hay chặn ngay khi vừa mở Flow → gỡ trước khi tìm bất kỳ nút nào.
        await dismissFlowPopups(page);

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
            // Đăng nhập xong Flow hay chào lại bằng popup onboarding.
            await dismissFlowPopups(page);
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

        // Vào được project rồi Flow vẫn có thể bật popup mẹo/tính năng mới. Gỡ nốt trước khi
        // đụng vào settings + ô prompt: popup che thì click rơi vào lớp phủ, gõ prompt mất trắng.
        await dismissFlowPopups(page);

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
        let nudges = 0;           // số lần đã "thúc" agent khi nó đứng im
        let lastActionIter = 0;   // vòng lặp của lần submit/nudge gần nhất
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
                // UI agent mới của Flow: khi đang tạo có chữ "Generating…/Đang tạo…" hoặc nút Dừng/Stop.
                // Khi agent hỏi lại/đưa option rồi CHỜ thì không có dấu hiệu nào trong số này.
                const bodyTxt = document.body.innerText || '';
                const busy = /generating|đang tạo|creating|rendering|processing/i.test(bodyTxt)
                    || !!document.querySelector('button[aria-label*="Dừng" i], button[aria-label*="Stop" i]');
                return { percents, srcs: [...new Set(srcs)], busy };
            }, mediaTag);

            if (info.percents.length) {
                console.log(`[Flow] ${info.percents.join(' | ')} | done: ${info.srcs.length}/${count}`);
            }

            // NUDGE: agent đứng im (không "busy", chưa có media mới) sau ~30s → nhiều khả năng nó đang
            // hỏi lại / đưa option và CHỜ người dùng. Gửi lệnh ép "chọn phương án 1, tạo ngay" để khỏi kẹt.
            // Tối đa 2 lần, cách nhau ≥15 vòng (30s). Đây là hiện thực của yêu cầu "có option thì chọn cái đầu".
            if (info.srcs.length <= existingMediaCount && !info.busy && info.percents.length === 0
                && nudges < 2 && (i - lastActionIter) >= 15) {
                nudges++;
                lastActionIter = i;
                const mw = type === 'video' ? 'video' : 'ảnh';
                const nudgeMsg = `Chọn phương án đầu tiên và tạo ${mw} ngay bây giờ. Chỉ xuất ${mw}, không hỏi thêm, không viết chữ.`;
                console.log(`[Flow] ⏳ Agent đứng im, chưa có media → nudge lần ${nudges}: ép chọn phương án 1 + tạo ngay`);
                try {
                    const box = page.locator('div[contenteditable=true][role=textbox]').last();
                    await box.click({ force: true });
                    await page.keyboard.type(nudgeMsg, { delay: 15 });
                    await page.waitForTimeout(300);
                    const sendBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /arrow_forward/ }).first();
                    if (await sendBtn.count()) await sendBtn.click({ force: true });
                    else await page.keyboard.press('Enter');
                } catch (e) { console.warn('[Flow] nudge lỗi:', e.message); }
                continue;
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
                // Chỉ lấy media mới (bỏ qua cái cũ) — CHẶN CỨNG tối đa `count` cái, phòng khi Flow vẫn tạo dư (vd 4).
                imgSrcs = final.slice(existingMediaCount, existingMediaCount + count);
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
        // timeout: 0 = chờ VÔ HẠN tới khi user tự đóng trình duyệt (mặc định Playwright chỉ 30s → tự đóng sớm).
        // launchPersistentContext tự lưu cookie/session vào profile dir → đóng là lưu.
        await ctx.waitForEvent('close', { timeout: 0 }).catch(() => {});
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

    // timeout: 0 = chờ VÔ HẠN tới khi user tự đóng (mặc định 30s sẽ tự đóng trình duyệt giữa chừng đăng nhập).
    await ctx.waitForEvent('close', { timeout: 0 }).catch(() => {});
    process.exit(0);
}
