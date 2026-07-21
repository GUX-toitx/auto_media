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
            // Giới hạn số nhân ffmpeg (libx264) của LatentSync để không ăn hết CPU, chừa cho web/upload.
            // Tăng nếu muốn lips nhanh hơn (và chấp nhận máy tải nặng hơn), giảm nếu muốn máy mượt hơn.
            env: { LATENTSYNC_FFMPEG_THREADS: '4' },
        }
    ]
};
