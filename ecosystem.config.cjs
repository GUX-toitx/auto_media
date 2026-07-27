module.exports = {
    apps: [
        {
            name: 'auto-media',
            script: 'server.js',
            interpreter: 'node',
            watch: false,
            env_file: '.env',
        },
        {
            name: 'sync-assets',
            script: 'src/workers/sync_assets_db.js',
            interpreter: 'node',
            watch: false,
            env_file: '.env',
            autorestart: true,
        },
        {
            // Server inference LatentSync cho Lips Sync (FastAPI, GPU) — proxy tại /api/lips-sync/*
            name: 'latentsync',
            script: '/home/gux/workspace/lips_sync/lips_sync/.venv/bin/uvicorn',
            args: 'app.main:app --app-dir . --host 127.0.0.1 --port 8010',
            interpreter: 'none',
            cwd: '/home/gux/workspace/lips_sync/lips_sync',
            watch: false,
            autorestart: true,
            // --- Chống tái phát: khi GPU bị app khác chiếm VRAM, LatentSync OOM lúc load pipeline.
            // Trước đây pm2 restart dồn dập 29 lần trong vài giây rồi bỏ cuộc -> stopped hẳn (port 8010 chết).
            min_uptime: 60000,             // phải sống >60s (đủ thời gian load pipeline) mới tính là "ổn định"
            max_restarts: 15,              // cho thử lại nhiều hơn trước khi bỏ cuộc
            exp_backoff_restart_delay: 10000, // giãn dần thời gian restart (10s, 20s, 40s...) thay vì dồn dập
            // Giới hạn số nhân ffmpeg (libx264) của LatentSync để không ăn hết CPU, chừa cho web/upload.
            // Tăng nếu muốn lips nhanh hơn (và chấp nhận máy tải nặng hơn), giảm nếu muốn máy mượt hơn.
            env: {
                LATENTSYNC_FFMPEG_THREADS: '4',
                // Giảm phân mảnh VRAM (OpenAI/PyTorch khuyến nghị khi hay OOM "reserved but unallocated").
                PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
            },
        }
    ]
};
