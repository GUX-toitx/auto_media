// ============================================================================
// THƯ VIỆN VIDEO KHUÔN MẶT (LIPS SYNC) THEO THỨ (2..CN) × THEO THỂ LOẠI
//
//   <MEDIA_DIR>/_lips_videos/video_1.mp4         -> bộ DÙNG CHUNG (mọi thể loại)
//   <MEDIA_DIR>/_lips_videos/naze/video_1.mp4    -> RIÊNG cho naze (đè bộ chung)
//   <MEDIA_DIR>/_lips_videos/drama/video_5.mp4   -> RIÊNG cho drama
//
// Tra cứu: file RIÊNG của thể loại trước, không có thì rơi về bộ DÙNG CHUNG.
// Dự án bật lips mà KHÔNG chọn video cụ thể -> tự lấy video của THỨ tạo dự án.
// Trả về ĐƯỜNG DẪN TUYỆT ĐỐI vì lips_auto.json / worker lips dùng path tuyệt đối.
// ============================================================================
import fs from 'fs';
import path from 'path';

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
export const LIPS_LIB_DIRNAME = '_lips_videos';
export const LIPS_LIB_DIR = path.join(MEDIA_DIR, LIPS_LIB_DIRNAME);

export const LIPS_GENRES = ['geo', 'naze', 'drama'];
export const LIPS_GENRE_LABELS = { geo: 'Địa chính trị', naze: 'Tại sao (naze)', drama: 'Drama' };
export const LIPS_WEEKDAY_LABELS = { 1: 'Thứ 2', 2: 'Thứ 3', 3: 'Thứ 4', 4: 'Thứ 5', 5: 'Thứ 6', 6: 'Thứ 7', 7: 'Chủ nhật' };

export const normLipsGenre = (g) => (LIPS_GENRES.includes(String(g)) ? String(g) : null);

// JS getDay(): 0=CN..6=T7 -> 1=T2..7=CN
export function lipsWeekday(d = new Date()) {
    const w = d.getDay();
    return w === 0 ? 7 : w;
}

const dirFor = (genre) => (normLipsGenre(genre) ? path.join(LIPS_LIB_DIR, normLipsGenre(genre)) : LIPS_LIB_DIR);

// Tìm trong ĐÚNG 1 thư mục -> đường dẫn TUYỆT ĐỐI
function findIn(dirAbs, weekday) {
    if (!fs.existsSync(dirAbs)) return null;
    const prefix = `video_${weekday}.`;
    const hit = fs.readdirSync(dirAbs).find(f => f.startsWith(prefix));
    return hit ? path.join(dirAbs, hit) : null;
}

// Video dùng THẬT cho (thứ, thể loại): riêng thể loại trước, rồi bộ dùng chung. Tuyệt đối hoặc null.
export function lipsLibVideo(weekday, genre = null) {
    const wd = Number(weekday);
    if (!(wd >= 1 && wd <= 7)) return null;
    const g = normLipsGenre(genre);
    if (g) {
        const own = findIn(path.join(LIPS_LIB_DIR, g), wd);
        if (own) return own;
    }
    return findIn(LIPS_LIB_DIR, wd);
}

// [{ weekday, label, video, own }]
export function listLipsLib(genre = null) {
    const g = normLipsGenre(genre);
    return Object.keys(LIPS_WEEKDAY_LABELS).map(Number).sort((a, b) => a - b).map(wd => {
        const own = g ? findIn(path.join(LIPS_LIB_DIR, g), wd) : null;
        return { weekday: wd, label: LIPS_WEEKDAY_LABELS[wd], video: own || findIn(LIPS_LIB_DIR, wd), own: !!own };
    });
}

export function saveLipsLibFile(weekday, tmpPath, originalName, genre = null) {
    const wd = Number(weekday);
    if (!(wd >= 1 && wd <= 7)) throw new Error('weekday không hợp lệ');
    const dir = dirFor(genre);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`video_${wd}.`)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
    }
    const ext = (path.extname(originalName || '') || '.mp4').toLowerCase();
    const dest = path.join(dir, `video_${wd}${ext}`);
    fs.renameSync(tmpPath, dest);
    return dest;
}

export function removeLipsLibFile(weekday, genre = null) {
    const abs = findIn(dirFor(genre), Number(weekday));
    if (abs) { try { fs.unlinkSync(abs); } catch (_) {} }
    return abs;
}

// Chọn video lips cuối cùng cho 1 dự án:
//   - user đã chọn video cụ thể  -> giữ nguyên
//   - chưa chọn                  -> lấy video của THỨ hiện tại theo thể loại (nếu thư viện có)
export function resolveLipsVideo(video, genre = null, when = new Date()) {
    if (video && String(video).trim()) return String(video).trim();
    return lipsLibVideo(lipsWeekday(when), genre);
}
