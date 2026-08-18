// ============================================================================
// BỘ NHỚ NỘI DUNG PODCAST — chống trùng đề tài & trùng nhân vật giữa các bài
//
// Mỗi bài podcast do AI viết để lại một "thẻ nhớ" (đề tài, tóm tắt, luận điểm,
// DANH SÁCH NHÂN VẬT, bối cảnh, nút thắt). Bài sau đọc lại toàn bộ thẻ nhớ,
// nhét vào prompt dưới dạng DANH SÁCH CẤM, rồi ĐỐI CHIẾU dàn ý vừa sinh với
// bộ nhớ — trùng thì bắt AI lên dàn ý khác chứ không viết tiếp.
//
// Vì sao là FILE chứ không phải bảng SQLite: media_system.sqlite dùng chung với
// các nhánh khác (main_v4, naze...), thêm bảng/cột là kéo theo migrate cho mọi
// nhánh. Podcast vốn đã theo lối lưu file (srt_timing.json, voice_auto.json).
//
//   <MEDIA_DIR>/_podcast_ai/memory.json   { version, entries: [...] }
// ============================================================================
import fs from 'fs';
import path from 'path';

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
export const MEMORY_DIR = path.join(MEDIA_DIR, '_podcast_ai');
export const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');

// Giữ tối đa bấy nhiêu thẻ nhớ (cũ nhất rụng trước). Vượt quá thì file phình và
// phần "danh sách cấm" trong prompt cũng phình theo.
const MAX_ENTRIES = Math.max(20, parseInt(process.env.PODCAST_AI_MEMORY_MAX, 10) || 300);
// Số bài GẦN NHẤT được nhắc CHI TIẾT trong prompt (các bài cũ hơn chỉ còn tên + nhân vật).
const DETAIL_RECENT = Math.max(5, parseInt(process.env.PODCAST_AI_MEMORY_DETAIL, 10) || 25);

// --------------------------------------------------------------------------
// Đọc / ghi
// --------------------------------------------------------------------------
export function readMemory() {
    try {
        const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        const entries = Array.isArray(raw?.entries) ? raw.entries : [];
        return { version: raw?.version || 1, entries };
    } catch (_) {
        return { version: 1, entries: [] };   // chưa có file / file hỏng -> coi như bộ nhớ rỗng
    }
}

// Mới nhất đứng đầu.
export function listEntries() {
    return readMemory().entries.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function writeMemory(mem) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    // Ghi tạm rồi rename: worker và server cùng đụng file này, đứt tay giữa chừng
    // sẽ để lại JSON cụt và mất TOÀN BỘ bộ nhớ.
    const tmp = MEMORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
    fs.renameSync(tmp, MEMORY_FILE);
}

// Thêm/ghi đè thẻ nhớ của 1 dự án (chạy lại cùng projectId -> thay thẻ cũ, không nhân đôi).
export function saveEntry(entry) {
    const mem = readMemory();
    const e = {
        projectId: String(entry.projectId || ''),
        createdAt: entry.createdAt || new Date().toISOString(),
        title: entry.title || '',
        titleVi: entry.titleVi || '',
        lang: entry.lang || 'vi',
        minutes: Number(entry.minutes) || 0,
        topic: entry.topic || '',            // prompt người dùng gõ
        logline: entry.logline || '',
        summary: entry.summary || '',
        angle: entry.angle || '',
        keyPoints: arr(entry.keyPoints),
        characters: arr(entry.characters).map(c => (typeof c === 'string'
            ? { name: c, role: '', description: '' }
            : { name: c?.name || '', role: c?.role || '', description: c?.description || '' }))
            .filter(c => c.name),
        settings: arr(entry.settings),
        keywords: arr(entry.keywords),
    };
    mem.entries = mem.entries.filter(x => x.projectId !== e.projectId);
    mem.entries.push(e);
    if (mem.entries.length > MAX_ENTRIES) mem.entries = mem.entries.slice(-MAX_ENTRIES);
    writeMemory(mem);
    return e;
}

export function deleteEntry(projectId) {
    const mem = readMemory();
    const before = mem.entries.length;
    mem.entries = mem.entries.filter(x => x.projectId !== projectId);
    writeMemory(mem);
    return before - mem.entries.length;
}

export function clearMemory() {
    const n = readMemory().entries.length;
    writeMemory({ version: 1, entries: [] });
    return n;
}

const arr = (v) => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x.trim() : x)).filter(Boolean) : []);

// --------------------------------------------------------------------------
// So khớp: bỏ dấu tiếng Việt + hạ chữ thường, vì "Minh Anh" và "minh anh" là
// MỘT nhân vật, còn "Hùng" vs "Hung" cũng vậy (AI hay viết tên không dấu).
// --------------------------------------------------------------------------
export const normKey = (s) => String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Từ vô nghĩa khi so đề tài (nối câu, chữ chung chung) — để chúng vào thì bài nào cũng "trùng".
const STOP = new Set(('cua va la nhung mot cac khi cho den tu voi trong ngoai nay do ay ve nguoi chuyen cau '
    + 'the nao sao vi boi nen ma neu thi tai hay tren duoi ra vao podcast tap phan ky').split(' '));

const tokens = (s) => normKey(s).split(' ').filter(w => w.length > 2 && !STOP.has(w));

