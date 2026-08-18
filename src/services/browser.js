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

// ===== HẠN MỨC ẢNH/NGÀY CỦA MỖI TÀI KHOẢN FLOW =====
// Google Flow chặn ~50 ảnh/ngày cho một tài khoản. Một bài podcast 40 cảnh + 15 nhân vật đã là 55 lượt
// gen, nên phải ĐẾM theo ngày cho từng profile rồi tự đổi tài khoản khi cạn (xem runFlowImageBatch).
export const FLOW_DAILY_LIMIT = Math.max(1, parseInt(process.env.FLOW_DAILY_LIMIT || '50', 10) || 50);

// Ngày theo GIỜ MÁY. Flow reset theo múi giờ tài khoản nên không thể khớp tuyệt đối; lấy giờ máy vì
// đó là thứ người dùng nhìn thấy trên dashboard. Lệch múi giờ chỉ làm bộ đếm dè dặt hơn thực tế.
const todayKey = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// DB cũ chưa có 2 cột đếm (migrate chạy lúc server khởi động, nhưng worker là tiến trình riêng và có
// thể chạy trước đó) -> tự thêm, chạy đúng 1 lần cho mỗi tiến trình.
let flowColumnsReady = false;
async function ensureFlowColumns(db) {
    if (flowColumnsReady) return;
    await db.run('ALTER TABLE ChromeProfile ADD COLUMN flow_date TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE ChromeProfile ADD COLUMN flow_count INTEGER NOT NULL DEFAULT 0').catch(() => {});
    flowColumnsReady = true;
}

const USED_TODAY = 'CASE WHEN flow_date = ? THEN flow_count ELSE 0 END';

/**
 * Profile kế tiếp để dùng. Chỉ lấy profile CÒN hạn mức hôm nay; profile xài ít nhất được ưu tiên.
 * @param exclude  id đã dùng trong phiên này (cạn hạn mức / vừa lỗi) — không lấy lại.
 * @param prefer   id NÊN lấy trước nếu còn hạn mức: đó là những tài khoản đang giữ project Flow của
 *                 bài này. Bốc nhầm tài khoản khác là phải tạo project mới rồi gen lại toàn bộ
 *                 prompt nhân vật — rất đắt khi chỉ còn thiếu vài cảnh.
 */
async function getNextProfile({ exclude = [], prefer = [] } = {}) {
    const db = await getDb();
    await ensureFlowColumns(db);
    const day = todayKey();
    const holes = exclude.length ? `AND id NOT IN (${exclude.map(() => '?').join(',')})` : '';
    const wanted = prefer.map(Number).filter(n => Number.isInteger(n) && !exclude.includes(n));
    if (wanted.length) {
        const hit = await db.get(
            `SELECT id, profile_dir, proxy, email, ${USED_TODAY} AS usedToday FROM ChromeProfile
             WHERE id IN (${wanted.map(() => '?').join(',')})
               AND profile_dir IS NOT NULL AND profile_dir != '' AND (logged_out IS NULL OR logged_out = 0)
               AND ${USED_TODAY} < ?
             ORDER BY usedToday ASC LIMIT 1`, [day, ...wanted, day, FLOW_DAILY_LIMIT]);
        if (hit) {
            await db.close();
            return { ...hit, profile_dir: path.join(SETTING_DIR, hit.profile_dir), left: FLOW_DAILY_LIMIT - hit.usedToday };
        }
    }
    // CHỈ chọn profile có profile_dir hợp lệ + chưa bị đăng xuất. Trước đây thiếu điều kiện này nên
    // trúng row profile_dir=NULL (profile mới thêm email nhưng chưa gán thư mục) → path.join(SETTING_DIR, null)
    // ném lỗi 'The "path" argument must be of type string. Received null' → hỏng cả AI Generate.
    const profile = await db.get(
        `SELECT id, profile_dir, proxy, email, ${USED_TODAY} AS usedToday FROM ChromeProfile
         WHERE profile_dir IS NOT NULL AND profile_dir != '' AND (logged_out IS NULL OR logged_out = 0)
           AND ${USED_TODAY} < ? ${holes}
         ORDER BY usedToday ASC, updated_at ASC LIMIT 1`,
        [day, day, FLOW_DAILY_LIMIT, ...exclude]);
    await db.close();
    if (!profile) return null;
    return { ...profile, profile_dir: path.join(SETTING_DIR, profile.profile_dir), left: FLOW_DAILY_LIMIT - profile.usedToday };
}

