module.exports = {
    apps: [
        {
            name: 'auto-media',
            script: 'server.js',
            interpreter: 'node',
            watch: false,
            env_file: '.env',
        }
    ]
};
