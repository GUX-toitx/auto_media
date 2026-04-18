import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import parser from 'subtitles-parser';

// --- CẤU HÌNH ---
const BASE_DIR = '/usr/gux/media-team';
const PUBLIC_KEY = 'test_9cb0c8fde8b26045c96741419208b3375aaa29be8a7cb53bdcdd014c9cf';
const PRIVATE_KEY = 'test_642f2b19c5e574d3f189f28b78a1d1c802f0802ab385be61ed6c6a5bafc';

// --- HÀM BỔ TRỢ ---

// 1. Tạo URL Storyblocks với chữ ký HMAC
function buildStoryblocksUrlV2(resource, params = {}) {
    const expires = Math.floor(Date.now() / 1000) + 3600; // Hết hạn sau 1 giờ

    // 1. Tạo HMAC theo chuẩn Storyblocks V2
    // Key mã hóa = Private Key + Expires
    // Data cần mã hóa = Đường dẫn (Ví dụ: /api/v2/videos/search)
    const hmacKey = PRIVATE_KEY + expires;
    const hmac = crypto
        .createHmac('sha256', hmacKey)
        .update(resource)
        .digest('hex');

    // 2. Gộp các tham số bắt buộc của V2
    const queryParams = new URLSearchParams({
        ...params,
        APIKEY: PUBLIC_KEY,
        EXPIRES: expires,
        HMAC: hmac,
        project_id: 'cory_corner_auto', // Bắt buộc ở V2
        user_id: 'khaitm_dev'           // Bắt buộc ở V2
    });

    return `https://api.storyblocks.com${resource}?${queryParams.toString()}`;
}

// 2. Chuyển SRT time sang giây
function srtTimeToSeconds(timeStr) {
    const [hms, ms] = timeStr.replace('.', ',').split(',');
    const [h, m, s] = hms.split(':');
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + (parseInt(ms) / 1000);
}

// 3. Mapping từ khóa dựa trên nội dung sub (Skip nếu cần)
function extractKeywords(text) {
    const k = text.toLowerCase();
    // Logic Skip theo yêu cầu của bạn
    if (k.includes('cảm ơn') || k.includes('chào bạn') || k.includes('điều gì sẽ xảy ra')) return null;

    if (k.includes('ức chế')) return 'stunted fish growth';
    if (k.includes('tăng trưởng bù')) return 'compensatory growth fish';
    if (k.includes('bể')) return 'aquarium tank size';
    if (k.includes('thay nước')) return 'aquarium water change';
    if (k.includes('nước đen')) return 'blackwater aquarium';
    
    // Nếu không khớp từ khóa cụ thể, lấy 3 từ đầu để search chung chung hoặc trả về null để skip
    return 'aquarium fish life'; 
}

// 4. Hàm tải Stock
async function fetchAndDownload(keyword, type, dest) {
    if (!keyword || fs.existsSync(dest)) return;

    // Dùng Endpoint chuẩn của V2
    const resource = type === 'video' ? '/api/v2/videos/search' : '/api/v2/images/search';
    
    // Tạo URL với tham số tìm kiếm
    const url = buildStoryblocksUrlV2(resource, { 
        keywords: keyword, 
        results_per_page: 1 // V2 dùng results_per_page thay vì num_results
    });

    try {
        const response = await fetch(url);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[!] Lỗi API V2 ${type} (${response.status}): ${errorText.slice(0, 100)}`);
            return;
        }

        const data = await response.json();
        
        const item = data.results?.[0];
        if (item) {
            // V2 trả về preview_url cho cả ảnh và video
            const downloadUrl = item.preview_url;
            
            if (downloadUrl) {
                const res = await fetch(downloadUrl);
                if (!res.ok) throw new Error("Link CDN bị lỗi");
                
                const buffer = await res.arrayBuffer();
                fs.writeFileSync(dest, Buffer.from(buffer));
                console.log(`[+] Đã tải stock ${type} cho: ${keyword}`);
            }
        } else {
            console.log(`[-] Không tìm thấy ảnh/video nào cho: ${keyword}`);
        }
    } catch (e) {
        console.error(`[!] Lỗi mạng khi xử lý ${type} "${keyword}": ${e.message}`);
    }
}

// --- LUỒNG XỬ LÝ CHÍNH ---

async function main() {
    console.log(`[*] Bắt đầu quét thư mục: ${BASE_DIR}`);

    // Lấy danh sách các thư mục videoId
    const videoFolders = fs.readdirSync(BASE_DIR).filter(f => {
        return fs.statSync(path.join(BASE_DIR, f)).isDirectory();
    });

    for (const videoId of videoFolders) {
        const targetDir = path.join(BASE_DIR, videoId);
        const srtPath = path.join(targetDir, 'sub.srt');
        const videoPath = path.join(targetDir, 'original.mp4');

        // Kiểm tra xem Phase 1 đã xong chưa (phải có sub và video gốc)
        if (!fs.existsSync(srtPath) || !fs.existsSync(videoPath)) {
            console.log(`[-] Skip ${videoId}: Chưa có file sub.srt hoặc original.mp4`);
            continue;
        }

        console.log(`\n[>>>] Đang xử lý tài nguyên cho: ${videoId}`);
        const srtContent = fs.readFileSync(srtPath, 'utf8');
        const subBlocks = parser.fromSrt(srtContent);

        for (const block of subBlocks) {
            const subNo = block.id;
            const keyword = extractKeywords(block.text);
            
            // Đường dẫn folder assets (đã tạo ở Phase 1)
            const videoFolder = path.join(targetDir, 'assets', '_raw_videos', subNo);
            const imageFolder = path.join(targetDir, 'assets', '_raw_images', subNo);

            // 1. Tải Stock từ Storyblocks (Nếu không bị SKIP)
            if (keyword) {
                await fetchAndDownload(keyword, 'video', path.join(videoFolder, 'stock.mp4'));
                await fetchAndDownload(keyword, 'image', path.join(imageFolder, 'stock.jpg'));
            } else {
                console.log(`[Block ${subNo}] Skip Storyblocks (Không đúng ngữ cảnh)`);
            }

            // 2. Cắt Video Gốc bằng FFmpeg (Luôn thực hiện cho mọi block)
            const segmentPath = path.join(videoFolder, 'original_segment.mp4');
            if (!fs.existsSync(segmentPath)) {
                const start = srtTimeToSeconds(block.startTime);
                const duration = srtTimeToSeconds(block.endTime) - start;
                try {
                    execSync(`ffmpeg -ss ${start} -t ${duration} -i "${videoPath}" -c copy -y "${segmentPath}" -loglevel error`);
                } catch (e) {
                    console.error(`[!] Lỗi cắt video block ${subNo}`);
                }
            }
        }
        console.log(`[OK] Đã hoàn thành toàn bộ assets cho ${videoId}`);
    }
}

main().catch(err => console.error("Lỗi vận hành:", err));