// Cộng số ảnh vừa gen vào bộ đếm ngày. Ghi NGAY sau mỗi tấm chứ không đợi cuối phiên: tiến trình
// chết giữa chừng mà bộ đếm mất thì lần sau lại đâm đầu vào tài khoản đã cạn.
async function bumpProfileFlow(id, n = 1) {
    if (!id || n <= 0) return;
    const db = await getDb();
    await ensureFlowColumns(db);
    const day = todayKey();
    await db.run(
        `UPDATE ChromeProfile SET flow_count = CASE WHEN flow_date = ? THEN flow_count + ? ELSE ? END,
                                  flow_date = ? WHERE id = ?`, [day, n, n, day, id]);
    await db.close();
}

// Flow tự báo hết lượt -> đóng sổ tài khoản này cho hôm nay, kể cả khi bộ đếm của mình chưa tới trần
// (đếm của mình chỉ tính ảnh do máy này gen; tài khoản có thể đã bị dùng ở nơi khác).
async function markProfileOutOfQuota(id) {
    if (!id) return;
    const db = await getDb();
    await ensureFlowColumns(db);
    await db.run('UPDATE ChromeProfile SET flow_date = ?, flow_count = ? WHERE id = ?', [todayKey(), FLOW_DAILY_LIMIT, id]);
    await db.close();
}

// Flow báo hết lượt bằng chữ trên trang. Chỉ nhận những cụm ĐẶC TRƯNG để không nhầm với chữ khác.
async function detectFlowLimit(page) {
    try {
        const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 4000));
        return /(reached|hit|exceeded).{0,30}(daily )?limit|daily limit|out of (credits|generations)|no (credits|generations) (left|remaining)|hết lượt|đã đạt giới hạn|giới hạn (hằng|hàng) ngày|hết hạn mức|try again tomorrow|quay lại vào ngày mai/i.test(txt);
    } catch { return false; }
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
// ===== MỘT LƯỢT GEN TRONG TRANG ĐANG MỞ =====
// Tách ra khỏi generateFlowImage vì có hai kiểu dùng khác hẳn nhau:
//   • 1 lượt / 1 project  — nút ✨ AI Generate của một cảnh (generateFlowImage bên dưới);
//   • NHIỀU lượt / 1 project — podcast: prompt nhân vật rồi tới từng cảnh phải nằm CÙNG MỘT
//     project Flow, có vậy Flow mới nhớ nhân vật và vẽ giống nhau qua mấy chục tấm
//     (runFlowImageBatch bên dưới).

// Guard BẮT BUỘC ra media: nếu không nêu rõ, Flow (Gemini) hiểu content dài thành chủ đề rồi
// CHAT / viết truyện thay vì tạo ảnh/video (xem create-thumbnail đã phải làm tương tự). Chỉ thị
// cứng này luôn đứng TRƯỚC mọi prompt để buộc Flow xuất media, không hỏi lại, không viết chữ.
// UI agent mới của Flow còn BỎ QUA setting số lượng cũ → phải RA LỆNH số lượng ngay trong prompt.
function mediaOnlyGuard(type, count) {
    const mediaWord = type === 'video' ? 'video clip' : 'image';
    const mediaPlural = type === 'video' ? 'video clips' : 'images';
    const nMedia = count > 1 ? `EXACTLY ${count} distinct ${mediaPlural}` : `EXACTLY one ${mediaWord}`;
    return `Immediately generate ${nMedia} now — do not produce more or fewer than ${count}. This is a direct generation command, NOT a conversation. `
        + `Output ONLY the ${mediaPlural} — do NOT chat, do NOT narrate, do NOT ask questions, do NOT reply with any story, script, outline, plan or explanation. `
        + `If there are several possible interpretations or options, ALWAYS choose the first / most reasonable one and proceed right away. `
        + `NEVER wait for my confirmation and NEVER ask me to choose — just start generating immediately. `;
}

// Số vòng poll (2s/vòng) tính từ lúc gửi prompt mà media hiện ra thì coi là ĐỒ SÓT của lượt trước.
// Gen thật của Flow chưa bao giờ dưới ~15 giây (log thực tế: 17-25s), nên 8 giây là ngưỡng an toàn.
const GRACE_POLLS = 4;
// Nhưng "đồ sót" mà chờ thêm chừng này vòng (~30s) vẫn chẳng thấy ảnh nào khác thì gần như chắc chắn
// nó CHÍNH LÀ ảnh của lượt này (Flow trả nhanh bất thường) -> vớt lại, thay vì ngồi chờ hết 6 phút.
const STALE_RESCUE_POLLS = 15;

