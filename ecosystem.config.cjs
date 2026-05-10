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
            cron_restart: '0 */2 * * *',  // Restart mỗi 2 giờ
            env: {
                PATH: `/home/gux/.deno/bin:${process.env.PATH}`
            }
        }
    ]
};
