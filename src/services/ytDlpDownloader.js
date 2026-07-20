// File: ytDlpDownloader.js
import { spawn } from 'child_process';
import path from 'path';

/**
 * Hàm tải video từ MXH bằng "Vũ khí hạng nặng" yt-dlp
 * @param {string} url - Link TikTok, Facebook, X, Youtube...
 * @param {string} destPath - Đường dẫn file lưu thành quả
 */
export async function downloadWithYtDlp(url, destPath) {
    return new Promise((resolve, reject) => {
        console.log(`\x1b[36m      [YT-DLP] 🚀 Đang thả Bot cắn link: ${url.substring(0, 50)}...\x1b[0m`);

        // Bộ tham số "Phá giáp" MXH
        const args = [
            '--no-warnings', // Tắt mấy cảnh báo lặt vặt cho log sạch sẽ
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', // Ép định dạng MP4 nét nhất
            '--merge-output-format', 'mp4',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', // Ngụy trang thành Chrome PC
            // '--cookies-from-browser', 'chrome', // 🟢 BÍ KÍP: Mở comment dòng này nếu muốn mượn Cookie từ Chrome trên máy chủ để tải FB/Group kín
            '-o', destPath,
            url
        ];

        const proc = spawn('yt-dlp', args);
        let errorLog = '';

        // Bắt log tiến độ tải (Tùy chọn: Bạn có thể bật lên để xem % tải)
        proc.stdout.on('data', (data) => {
            const message = data.toString().trim();
            // Bỏ comment dòng dưới nếu muốn terminal nhảy liên tục % tải file
            // if (message.includes('[download]')) console.log(`      [YT-DLP] ⬇️ ${message}`); 
        });

        // Bắt lỗi đỏ (Cực kỳ quan trọng để debug)
        proc.stderr.on('data', (data) => {
            errorLog += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                console.log(`\x1b[36m      [YT-DLP] ✅ Tải thành công MP4 xịn: ${path.basename(destPath)}\x1b[0m`);
                resolve(true);
            } else {
                console.error(`\x1b[31m      [YT-DLP] ❌ Thất bại (Mã ${code}). Lỗi chi tiết:\n${errorLog.trim()}\x1b[0m`);
                reject(new Error(`yt-dlp lỗi: ${errorLog.split('\n')[0]}`)); // Chỉ ném lên lỗi ngắn gọn cho API
            }
        });

        proc.on('error', (err) => {
            console.error(`\x1b[31m      [YT-DLP] ❌ Không thể khởi động yt-dlp: ${err.message}\x1b[0m`);
            reject(err);
        });
    });
}
