# Cài đặt công cụ hệ thống (Ubuntu/Debian)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
sudo apt update && sudo apt install ffmpeg -y

# Cài đặt thư viện Node.js cho dự án
npm install

sudo apt install python3-certifi python3-brotli -y
sudo apt install python3-websockets -y

# Chạy dự án
- Luồng thứ nhất chạy để lấy video và sub từ youtube, đang chưa có func để làm mịn sub nên phải giả định là có file làm mịn rồi để chạy luồng 2
    node craw_sub.js
- Luồng thứ hai chạy để lấy image và video từ keyword, phần này phần lấy keyword vẫn đang là todo
    node sync_assets.js

# Lưu ý khi chạy lần đầu với Playwright:
1. chạy npx playwright install chromium để tải chromium 
    - nếu không chạy được thì vào 
        Linux: https://playwright.azureedge.net/builds/chromium/1217/chromium-linux.zip để tải thủ công rồi giải nén vào thư mục
        nếu không tải được thì hỏi chatGPT
        nếu dùng cách tảu thủ công thì giải nén xong thêm vào .env
        CUSTOM_CHROME=true
        SETTING_DIR=đường dẫn đến thư mục chứa chromium
2. chạy node browser.js để đăng nhập vào chrome Playwright, sau khi đăng nhập xong thì tắt trình duyệt đi là được, lần sau chạy sẽ không cần đăng nhập nữa vì đã lưu session vào user data dir rồi
3. chạy như bình thường click button gen ai rồi chọn số lượng ấn gen rồi ngồi nhìn thôi

4. Promt để trong prompts, chỉnh sửa promt vào đây, prompt sẽ tự động thêm đoạn content của paragraph đẻ gửi lên Flow