// Mọi media đang hiện trên trang. Trả về mảng URL (đã bỏ trùng).
async function collectMediaSrcs(page, mediaTag) {
    return page.evaluate((tag) => {
        const srcs = [];
        for (const el of document.querySelectorAll(tag)) {
            const src = el.src || el.querySelector?.('source')?.src || '';
            if ((tag === 'img' ? el.naturalWidth > 200 : true) && src.startsWith('http') && src.includes('media')) srcs.push(src);
        }
        return [...new Set(srcs)];
    }, mediaTag);
}

// Gõ vào ô prompt rồi bấm gửi. Dùng ô CUỐI: UI agent-chat của Flow đẻ thêm ô nhập ở cuối luồng
// chat sau mỗi lượt, ô đầu trang có khi chỉ còn là chỗ hiển thị.
async function typeAndSubmit(page, text) {
    const box = page.locator('div[contenteditable=true][role=textbox]').last();
    await box.click({ force: true });
    // Prompt cảnh của podcast dài cả nghìn ký tự — gõ 20ms/ký tự là mất nửa phút chỉ để gõ.
    await page.keyboard.type(text, { delay: text.length > 400 ? 5 : 20 });
    await page.waitForTimeout(500);
    const sendBtn = page.locator('button:has(i.google-symbols)').filter({ hasText: /arrow_forward/ }).first();
    if (await sendBtn.count()) await sendBtn.click({ force: true });
    else await page.keyboard.press('Enter');
}

/**
 * Gửi 1 prompt rồi chờ media mới hiện ra. Trả về URL của những media CHƯA THẤY BAO GIỜ.
 *
 * `seen` là Set URL đã biết, do chỗ gọi giữ xuyên suốt phiên — trong một project Flow chạy mấy
 * chục lượt thì đếm theo SỐ LƯỢNG media cũ là hỏng (Flow có lúc bỏ bớt ảnh cũ khỏi DOM khi cuộn),
 * so theo URL thì lượt nào ra ảnh nấy.
 */
