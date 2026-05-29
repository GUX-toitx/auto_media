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
            name: 'craw-sub',
            script: 'craw_sub.js',
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
        }
    ]
};
