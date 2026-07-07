// Đọc cookies đăng nhập X (auth_token, ct0) từ 1 profile Playwright đã login.
// In ra stdout JSON: {"auth_token":"...","ct0":"..."} — dùng cho twscrape.
// Chạy:  node x_cookies.js <profileDir|chrome-profile-4>   (mặc định: chrome-profile-x)
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';

const SETTING_DIR = process.env.SETTING_DIR || path.join(process.env.HOME, '.cache', 'ms-playwright');
const arg = process.argv[2] || 'chrome-profile-x';
const PROFILE = path.isAbsolute(arg) ? arg : path.join(SETTING_DIR, arg);

(async () => {
    const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
    const cookies = await ctx.cookies('https://x.com').catch(() => []);
    await ctx.close();
    const get = (n) => cookies.find(c => c.name === n)?.value || '';
    const auth_token = get('auth_token');
    const ct0 = get('ct0');
    if (!auth_token || !ct0) {
        console.error(`THIẾU cookies X (auth_token/ct0) trong profile "${arg}". Hãy mở profile đó và đăng nhập X trước.`);
        process.exit(1);
    }
    process.stdout.write(JSON.stringify({ auth_token, ct0 }));
})();