async function flowGenerateOnce(page, { prompt, type = 'image', count = 1, seen, seenThumbs = null, saveDirPath, maxPolls = 180 }) {
    const mediaTag = type === 'video' ? 'video' : 'img';
    // CHỐT HIỆN TRẠNG trước khi gửi: mọi media đang có trên trang đều tính là CŨ.
    // Không chốt là dính lỗi lệch ảnh: một lượt gen của Flow có thể lòi ra thêm URL biến thể
    // (bản thu nhỏ / bản lớn) muộn hơn, lượt sau vớ đúng cái sót đó rồi lệch dồn cả bài.
    for (const s of await collectMediaSrcs(page, mediaTag)) seen.add(s);
    await typeAndSubmit(page, prompt);

    console.log(`[Flow] Generating: "${prompt.slice(0, 60)}..." (${type} x${count})`);
    const saved = [];         // tên file ĐÃ nằm trên đĩa
    const tries = new Map();  // src -> số lần tải hụt
    const stale = new Set();  // media lòi ra ngay sau khi gửi = đồ sót của lượt trước
    let staleAt = 0;          // vòng poll ghi nhận "đồ sót" gần nhất (mốc để vớt lại)
    let lastSkipLog = -1;     // chống spam log "bỏ qua media"
    let nudges = 0;           // số lần đã "thúc" agent khi nó đứng im
    let lastActionIter = 0;   // vòng lặp của lần submit/nudge gần nhất
    for (let i = 0; i < maxPolls; i++) {   // poll mỗi 2s, mặc định tối đa 6 phút
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

        // TẢI NGAY khi thấy media mới, không đợi cả lượt xong. Lượt gen hay chết dở giữa chừng
        // (hết giờ chờ, Flow treo, mạng rớt) — đợi tới cuối là mất trắng cả những tấm ĐÃ xong.
        //
        // Hai luật chống LỆCH ẢNH (đã gặp thật: cảnh 23 nhận ảnh của cảnh 21):
        //   • CỬA SỔ ÂN HẠN: media lòi ra trong ~8 giây đầu sau khi gửi là ĐỒ SÓT của lượt trước
        //     (biến thể URL hiện ra muộn), vì gen thật chưa bao giờ nhanh dưới 15 giây;
        //   • lấy từ CUỐI danh sách: Flow nối kết quả mới xuống cuối luồng chat, nên tấm mới nhất
        //     luôn là phần tử cuối; lấy từ đầu là vớ phải đồ sót.
        //
        // KHÔNG chờ dấu hiệu "đang chạy" nữa: agent Flow có lúc trả lời kiểu chat, chẳng hiện thanh %
        // lẫn chữ "Generating" nào mà vẫn ra ảnh — bắt buộc phải thấy dấu hiệu thì ngồi chờ hết
        // 6 phút rồi bỏ cảnh, dù ảnh đã nằm sờ sờ trên màn hình (đã gặp thật ở cảnh S029).
        const unseen = info.srcs.filter(s => !seen.has(s));
        if (i < GRACE_POLLS) unseen.forEach(s => { if (!stale.has(s)) { stale.add(s); staleAt = i; } });
        const want = Math.max(0, count - saved.length);
        // slice(-0) trả về CẢ MẢNG (đặc sản JS) nên phải chặn want = 0 ở đây.
        let fresh = want ? unseen.filter(s => !stale.has(s)).slice(-want) : [];

        // VỚT LẠI đồ sót: chờ mãi không thấy ảnh nào khác thì cái "sót" kia chính là ảnh của lượt này.
        if (!fresh.length && !saved.length && stale.size && (i - staleAt) >= STALE_RESCUE_POLLS) {
            const rescued = unseen.filter(s => stale.has(s)).slice(-want);
            if (rescued.length) {
                console.warn(`[Flow] ⚠ Chờ ${Math.round((i - staleAt) * 2)}s không thấy ảnh mới → nhận lại ${rescued.length} media đã xếp vào "đồ sót"`);
                rescued.forEach(s => stale.delete(s));
                fresh = rescued;
            }
        }
        if (unseen.length > fresh.length && unseen.length !== lastSkipLog) {
            lastSkipLog = unseen.length;
            console.log(`[Flow] bỏ qua ${unseen.length - fresh.length} media không phải của lượt này`);
        }
        if (fresh.length) {
            await page.waitForTimeout(2000);                 // để ảnh/clip nạp xong hẳn rồi mới tải
            for (const src of fresh) {
                const files = await saveFlowMedia(page, src, saveDirPath, type, seenThumbs);
                if (files.length) {
                    seen.add(src);                           // tải được rồi mới đánh dấu đã xử lý
                    saved.push(...files);
                    console.log(`[Flow] ⤓ ${saved.length}/${count}`);
                    continue;
                }
                // Tải hụt (URL chưa sẵn sàng / 5xx): để nguyên cho vòng sau thử lại, quá 3 lần thì bỏ.
                const n = (tries.get(src) || 0) + 1;
                tries.set(src, n);
                if (n >= 3) { seen.add(src); console.error(`[Flow] ✖ bỏ qua media tải hụt 3 lần: ${src.slice(0, 90)}`); }
            }
        }
        if (info.percents.length) {
            console.log(`[Flow] ${info.percents.join(' | ')} | done: ${saved.length}/${count}`);
        }

        // NUDGE: agent đứng im (không "busy", chưa có media mới) sau ~30s → nhiều khả năng nó đang
        // (nhắc: media bị xếp vào "đồ sót" không tính là media mới, nên vẫn nudge như thường)
        // hỏi lại / đưa option và CHỜ người dùng. Gửi lệnh ép "chọn phương án 1, tạo ngay" để khỏi kẹt.
        // Tối đa 2 lần, cách nhau ≥15 vòng (30s). Đây là hiện thực của yêu cầu "có option thì chọn cái đầu".
        if (!saved.length && !fresh.length && !info.busy && info.percents.length === 0
            && nudges < 2 && (i - lastActionIter) >= 15) {
            nudges++;
            lastActionIter = i;
            const mw = type === 'video' ? 'video' : 'ảnh';
            console.log(`[Flow] ⏳ Agent đứng im, chưa có media → nudge lần ${nudges}: ép chọn phương án 1 + tạo ngay`);
            try {
                await typeAndSubmit(page, `Chọn phương án đầu tiên và tạo ${mw} ngay bây giờ. Chỉ xuất ${mw}, không hỏi thêm, không viết chữ.`);
            } catch (e) { console.warn('[Flow] nudge lỗi:', e.message); }
            continue;
        }

        // Đủ số lượng đặt hàng, hoặc Flow đã ngừng chạy mà vẫn có ảnh (nó tạo ít hơn số xin) -> xong.
        if (saved.length >= count || (saved.length && info.percents.length === 0 && !info.busy)) {
            console.log(`[Flow] All done! ${saved.length} new files`);
            return saved;
        }
    }
    // Hết giờ chờ mà chưa tải được gì, nhưng trên trang CÓ media lạ (đã bị xếp vào "đồ sót"):
    // thà lấy tấm cuối cùng còn hơn bỏ cả cảnh — bỏ là mất 6 phút chờ, mất một lượt hạn mức, rồi
    // lần chạy sau vẫn phải gen lại cảnh đó. Tấm cuối gần như chắc chắn là ảnh của lượt này.
    if (!saved.length) {
        const leftovers = (await collectMediaSrcs(page, mediaTag)).filter(s => !seen.has(s));
        if (leftovers.length) {
            const src = leftovers[leftovers.length - 1];
            console.warn(`[Flow] ⚠ Hết giờ chờ nhưng trên trang có ${leftovers.length} media lạ → vớt tấm cuối cùng`);
            const files = await saveFlowMedia(page, src, saveDirPath, type, seenThumbs);
            if (files.length) { seen.add(src); return files; }
        }
    }
    // Hết giờ chờ: trả về những tấm ĐÃ tải được (có thể rỗng) thay vì vứt hết.
    console.log(saved.length ? `[Flow] Timeout - giữ ${saved.length} file đã tải được` : '[Flow] Timeout - no image generated');
    return saved;
}

