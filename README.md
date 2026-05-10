# Cài đặt công cụ hệ thống (Ubuntu/Debian)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
sudo apt update && sudo apt install ffmpeg -y

# Cài đặt thư viện Node.js cho dự án
npm install

sudo apt install python3-certifi python3-brotli -y
sudo apt install python3-websockets -y

# Khởi tạo Database (chạy 1 lần đầu)
    node migrate.js

# Chạy dự án
- Luồng thứ nhất chạy để lấy video và sub từ youtube:
    pm2 start craw-sub
- Luồng thứ hai chạy để lấy image và video từ keyword:
    node sync_assets.js

# Chạy server dashboard
- Cài pm2 lần đầu:
    npm install -g pm2
- Khởi động:
    pm2 start ecosystem.config.cjs
    pm2 save  # LƯU LẠI để tự động khởi động khi PM2 daemon restart
- Setup tự khởi động khi boot (chỉ chạy 1 lần):
    pm2 startup
    # Copy lệnh mà PM2 đưa ra và chạy với sudo
    pm2 save
- Mở dashboard: http://localhost:3000
- Xem log:
    pm2 logs auto-media
    pm2 logs craw-sub
- Restart:
    pm2 restart auto-media
    pm2 save  # Nhớ save sau khi thay đổi
- Dừng:
    pm2 stop auto-media
- Khởi động lại sau khi dừng:
    pm2 start auto-media
- Xóa khỏi pm2:
    pm2 delete auto-media
- Xóa và start lại:
    pm2 delete all && pm2 start ecosystem.config.cjs && pm2 save

# Lưu ý khi chạy lần đầu với Playwright:
1. chạy npx playwright install chromium để tải chromium 
    - nếu không chạy được thì vào 
        Linux: https://playwright.azureedge.net/builds/chromium/1217/chromium-linux.zip để tải thủ công rồi giải nén vào thư mục
        nếu không tải được thì hỏi chatGPT
        nếu dùng cách tảu thủ công thì giải nén xong thêm vào .env
        CUSTOM_CHROME=true
        SETTING_DIR=đường dẫn đến thư mục chứa chromium
2. chạy node browser.js để đăng nhập vào chrome Playwright, sau khi đăng nhập xong thì tắt trình duyệt đi là được, lần sau chạy sẽ không cần đăng nhập nữa vì đã lưu session vào user data dir rồi

# Quản lý nhiều tài khoản Google cho Flow
- Mỗi tài khoản Google cần 1 profile riêng, hệ thống sẽ tự xoay vòng theo tài khoản lâu dùng nhất
- Tạo profile và đăng nhập:
    node browser.js                              -> profile mặc định (chrome-profile)
    node browser.js 2 email@gmail.com matkhau    -> chrome-profile-2
    node browser.js 3 email@gmail.com matkhau    -> chrome-profile-3
- Email/password được lưu vào DB để biết profile nào dùng tài khoản nào
- Sau khi tạo profile mới, trình duyệt tự mở vào trang đăng nhập Google -> đăng nhập xong tắt đi là được
3. chạy như bình thường click button gen ai rồi chọn số lượng ấn gen rồi ngồi nhìn thôi

4. Promt để trong prompts, chỉnh sửa promt vào đây, prompt sẽ tự động thêm đoạn content của paragraph đẻ gửi lên Flow