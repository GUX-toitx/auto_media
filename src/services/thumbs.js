// Thumbnail cho lưới asset: lưới không được kéo file gốc (video stock 5-9 Mbps, 25MB/file,
// một project naze có 400+ file / 10GB) — chỉ tải bản jpg 320px, video gốc chỉ tải khi hover/click.
// Thumb sinh theo yêu cầu (lần đầu mở project) rồi cache trên đĩa: <MEDIA_DIR>/_thumbs/<đường dẫn asset>.jpg
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const THUMB_WIDTH = 320;
const MAX_PARALLEL = 3; // ffmpeg chạy song song tối đa — cao hơn là tranh CPU với crawl/encode

const queue = [];
let running = 0;
const inFlight = new Map(); // dedupe: nhiều thẻ cùng xin 1 thumb thì chỉ encode 1 lần

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

export function isVideoPath(p) {
    return VIDEO_EXTS.has(path.extname(p).toLowerCase());
}

export function thumbPathFor(mediaDir, relativePath) {
    return path.join(mediaDir, '_thumbs', `${relativePath}.jpg`);
}

function pump() {
    while (running < MAX_PARALLEL && queue.length) {
        const job = queue.shift();
        running++;
        job().finally(() => { running--; pump(); });
    }
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
        ff.on('error', reject);
        ff.on('close', code => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))));
    });
}

async function encode(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const scale = `scale=${THUMB_WIDTH}:-2`;
    if (isVideoPath(src)) {
        // Lấy 1 frame ở giây thứ 1; clip ngắn hơn 1s thì lùi về frame đầu
        try {
            await runFfmpeg(['-y', '-ss', '1', '-i', src, '-frames:v', '1', '-vf', scale, '-q:v', '6', dest]);
        } catch {
            await runFfmpeg(['-y', '-i', src, '-frames:v', '1', '-vf', scale, '-q:v', '6', dest]);
        }
    } else {
        await runFfmpeg(['-y', '-i', src, '-vf', scale, '-q:v', '6', dest]);
    }
    if (!fs.existsSync(dest)) throw new Error('thumb rỗng: ' + src);
}

// Trả về đường dẫn thumb (tạo nếu chưa có / nếu file gốc mới hơn thumb).
export function ensureThumb(mediaDir, relativePath) {
    const src = path.join(mediaDir, relativePath);
    const dest = thumbPathFor(mediaDir, relativePath);

    const srcStat = fs.existsSync(src) ? fs.statSync(src) : null;
    if (!srcStat) return Promise.reject(new Error('không có file gốc'));
    if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= srcStat.mtimeMs) return Promise.resolve(dest);

    if (inFlight.has(dest)) return inFlight.get(dest);

    const p = new Promise((resolve, reject) => {
        queue.push(() => encode(src, dest).then(() => resolve(dest), reject));
        pump();
    }).finally(() => inFlight.delete(dest));

    inFlight.set(dest, p);
    return p;
}
