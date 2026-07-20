// Bản xem trước 480p (~800kbps) cho video stock. Bản gốc là 1080p 5-9 Mbps, 18-78MB/file —
// xem qua LAN thì chờ rất lâu. Proxy nhẹ hơn ~7 lần, chỉ dùng để XEM; export/CapCut vẫn dùng bản gốc.
// Encode bằng NVENC (RTX 4070S): ~1.5s cho clip 26s.
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const PROXY_HEIGHT = 480;
const MAX_PARALLEL = 2;      // 2 phiên NVENC — chừa GPU cho LatentSync
const MIN_SIZE = 4 * 1024 * 1024; // File dưới 4MB thì proxy vô nghĩa, cứ phát bản gốc

const queue = [];
let running = 0;
const inFlight = new Map();

// NVENC có thì dùng, không thì lùi về libx264 (chậm hơn nhiều nhưng vẫn chạy)
export const hasNvenc = (() => {
    try {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
        return (r.stdout || '').includes('h264_nvenc');
    } catch { return false; }
})();

export function proxyPathFor(mediaDir, relativePath) {
    return path.join(mediaDir, '_proxy', `${relativePath}.mp4`);
}

// Proxy sẵn sàng chưa? (dùng để quyết định phát proxy hay bản gốc — không chờ encode)
export function proxyReady(mediaDir, relativePath) {
    const src = path.join(mediaDir, relativePath);
    const dest = proxyPathFor(mediaDir, relativePath);
    if (!fs.existsSync(dest) || !fs.existsSync(src)) return false;
    return fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs;
}

export function needsProxy(mediaDir, relativePath) {
    const src = path.join(mediaDir, relativePath);
    if (!fs.existsSync(src)) return false;
    if (fs.statSync(src).size < MIN_SIZE) return false;
    return !proxyReady(mediaDir, relativePath);
}

function pump() {
    while (running < MAX_PARALLEL && queue.length) {
        const job = queue.shift();
        running++;
        job().finally(() => { running--; pump(); });
    }
}

function encode(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part'; // encode dở dang không được để lộ ra cho client
    const vcodec = hasNvenc
        ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '800k', '-maxrate', '1M', '-bufsize', '2M']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28'];
    // -f mp4 là bắt buộc: đuôi .part khiến ffmpeg không tự đoán được định dạng đầu ra
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', src,
        '-vf', `scale=-2:${PROXY_HEIGHT}`, ...vcodec,
        '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'mp4', tmp];
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
        ff.on('error', reject);
        ff.on('close', code => {
            if (code !== 0 || !fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); return reject(new Error('ffmpeg exit ' + code)); }
            fs.renameSync(tmp, dest);
            resolve(dest);
        });
    });
}

export function ensureProxy(mediaDir, relativePath) {
    const dest = proxyPathFor(mediaDir, relativePath);
    if (proxyReady(mediaDir, relativePath)) return Promise.resolve(dest);
    if (inFlight.has(dest)) return inFlight.get(dest);

    const src = path.join(mediaDir, relativePath);
    if (!fs.existsSync(src)) return Promise.reject(new Error('không có file gốc'));

    const p = new Promise((resolve, reject) => {
        queue.push(() => encode(src, dest).then(resolve, reject));
        pump();
    }).finally(() => inFlight.delete(dest));

    inFlight.set(dest, p);
    return p;
}

// Encode nền cho cả loạt video của project đang mở — bấm xem là có proxy sẵn.
// UI poll /api/posts/:id mỗi 2s, nên throttle: đừng stat lại hàng trăm file mỗi lần gọi.
const lastWarm = new Map();
const WARM_EVERY_MS = 60_000;

export function warmProxies(mediaDir, relativePaths, key = 'all') {
    const now = Date.now();
    if (now - (lastWarm.get(key) || 0) < WARM_EVERY_MS) return 0;
    lastWarm.set(key, now);

    const todo = relativePaths.filter(rel => needsProxy(mediaDir, rel));
    if (!todo.length) return 0;
    console.log(`[proxy] Encode nền ${todo.length} video 480p (${hasNvenc ? 'NVENC' : 'libx264'})`);
    for (const rel of todo) ensureProxy(mediaDir, rel).catch(() => {});
    return todo.length;
}