// Độ giống nhau 0..1 giữa 2 chuỗi (Jaccard trên tập từ). Đủ dùng để bắt hai đề tài
// nói cùng một chuyện bằng hai cách diễn đạt; không cần embedding cho việc này.
export function similarity(a, b) {
    const A = new Set(tokens(a)), B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
}

const TOPIC_THRESHOLD = Math.min(0.95, Math.max(0.2, Number(process.env.PODCAST_AI_TOPIC_SIM || 0.5)));

// --------------------------------------------------------------------------
// Đối chiếu dàn ý MỚI với bộ nhớ. Trả về danh sách va chạm để:
//   - bắt AI lên lại dàn ý (kèm đúng chỗ trùng), hoặc
//   - ghi cảnh báo vào log nếu đã hết lượt thử.
// --------------------------------------------------------------------------
export function findConflicts(candidate, entries = listEntries()) {
    const conflicts = { characters: [], topics: [] };
    const candNames = new Map();
    for (const c of arr(candidate.characters)) {
        const name = typeof c === 'string' ? c : c?.name;
        const k = normKey(name);
        if (k) candNames.set(k, name);
    }
    const candTopic = [candidate.title_vi || candidate.titleVi, candidate.title, candidate.logline, ...arr(candidate.keyPoints || candidate.key_points)].join(' ');

    for (const e of entries) {
        for (const c of e.characters || []) {
            const k = normKey(c.name);
            if (k && candNames.has(k)) {
                conflicts.characters.push({ name: candNames.get(k), usedIn: e.projectId, usedTitle: e.titleVi || e.title, role: c.role });
            }
        }
        const sim = similarity(candTopic, [e.titleVi, e.title, e.logline, ...(e.keyPoints || [])].join(' '));
        if (sim >= TOPIC_THRESHOLD) {
            conflicts.topics.push({ usedIn: e.projectId, usedTitle: e.titleVi || e.title, logline: e.logline, similarity: Math.round(sim * 100) });
        }
    }
    conflicts.topics.sort((a, b) => b.similarity - a.similarity);
    return conflicts;
}

export const hasConflict = (c) => !!(c.characters.length || c.topics.length);

// --------------------------------------------------------------------------
// Khối văn bản nhét vào prompt: "đây là những gì đã làm rồi, cấm lặp lại".
// Bài gần đây kể chi tiết, bài cũ chỉ còn tên + nhân vật (giữ prompt gọn).
// --------------------------------------------------------------------------
export function buildAvoidBlock(entries = listEntries()) {
    if (!entries.length) return '';
    const lines = ['===== ĐÃ XUẤT BẢN TRƯỚC ĐÂY — KHÔNG ĐƯỢC LẶP LẠI =====',
        'Đây là các tập podcast đã làm. Tập mới PHẢI khác về đề tài, tình tiết VÀ tên nhân vật.'];

    entries.slice(0, DETAIL_RECENT).forEach((e, i) => {
        lines.push(`\n[${i + 1}] ${e.titleVi || e.title}${e.minutes ? ` (~${e.minutes} phút)` : ''}`);
        if (e.logline) lines.push(`    Tóm tắt: ${e.logline}`);
        if (e.keyPoints?.length) lines.push(`    Ý chính: ${e.keyPoints.slice(0, 6).join(' | ')}`);
        if (e.characters?.length) lines.push(`    Nhân vật: ${e.characters.map(c => c.name + (c.role ? ` (${c.role})` : '')).join(', ')}`);
        if (e.settings?.length) lines.push(`    Bối cảnh: ${e.settings.slice(0, 5).join(', ')}`);
    });

    const older = entries.slice(DETAIL_RECENT);
    if (older.length) {
        lines.push(`\n--- ${older.length} tập cũ hơn (chỉ liệt kê tên) ---`);
        older.forEach(e => lines.push(`• ${e.titleVi || e.title}${e.characters?.length ? ` — nhân vật: ${e.characters.map(c => c.name).join(', ')}` : ''}`));
    }

    const allNames = [...new Set(entries.flatMap(e => (e.characters || []).map(c => c.name)).filter(Boolean))];
    if (allNames.length) {
        lines.push('\n===== TÊN NHÂN VẬT ĐÃ DÙNG (CẤM DÙNG LẠI, kể cả biến thể/viết tắt) =====');
        lines.push(allNames.join(', '));
    }
    return lines.join('\n');
}

// Mô tả va chạm để nhét vào lượt lên dàn ý LẠI.
export function buildConflictBlock(conflicts) {
    const lines = ['===== DÀN Ý VỪA RỒI BỊ TRÙNG — PHẢI LÀM LẠI KHÁC HẲN ====='];
    if (conflicts.characters.length) {
        lines.push('Nhân vật trùng với tập cũ (đổi TÊN KHÁC HẲN, đừng chỉ đổi họ hay thêm dấu):');
        conflicts.characters.forEach(c => lines.push(`  • "${c.name}" đã dùng ở "${c.usedTitle || c.usedIn}"`));
    }
    if (conflicts.topics.length) {
        lines.push('Đề tài/tình tiết trùng với tập cũ (chọn góc kể và tình tiết KHÁC):');
        conflicts.topics.slice(0, 5).forEach(t => lines.push(`  • giống ${t.similarity}% với "${t.usedTitle || t.usedIn}"${t.logline ? ` — ${t.logline}` : ''}`));
    }
    lines.push('Hãy lên MỘT dàn ý mới: nhân vật mới hoàn toàn, tình huống mở đầu khác, kết khác.');
    return lines.join('\n');
}
