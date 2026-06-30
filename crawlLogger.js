import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'logs');
const MEDIA_DIR = process.env.MEDIA_DIR || '';

// Dự án hiện tại (đặt bởi orchestrator) -> log tách theo dự án
let currentProject = '';

function sanitize(s) { return String(s || '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80); }

// Đặt dự án trực tiếp theo projectId
export function setLogProject(projectId) { currentProject = sanitize(projectId); }

// Suy ra projectId từ đường dẫn thư mục crawl (segment đầu sau MEDIA_DIR)
export function setLogProjectFromDir(dir) {
    try {
        if (!dir) return;
        const rel = MEDIA_DIR ? path.relative(MEDIA_DIR, dir) : dir;
        const seg = rel.split(path.sep).filter(Boolean)[0];
        if (seg && seg !== '..') currentProject = sanitize(seg);
    } catch (_) {}
}

// File log theo NGÀY, nằm trong thư mục theo DỰ ÁN: logs/<projectId>/crawl_errors_<YYYY-MM-DD>.log
function logFileForToday() {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dir = currentProject ? path.join(LOG_DIR, currentProject) : LOG_DIR;
    return path.join(dir, `crawl_errors_${ymd}.log`);
}

// Ghi 1 dòng lỗi crawl ra file của dự án hiện tại
// { source, keyword, url, reason } — source: tên nguồn; url: đường dẫn bị lỗi; reason: lí do
export function logCrawlError({ source = '', keyword = '', url = '', reason = '' } = {}) {
    try {
        const file = logFileForToday();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const ts = new Date().toISOString();
        const parts = [`[${ts}]`, `[${source || '?'}]`];
        if (keyword) parts.push(`kw="${String(keyword).slice(0, 80)}"`);
        if (url) parts.push(`url=${url}`);
        parts.push(`| ${reason || 'unknown'}`);
        fs.appendFileSync(file, parts.join(' ') + '\n');
    } catch (_) { /* không để việc ghi log làm hỏng crawl */ }
}

// File "thông tin" (không phải lỗi): URL query + URL ảnh lấy được. logs/<projectId>/crawl_info_<YYYY-MM-DD>.log
function infoFileForToday() {
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dir = currentProject ? path.join(LOG_DIR, currentProject) : LOG_DIR;
    return path.join(dir, `crawl_info_${ymd}.log`);
}

// Ghi log thông tin (search URL / ảnh tải được) — { source, keyword, url, note }
export function logCrawlInfo({ source = '', keyword = '', url = '', note = '' } = {}) {
    try {
        const file = infoFileForToday();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const ts = new Date().toISOString();
        const parts = [`[${ts}]`, `[${source || '?'}]`];
        if (keyword) parts.push(`kw="${String(keyword).slice(0, 80)}"`);
        if (url) parts.push(`url=${url}`);
        if (note) parts.push(`| ${note}`);
        fs.appendFileSync(file, parts.join(' ') + '\n');
    } catch (_) {}
}

export { logFileForToday };
