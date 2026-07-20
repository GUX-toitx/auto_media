// File: login.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';

puppeteer.use(StealthPlugin());

const TOTAL_PROFILES = 26; // Điền số lượng Profile bạn muốn login

function clearSessionMemory(profilePath) {
    const defaultDir = path.join(profilePath, 'Default');
    const sessionsDir = path.join(defaultDir, 'Sessions');

    try {
        if (fs.existsSync(sessionsDir)) {
            fs.rmSync(sessionsDir, { recursive: true, force: true });
        }
        const filesToDelete = ['Last Session', 'Last Tabs', 'Current Session', 'Current Tabs'];
        for (const file of filesToDelete) {
            const filePath = path.join(defaultDir, file);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
    } catch (e) {
        // Bỏ qua
    }
}

async function loginManual(profileNumber) {
    const profilePath = path.join(process.cwd(), 'setting', `chrome-profile-${profileNumber}`);
    
    console.log(`\n===========================================`);
    console.log(`🚀 ĐANG MỞ PROFILE SỐ [${profileNumber}]`);
    console.log(`===========================================`);

    clearSessionMemory(profilePath);

    const browser = await puppeteer.launch({ 
        headless: false, 
        userDataDir: profilePath,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--window-size=1280,720',
            '--hide-crash-restore-bubble'
        ] 
    });

    try {
        const page = await browser.newPage();
        await page.goto('https://www.dvidshub.net/', { waitUntil: 'domcontentloaded' });

        console.log(`⏳ BẠN HÃY ĐĂNG NHẬP VÀO TRANG DVIDS...`);
        console.log(`👉 Đăng nhập xong, hãy TỰ BẤM DẤU [X] TẮT TRÌNH DUYỆT để chuyển sang Profile tiếp theo!`);
        
        // 🟢 CẢI TIẾN: Bỏ delay 120s. Bắt code đứng đợi cho đến khi user tự đóng Browser
        await new Promise(resolve => browser.on('disconnected', resolve));

    } catch (e) {
        console.error(`Lỗi: ${e.message}`);
    } finally {
        console.log(`✅ Đã lưu Cookie Profile [${profileNumber}]. Chuyển qua luồng mới...`);
    }
}

async function run() {
    for (let i = 1; i <= TOTAL_PROFILES; i++) {
        await loginManual(i);
    }
    console.log("\n🎉 ĐÃ HOÀN TẤT BƠM COOKIE CHO TẤT CẢ CÁC PROFILE!");
    process.exit(0);
}

run();