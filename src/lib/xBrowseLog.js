// Log MỌI tweet mà crawl X "lướt qua" (twscrape trả về) cho từng cảnh — kèm link, tác giả, số ảnh/video,
// và cờ used (có được lấy media vào dự án hay không). Mục đích: khi 1 dự án cào được ÍT nguồn X,
// mở modal xem toàn bộ bài đã duyệt để biết vì sao (lạc đề / không media / quá cũ / dính rate-limit).
//
// File: logs/<projectId>/x_browse.json  →  { updatedAt, entries: [{ scene, kind, keywords, ts, tweets:[...] }] }
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');   // src/lib -> gốc repo
const LOG_DIR = path.join(ROOT, 'logs');

function sanitize(s) { return String(s || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80); }
function fileFor(projectId) { return path.join(LOG_DIR, sanitize(projectId), 'x_browse.json'); }

// Xoá log cũ đầu mỗi lần crawl để không lẫn kết quả lần trước.
export function resetXBrowseLog(projectId) {
    if (!projectId) return;
    try {
        const file = fileFor(projectId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), entries: [] }, null, 2));
    } catch (_) {}
}

// Ghi 1 cảnh: scene (nhãn), kind ('para'|'sent'|'global'), keywords[], scraped[] (light record từ crawlX),
// usedUrls (Set<string> các url tweet ĐÃ lấy được media). scraped item: {id,url,user,date,text,images,videos}.
export function appendXBrowse(projectId, { scene = '', kind = '', keywords = [], scraped = [], usedUrls = null } = {}) {
    if (!projectId) return;
    try {
        const file = fileFor(projectId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let data = { updatedAt: '', entries: [] };
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
        if (!Array.isArray(data.entries)) data.entries = [];
        const used = usedUrls instanceof Set ? usedUrls : new Set(usedUrls || []);
        data.entries.push({
            scene, kind,
            keywords: (keywords || []).filter(Boolean).map(String),
            ts: new Date().toISOString(),
            tweets: (scraped || []).map(t => ({
                url: t.url || '', user: t.user || '', date: t.date || '',
                text: String(t.text || '').replace(/\s+/g, ' ').slice(0, 280),
                images: t.images || 0, videos: t.videos || 0,
                used: used.has(t.url),
            })),
        });
        data.updatedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (_) { /* không để log làm hỏng crawl */ }
}

// Đọc log cho server API.
export function readXBrowseLog(projectId) {
    try { return JSON.parse(fs.readFileSync(fileFor(projectId), 'utf8')); }
    catch { return { updatedAt: '', entries: [] }; }
}

export { fileFor as xBrowseLogFile };
