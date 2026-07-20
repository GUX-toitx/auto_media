// Đăng nhập X (Twitter) thủ công 1 lần — lưu session vào setting/chrome-profile-x
// Dùng lại cho: twscrape (đọc cookies) + chụp/quay màn hình bài viết.
// Chạy:  node x_login.js
import { chromium } from 'playwright';
import path from 'path';
import readline from 'readline';

const PROFILE = path.join(process.cwd(), 'setting', 'chrome-profile-x');

(async () => {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 900 },
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://x.com/login').catch(() => {});
    console.log('\n👉 Đăng nhập X trong cửa sổ trình duyệt vừa mở.');
    console.log('   Xong thì quay lại terminal này và bấm ENTER để lưu session + đóng.\n');
    await new Promise((res) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('', () => { rl.close(); res(); });
    });
    // Xác nhận đã có cookies đăng nhập
    const cookies = await ctx.cookies('https://x.com').catch(() => []);
    const ok = cookies.some(c => c.name === 'auth_token') && cookies.some(c => c.name === 'ct0');
    await ctx.close();
    console.log(ok ? `✅ Đã lưu session X vào ${PROFILE}` : '⚠️ Chưa thấy cookies đăng nhập (auth_token/ct0). Hãy chạy lại và đăng nhập đầy đủ.');
    process.exit(ok ? 0 : 1);
})();
