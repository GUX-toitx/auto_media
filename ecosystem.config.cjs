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
            script: 'sync_assets_db.js',
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
        }
    ]
};