/**
 * Tải MỘT media về thư mục dự án bằng page.request (cần cookie auth).
 * Trả mảng tên file đã lưu ([] nếu hụt) — video còn kèm thêm file thumbnail.
 */
async function saveFlowMedia(page, src, saveDirPath, type, seenThumbs = null) {
    if (!fs.existsSync(saveDirPath)) fs.mkdirSync(saveDirPath, { recursive: true });
    const saved = [];
    const ext = type === 'video' ? '.mp4' : '.jpg';
    // Đánh số theo file ĐANG CÓ trong thư mục -> tải rời từng tấm vẫn ra flow_1, flow_2... liền mạch.
    const idx = fs.readdirSync(saveDirPath).filter(f => f.startsWith('flow_') && f.endsWith(ext)).length + 1;
    const fileName = `flow_${idx}${ext}`;
    try {
        const res = await page.request.get(src);
        if (!res.ok()) { console.error(`[Flow] Download failed ${res.status()}: ${src.slice(0, 90)}`); return []; }
        const body = await res.body();
        // File tí xíu = trang lỗi/ảnh tạm chứ không phải media thật -> coi như hụt, vòng sau tải lại.
        if (body.length < 5000) { console.warn(`[Flow] Bỏ qua file ${body.length}B (chưa phải media thật)`); return []; }
        fs.writeFileSync(path.join(saveDirPath, fileName), body);
        saved.push(fileName);
        console.log(`[Flow] Saved: ${fileName}`);
    } catch (e) { console.error(`[Flow] Download error: ${e.message}`); return []; }

    // Video: tải thêm thumbnail (ảnh mới xuất hiện kèm clip vừa gen)
    if (type === 'video' && seenThumbs) {
        const thumbSrc = (await collectMediaSrcs(page, 'img')).find(s => !seenThumbs.has(s));
        if (thumbSrc) {
            seenThumbs.add(thumbSrc);
            const thumbName = `flow_${idx}_thumbnail.jpg`;
            try {
                const thumbRes = await page.request.get(thumbSrc);
                if (thumbRes.ok()) {
                    fs.writeFileSync(path.join(saveDirPath, thumbName), await thumbRes.body());
                    saved.push(thumbName);
                    console.log(`[Flow] Saved: ${thumbName}`);
                }
            } catch (e) { console.error(`[Flow] Thumb download error: ${e.message}`); }
        }
    }
    return saved;
}

// Mở tool Flow: vào trang, qua cửa đăng nhập Google, gỡ popup onboarding.
async function openFlowTool(page) {
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
}

// Tạo project Flow MỚI (nút add_2). Trả về URL project để lần sau quay lại đúng chỗ.
async function createFlowProject(page) {
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
    return page.url();
}

