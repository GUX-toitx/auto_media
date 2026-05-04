// File: proxyManager.js
import fs from 'fs';
import { ProxyAgent } from 'undici';

// 1. Đọc file txt 1 lần duy nhất khi khởi động
const proxyLines = fs.readFileSync('./proxies.txt', 'utf8').split('\n');

// 2. Parse dữ liệu thành mảng Object (Hàng đợi)
const proxyQueue = proxyLines
    .filter(line => line.trim()) // Bỏ các dòng trống
    .map(line => {
        // Cấu trúc file: IP:PORT:USER:PASS
        const [ip, port, user, pass] = line.trim().split(':');
        return {
            server: `http://${ip}:${port}`,
            username: user,
            password: pass,
            url: `http://${user}:${pass}@${ip}:${port}`,
            updated_at: 0 // Ban đầu chưa ai làm việc nên gán bằng 0
        };
    });

console.log(`[PROXY] Đã nạp thành công ${proxyQueue.length} proxy vào hàng đợi!`);

// Khóa chống đụng độ đa luồng
let isPicking = false; 

export async function getOldestProxy() {
    if (proxyQueue.length === 0) return null;

    // Nếu đang chạy đa luồng, bắt các luồng đợi nhau vài mili-giây để không lấy trùng 1 thằng đầu hàng
    while (isPicking) {
        await new Promise(r => setTimeout(r, 5));
    }
    isPicking = true;

    // TUYỆT CHIÊU XOAY VÒNG TRÒN
    // Bước 1: Rút thẳng proxy đang đứng đầu hàng (updated_at cũ nhất)
    const selectedProxy = proxyQueue.shift();

    // Bước 2: Cập nhật thời gian làm việc thành mới nhất
    selectedProxy.updated_at = Date.now();

    // Bước 3: Đẩy nó xuống cuối hàng
    proxyQueue.push(selectedProxy);

    isPicking = false;

    // Trả về cho Puppeteer và hàm Fetch sử dụng
    return {
        server: selectedProxy.server,
        username: selectedProxy.username,
        password: selectedProxy.password,
        dispatcher: new ProxyAgent(selectedProxy.url)
    };
}
