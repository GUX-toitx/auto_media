// File: test_single.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';

puppeteer.use(StealthPlugin());

// 🛑 1. BẠN HÃY ĐIỀN 1 CON PROXY VÀO ĐÂY ĐỂ TEST
const PROXY_SERVER = 'http://23.142.16.54:16624'; // Ví dụ: http://ip:port
const PROXY_USER = 'thanhle';
const PROXY_PASS = 'k7m4x9q2t8bz';

// 🛑 2. CHỌN 1 PROFILE MÀ BẠN CHẮC CHẮN ĐÃ LOGIN BẰNG TAY (IP VIỆT NAM)
const PROFILE_NUMBER = 1; 

async function runTest() {
    console.log(`\n🕵️‍♂️ BẮT ĐẦU TEST ĐƠN LUỒNG: PROFILE + PROXY`);
    const profilePath = path.join(process.cwd(), 'setting', `chrome-profile-${PROFILE_NUMBER}`);

    const browser = await puppeteer.launch({ 
        headless: false, // 🟢 Bật UI để nhìn tận mắt
        userDataDir: profilePath,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--window-size=1280,720',
            `--proxy-server=${PROXY_SERVER}` // Gắn thẳng proxy vào
        ] 
    });

    try {
        const page = await browser.newPage();

        // Xác thực Proxy trước khi đi đâu cả
        if (PROXY_USER && PROXY_PASS) {
            await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log(`🌐 Đang truy cập kiểm tra IP...`);
        await page.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded' });
        const ip = await page.evaluate(() => document.body.innerText);
        console.log(`👉 IP hiện tại của Trình duyệt: ${ip}`);

        console.log(`🚀 Đang phi thẳng vào DVIDS...`);
        // Bật hiển thị lỗi mạng ra console để xem có file CSS nào bị Proxy chặn không
        page.on('requestfailed', request => {
            console.log(`   [Mạng] Lỗi tải: ${request.url()} - ${request.failure().errorText}`);
        });

        await page.goto('https://www.dvidshub.net/', { waitUntil: 'networkidle2', timeout: 60000 });

        console.log(`\n👀 HÃY NHÌN VÀO TRÌNH DUYỆT! Bạn có 60 giây để quan sát:`);
        console.log(`1. Giao diện có bị rách (thiếu CSS) không?`);
        console.log(`2. Nút Login có bị hiện lại (tức là Cookie IP Việt Nam đã bị đá văng) không?`);
        
        await new Promise(r => setTimeout(r, 60000));

    } catch (e) {
        console.error(`❌ Lỗi Test: ${e.message}`);
    } finally {
        await browser.close();
        console.log(`🏁 KẾT THÚC TEST.`);
    }
}

runTest();