// Mở lại project Flow đã tạo trước đó (chạy tiếp mẻ sau của cùng một dự án podcast).
// Trả về true nếu vào được và có ô prompt để gõ.
async function reopenFlowProject(page, projectUrl) {
    try {
        await page.goto(projectUrl, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(3000);
        await dismissFlowPopups(page);
        if (page.url().includes('accounts.google.com')) return false;
        const box = page.locator('div[contenteditable=true][role=textbox]');
        await box.last().waitFor({ timeout: 15000 });
        return true;
    } catch (e) {
        console.warn(`[Flow] Không mở lại được project cũ (${e.message})`);
        return false;
    }
}

// Modal settings (button chứa cả ratio và count, ví dụ: "Videocrop_16_9x2")
async function applyFlowSettings(page, { type, count, ratio, videoMode, veo, selectedImages = [] }) {
    const settingsBtn = page.locator('button:visible').filter({ hasText: /x[1-4]$/ });
    if (!await settingsBtn.count()) return;
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

export async function generateFlowImage(keyword, saveDirPath, content = '', type = 'image', count = 2, lang = 'en', customPrompt = '', ratio = '16:9', videoMode = 'Frames', veo = 'Fast', selectedImages = []) {
    const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
    let promptTemplate = customPrompt;
    if (!promptTemplate) {
        const promptFile = path.join(MEDIA_DIR, 'prompts', type, `prompt_flow_${lang}.txt`);
        const fallbackFile = path.join(MEDIA_DIR, 'prompts', type, 'prompt_flow.txt');
        const raw = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : fs.existsSync(fallbackFile) ? fs.readFileSync(fallbackFile, 'utf8') : '';
        promptTemplate = raw.trim().replace(/\n/g, ' ');
    }
    const promptBody = promptTemplate ? `${promptTemplate} ${content}` : content || keyword;
    const fullPrompt = `${mediaOnlyGuard(type, count)}${promptBody}`;
    if (!fs.existsSync(saveDirPath)) fs.mkdirSync(saveDirPath, { recursive: true });

    // Profile xài ít nhất hôm nay và CÒN hạn mức Flow (~50 ảnh/ngày/tài khoản).
    const profile = await getNextProfile();
    if (!profile) {
        console.error(`[Flow] ✖ Mọi tài khoản đã cạn hạn mức hôm nay (${FLOW_DAILY_LIMIT} ảnh/ngày) — thử lại ngày mai hoặc thêm profile.`);
        return [];
    }
    const profileDir = profile.profile_dir;
    const profileId = profile.id;
    console.log(`[Flow] Dùng tài khoản #${profileId} ${profile.email || ''} (còn ${profile.left}/${FLOW_DAILY_LIMIT} ảnh hôm nay)`);

    const ctx = await getBrowser(profileDir, profile?.proxy);
    const page = ctx.pages()[0] || await ctx.newPage();

    try {
        await openFlowTool(page);
        await createFlowProject(page);
        await applyFlowSettings(page, { type, count, ratio, videoMode, veo, selectedImages });

        // Media đang có TRƯỚC khi gen — chỉ những cái ngoài danh sách này mới là của lượt này.
        const mediaTag = type === 'video' ? 'video' : 'img';
        const seen = new Set(await collectMediaSrcs(page, mediaTag));
        const seenThumbs = type === 'video' ? new Set(await collectMediaSrcs(page, 'img')) : null;

        // Tải ngay từng tấm khi Flow vừa xuất ra, không đợi cả lượt xong.
        const files = await flowGenerateOnce(page, { prompt: fullPrompt, type, count, seen, seenThumbs, saveDirPath });
        // Đếm theo số MEDIA đã gen (file thumbnail của video đi kèm, không tính là một lượt gen).
        const made = files.filter(f => !f.includes('_thumbnail')).length;
        if (made) await bumpProfileFlow(profileId, made);
        else if (await detectFlowLimit(page)) {
            console.warn(`[Flow] ⚠ Tài khoản #${profileId} bị Flow báo hết lượt → đóng sổ hôm nay`);
            await markProfileOutOfQuota(profileId);
        }
        return files;
    } catch (e) {
        console.error('[Flow] Error:', e.message);
        return [];
    } finally {
        await page.close().catch(() => {});
        try { await ctx.close(); } catch (_) {}
        if (profileId) await markProfileUsed(profileId);
    }
}

/**
 * NHIỀU PROMPT TRONG CÙNG MỘT PROJECT FLOW, TỰ ĐỔI TÀI KHOẢN KHI CẠN HẠN MỨC.
 *
 * Dùng cho podcast: prompt nhân vật chạy trước để Flow "biết mặt" nhân vật, rồi từng cảnh chạy tiếp
 * trong CHÍNH project đó — nhân vật giữa các tấm mới giống nhau. Mỗi lượt gọi generateFlowImage là
 * một project riêng nên không làm được việc này.
 *
 * XOAY VÒNG TÀI KHOẢN: Flow chỉ cho ~50 ảnh/ngày mỗi tài khoản (FLOW_DAILY_LIMIT), mà một bài đã 55
 * lượt. Hết hạn mức thì đóng trình duyệt, mở profile khác và làm tiếp. Project Flow thuộc về TÀI
 * KHOẢN nên mỗi profile có project riêng — đổi tài khoản là Flow quên sạch nhân vật, phải gen lại
 * prompt nhân vật trong project mới (đó là cái giá của việc đổi: N ảnh nhân vật cho mỗi lần đổi).
 *
 * @param items  [{ key, prompt, saveDir }] — chạy đúng thứ tự trong mảng, mỗi phần tử ra 1 ảnh.
 * @param opts.primeItems  Prompt "mồi" (nhân vật). Chỉ chạy khi phải TẠO PROJECT MỚI: project cũ mở
 *                         lại được thì nhân vật vẫn nằm trong luồng chat, gen lại là phí.
 * @param opts.projectUrlByProfile  { "<id profile>": "url project" } của những lần chạy trước → gặp
 *                         lại profile nào thì mở lại đúng project của profile đó.
 * @param opts.onProject   (url, reused, profileId) — ghi vào file trạng thái NGAY, trước khi gen.
 * @param opts.onItem      (item, { files, error }) sau MỖI item — chỗ gọi lưu trạng thái ở đây.
 * @returns { results, projects, noQuota, aborted }  noQuota = dừng vì hết tài khoản còn hạn mức.
 */
export async function runFlowImageBatch(items, opts = {}) {
    const { ratio = '16:9', count = 1, primeItems = [], projectUrlByProfile = {}, legacyProjectUrl = '',
            onProject = null, onItem = null } = opts;
    const results = [];
    const projects = { ...projectUrlByProfile };
    if (!items.length) return { results, projects, noQuota: false, aborted: false };

    const pending = items.slice();       // còn phải làm, xong tới đâu bỏ tới đó
    const usedProfiles = [];             // profile đã dùng trong phiên (cạn hạn mức hoặc lỗi)
    let noQuota = false, aborted = false;

    while (pending.length && !aborted) {
        // Ưu tiên tài khoản đang giữ project Flow của bài này -> mở lại project cũ, khỏi mồi nhân vật.
        const profile = await getNextProfile({ exclude: usedProfiles, prefer: Object.keys(projects) });
        if (!profile) {
            noQuota = true;
            console.error(`[Flow] ✖ Không còn tài khoản nào còn hạn mức hôm nay (${FLOW_DAILY_LIMIT} ảnh/ngày/tài khoản) `
                + `— còn ${pending.length} prompt chưa làm, mai chạy lại sẽ tiếp tục.`);
            break;
        }
        usedProfiles.push(profile.id);
        let left = profile.left;
        console.log(`[Flow] ▣ Tài khoản #${profile.id} ${profile.email || ''}: còn ${left}/${FLOW_DAILY_LIMIT} ảnh hôm nay `
            + `· còn ${pending.length} prompt phải làm`);

        const ctx = await getBrowser(profile.profile_dir, profile.proxy);
        const page = ctx.pages()[0] || await ctx.newPage();
        try {
            await openFlowTool(page);
            // Project cũ CỦA CHÍNH profile này mở lại được thì dùng tiếp (nhân vật còn nguyên trong
            // luồng chat); hỏng hoặc chưa có thì tạo mới rồi mồi lại nhân vật.
            // legacyProjectUrl: state.json đời đầu chỉ nhớ MỘT url (chưa gắn với profile nào). Thử mở
            // cho profile đầu tiên — đúng tài khoản thì vào lại được project cũ, sai tài khoản thì
            // reopenFlowProject tự trả false và ta tạo project mới, không mất mát gì.
            const stored = projects[profile.id] || (Object.keys(projects).length ? '' : legacyProjectUrl);
            const reused = stored ? await reopenFlowProject(page, stored) : false;
            let url = stored;
            if (reused) console.log(`[Flow] Chạy tiếp trong project cũ: ${url}`);
            else {
                url = await createFlowProject(page);
                console.log(`[Flow] Project mới của tài khoản #${profile.id}: ${url}`);
            }
            // Tài khoản mới mà hạn mức còn lại không đủ mồi hết nhân vật thì mồi xong là cạn, KHÔNG ra
            // nổi một cảnh nào — đốt lượt để lấy về số không. Bỏ qua, để dành cho hôm sau.
            if (!reused && primeItems.length && left <= primeItems.length) {
                console.warn(`[Flow] ⏭ Bỏ qua tài khoản #${profile.id}: còn ${left} ảnh, không đủ mồi ${primeItems.length} nhân vật `
                    + '(mồi xong là cạn, chẳng ra được cảnh nào)');
                continue;
            }
            projects[profile.id] = url;
            if (onProject) await onProject(url, reused, profile.id);
            await applyFlowSettings(page, { type: 'image', count, ratio });

            const queue = reused ? pending.slice()
                : [...primeItems.filter(p => !pending.some(i => i.key === p.key)), ...pending];
            if (!reused && queue.length > pending.length) {
                console.log(`[Flow] Project mới → mồi lại ${queue.length - pending.length} prompt nhân vật trước `
                    + `(tốn ngần ấy hạn mức, nhưng không mồi thì cảnh vẽ ra người khác)`);
            }

            const seen = new Set(await collectMediaSrcs(page, 'img'));
            let fails = 0;
            for (const [i, item] of queue.entries()) {
                if (left <= 0) {
                    console.log(`[Flow] Tài khoản #${profile.id} đã hết hạn mức hôm nay → đổi tài khoản`);
                    break;
                }
                console.log(`[Flow] ── ${i + 1}/${queue.length} · ${item.key} (còn ${left} ảnh ở tài khoản này)`);
                try {
                    // Ảnh về đĩa NGAY trong lúc lượt này còn chạy: phiên podcast dài cả tiếng, trình duyệt
                    // chết giữa chừng thì những tấm đã xong vẫn còn nguyên trong thư mục dự án.
                    const files = await flowGenerateOnce(page, {
                        prompt: `${mediaOnlyGuard('image', count)}${item.prompt}`,
                        type: 'image', count, seen, saveDirPath: item.saveDir,
                    });
                    if (files.length) {
                        left -= files.length;
                        await bumpProfileFlow(profile.id, files.length);
                    }
                    if (!files.length) {
                        // Không ra ảnh: hỏi thẳng trang xem có phải Flow báo hết lượt không. Nếu đúng thì
                        // KHÔNG tính là lỗi của prompt — để nguyên trong hàng chờ rồi đổi tài khoản.
                        if (await detectFlowLimit(page)) {
                            console.warn(`[Flow] ⚠ Tài khoản #${profile.id} bị Flow báo hết lượt → đóng sổ hôm nay, đổi tài khoản`);
                            await markProfileOutOfQuota(profile.id);
                            left = 0;
                            break;
                        }
                        throw new Error('Flow không trả về ảnh nào (hết giờ chờ hoặc bị chặn)');
                    }
                    fails = 0;
                    const at = pending.findIndex(p => p.key === item.key);
                    if (at >= 0) pending.splice(at, 1);
                    results.push({ key: item.key, files });
                    if (onItem) await onItem(item, { files });
                } catch (e) {
                    fails++;
                    console.error(`[Flow] ✖ ${item.key}: ${e.message}`);
                    const at = pending.findIndex(p => p.key === item.key);
                    if (at >= 0) pending.splice(at, 1);     // lỗi thật -> đừng bắt tài khoản sau làm lại
                    results.push({ key: item.key, files: [], error: e.message });
                    if (onItem) await onItem(item, { files: [], error: e.message });
                    // Ba lượt liên tiếp trắng tay = phiên đã hỏng (mất đăng nhập, Flow đổi UI). Chạy nốt
                    // mấy chục prompt còn lại chỉ tổ mất cả tiếng để cùng thất bại — và đổi tài khoản
                    // cũng vô ích vì lỗi không nằm ở hạn mức.
                    if (fails >= 3) {
                        console.error('[Flow] ✖ 3 lượt liên tiếp không ra ảnh → dừng phiên, chạy lại sau sẽ tiếp tục từ đây');
                        aborted = true;
                        break;
                    }
                }
            }
        } catch (e) {
            console.error('[Flow] Error:', e.message);
        } finally {
            await page.close().catch(() => {});
            try { await ctx.close(); } catch (_) {}
            await markProfileUsed(profile.id);
        }
    }
    return { results, projects, noQuota, aborted };
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
