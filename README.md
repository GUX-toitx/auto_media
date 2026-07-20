# Cấu trúc thư mục
Mọi lệnh đều chạy từ THƯ MỤC GỐC của repo (đường dẫn dữ liệu như setting/, outsources/, rss/, .venv
đều tính theo thư mục làm việc hiện tại).

    server.js                 Entry point dashboard (pm2: auto-media)
    src/
      workers/                Script chạy nền, được server spawn
        process_content.js    Pipeline Địa chính trị (RSS/Google News -> GPT -> project)
        naze_content.js       Pipeline Tại sao/Drama
        craw_sub.js           Lấy video + sub từ YouTube
        capcut_export.js      Xuất draft CapCut
        sync_assets_db.js     Worker đồng bộ asset (pm2: sync-assets)
      crawlers/               Bot cào ảnh/video: aljazeera, apnews, bellingcat, cnn, dvids,
                              reuters, vn, storyblocks, googleImage, bingImage, imageCrawlRotate
      news/                   news_feeds.js (RSS gốc của báo) + news_pipeline.js (gom tin + cào media)
      x/                      Cào X/Twitter: x_crawler, x_capture, x_cookies, x_login, x_scrape.py
      services/               video_service, browser (Flow), seoTitle, translateTitle, thumbs, ytDlpDownloader
      lib/                    fetchIPv4, proxies, proxyManager, proxyPool, crawlLogger, stockNaming, migrate
    handle_voice/             Giọng đọc + align (karaoke)
    public/                   index.html (dashboard), media-upload.html
    config/                   google_sheet.json, proxies.txt, template_draft_*.json, youtube.com_cookies.txt
    scripts/                  Script chạy tay: login.js, test_*.js
    prompts/  setting/  outsources/  database/  rss/  rss_seen/  logs/      Dữ liệu (không đụng vào)

# Cài đặt công cụ hệ thống (Ubuntu/Debian)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
sudo apt update && sudo apt install ffmpeg -y

# Cài đặt thư viện Node.js cho dự án
npm install

sudo apt install python3-certifi python3-brotli -y
sudo apt install python3-websockets -y

# Khởi tạo Database (chạy 1 lần đầu)
    node src/lib/migrate.js

# Chạy dự án
- Luồng thứ nhất chạy để lấy video và sub từ youtube:
    pm2 start craw-sub
- Luồng thứ hai chạy để lấy image và video từ keyword:
    node src/workers/sync_assets_db.js

# Chạy server dashboard
- Cài pm2 lần đầu:
    npm install -g pm2
- Khởi động:
    pm2 start ecosystem.config.cjs
- Mở dashboard: http://localhost:3000
- Xem log:
    pm2 logs auto-media
    pm2 logs craw-sub
- Restart:
    pm2 restart auto-media
- Dừng:
    pm2 stop auto-media
- Khởi động lại sau khi dừng:
    pm2 start auto-media
- Xóa khỏi pm2:
    pm2 delete auto-media
- Xóa và start lại:
    pm2 delete all && pm2 start ecosystem.config.cjs

# Lưu ý khi chạy lần đầu với Playwright:
1. chạy npx playwright install chromium để tải chromium 
    - nếu không chạy được thì vào 
        Linux: https://playwright.azureedge.net/builds/chromium/1217/chromium-linux.zip để tải thủ công rồi giải nén vào thư mục
        nếu không tải được thì hỏi chatGPT
        nếu dùng cách tảu thủ công thì giải nén xong thêm vào .env
        CUSTOM_CHROME=true
        SETTING_DIR=đường dẫn đến thư mục chứa chromium
2. chạy node src/services/browser.js để đăng nhập vào chrome Playwright, sau khi đăng nhập xong thì tắt trình duyệt đi là được, lần sau chạy sẽ không cần đăng nhập nữa vì đã lưu session vào user data dir rồi

# Quản lý nhiều tài khoản Google cho Flow
- Mỗi tài khoản Google cần 1 profile riêng, hệ thống sẽ tự xoay vòng theo tài khoản lâu dùng nhất
- Tạo profile và đăng nhập:
    node src/services/browser.js                              -> profile mặc định (chrome-profile)
    node src/services/browser.js 2 email@gmail.com matkhau    -> chrome-profile-2
    node src/services/browser.js 3 email@gmail.com matkhau    -> chrome-profile-3
- Email/password được lưu vào DB để biết profile nào dùng tài khoản nào
- Sau khi tạo profile mới, trình duyệt tự mở vào trang đăng nhập Google -> đăng nhập xong tắt đi là được
3. chạy như bình thường click button gen ai rồi chọn số lượng ấn gen rồi ngồi nhìn thôi

4. Promt để trong prompts, chỉnh sửa promt vào đây, prompt sẽ tự động thêm đoạn content của paragraph đẻ gửi lên Flow