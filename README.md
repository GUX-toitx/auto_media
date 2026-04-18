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
