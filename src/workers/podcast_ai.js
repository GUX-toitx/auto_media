import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { aiStructured, aiChat, aiProviderName, assertAiKey, logUsage } from '../lib/ai.js';
import { listEntries, buildAvoidBlock, buildConflictBlock, findConflicts, hasConflict, saveEntry } from '../lib/podcastMemory.js';

// ============================================================================
// PODCAST do AI VIẾT — thay cho việc nạp file .srt có sẵn.
//
//   node src/workers/podcast_ai.js --projectId <id> --prompt "<chủ đề>" \
//        [--lang vi] [--minutes 15] [--style "..."] [--web] [--title "..."]
//
// Hai tầng gọi AI (giống sports_srt.js, vì cùng bài toán "1 lượt gọi không viết
// nổi 15-40 phút nội dung"):
//   1) DÀN Ý  — tên bài, góc kể, NHÂN VẬT, các phần + luận điểm
//   2) VIẾT   — mỗi phần 1 lượt, chạy tuần tự, mang theo dàn ý + đuôi phần trước
//
// CHỐNG TRÙNG (yêu cầu chính): trước khi viết chữ nào, dàn ý được đối chiếu với
// <MEDIA_DIR>/_podcast_ai/memory.json — trùng tên nhân vật hoặc trùng đề tài thì
// bắt AI lên dàn ý khác. Kiểm ở khâu DÀN Ý chứ không phải sau khi viết xong:
// lên lại dàn ý tốn 1 lượt gọi, viết lại cả bài tốn cả chục lượt.
// Viết xong mới ghi thẻ nhớ (bài lỗi giữa chừng không được chiếm chỗ nhân vật).
//
// Kết quả ghi vào DB Y HỆT podcast_srt.js: mỗi ĐOẠN = 1 Paragraph (1 cảnh),
// mỗi CÂU ĐỌC = 1 ParagraphDetail. Không có srt_timing.json vì không có mốc gốc —
// nút "Tải SRT" dùng chế độ đo theo độ dài mp3.
// ============================================================================

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const PORT = process.env.PORT || 3000;

// Tốc độ đọc để quy phút -> số từ, và cỡ mỗi lượt viết.
const WORDS_PER_MINUTE = parseInt(process.env.PODCAST_AI_WPM || '150', 10);
const WORDS_PER_SECTION = parseInt(process.env.PODCAST_AI_WORDS_PER_SECTION || '900', 10);
const SECTION_MIN = 2, SECTION_MAX = 14;
const MAX_OUTPUT_TOKENS = parseInt(process.env.PODCAST_AI_MAX_OUTPUT_TOKENS || '32000', 10);
const OUTLINE_EFFORT = ['low', 'medium', 'high'].includes(process.env.PODCAST_AI_OUTLINE_EFFORT) ? process.env.PODCAST_AI_OUTLINE_EFFORT : 'high';
const SECTION_EFFORT = ['low', 'medium', 'high'].includes(process.env.PODCAST_AI_SECTION_EFFORT) ? process.env.PODCAST_AI_SECTION_EFFORT : 'medium';
// Số lần lên lại dàn ý khi phát hiện trùng bài cũ. 0 = chỉ cảnh báo, vẫn viết.
const DEDUP_RETRY = Math.max(0, parseInt(process.env.PODCAST_AI_DEDUP_RETRY, 10) || 2);
// Trần độ dài 1 câu đọc (ký tự). Câu dài quá thì mp3 dài lê thê, khó lấp nền.
const MAX_UNIT_CHARS = parseInt(process.env.PODCAST_AI_MAX_UNIT_CHARS || '180', 10);

const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

const langNameOf = (l) => ({ vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish', th: 'Thai', id: 'Bahasa Indonesia' }[l] || l);

// Ghi song song console.* ra <project>/process.log — bài 20 phút chạy cả chục lượt gọi,
// phải nhìn được nó đang ở phần mấy (nút "Log" trên dashboard đọc đúng file này).
function teeLogToProject(projectId) {
    try {
        const dir = path.join(MEDIA_DIR, projectId);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'process.log');
        const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
        for (const level of ['log', 'warn', 'error']) {
            const orig = console[level].bind(console);
            console[level] = (...a) => {
                orig(...a);
                try { fs.appendFileSync(file, `[${new Date().toTimeString().slice(0, 8)}] ${a.map(fmt).join(' ')}\n`); } catch (_) {}
            };
        }
    } catch (_) {}
}

// Báo dashboard qua SSE (giống podcast_srt.js). Luôn resolve.
function notifyDashboard(projectId, status, silent = false) {
    return new Promise((resolve) => {
        try {
            const req = http.request(
                { hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } },
                (res) => { res.resume(); res.on('end', resolve); }
            );
            req.on('error', () => resolve());
            req.setTimeout(3000, () => { req.destroy(); resolve(); });
            req.end(JSON.stringify({ postTitle: projectId, status, silent }));
        } catch (_) { resolve(); }
    });
}

// ===================== SCHEMA =====================

// Dàn ý: phần "characters" chính là thứ được cất vào bộ nhớ để bài sau tránh trùng.
const OUTLINE_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        title_vi: { type: 'string' },
        logline: { type: 'string' },        // 1 câu tóm cả tập
        summary: { type: 'string' },        // 3-5 câu
        angle: { type: 'string' },          // góc kể xuyên suốt
        characters: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    role: { type: 'string' },
                    description: { type: 'string' },
                },
                required: ['name', 'role', 'description'],
                additionalProperties: false,
            },
        },
        settings: { type: 'array', items: { type: 'string' } },
        keywords: { type: 'array', items: { type: 'string' } },
        sections: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    heading: { type: 'string' },
                    heading_vi: { type: 'string' },
                    purpose: { type: 'string' },
                    key_points: { type: 'array', items: { type: 'string' } },
                    target_words: { type: 'integer' },
                },
                required: ['heading', 'heading_vi', 'purpose', 'key_points', 'target_words'],
                additionalProperties: false,
            },
        },
    },
    required: ['title', 'title_vi', 'logline', 'summary', 'angle', 'characters', 'settings', 'keywords', 'sections'],
    additionalProperties: false,
};

// Bài SONG NGỮ (ngôn ngữ đích ≠ tiếng Việt): mỗi đoạn có cả vi lẫn target.
const SECTION_SCHEMA_BI = {
    type: 'object',
    properties: {
        sentences: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    vi: { type: 'string' },
                    target: { type: 'string' },
                    units: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { vi: { type: 'string' }, target: { type: 'string' } },
                            required: ['vi', 'target'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['vi', 'target', 'units'],
                additionalProperties: false,
            },
        },
    },
    required: ['sentences'],
    additionalProperties: false,
};

// Bài MỘT THỨ TIẾNG (đích = vi): xin đúng một cột. Xin cả hai thì output nhân đôi
// vô ích — đúng thứ làm chạm trần token và mất trắng cả phần.
const SECTION_SCHEMA_MONO = {
    type: 'object',
    properties: {
        sentences: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    units: { type: 'array', items: { type: 'string' } },
                },
                required: ['text', 'units'],
                additionalProperties: false,
            },
        },
    },
    required: ['sentences'],
    additionalProperties: false,
};

// ===================== GỌI AI =====================

// 1 lượt gọi có schema. Lỗi mạng/5xx thì thử lại (mỗi lượt đắt); lỗi cấu hình thì ném luôn.
async function callJson(input, schema, schemaName, tag, { effort = 'medium', webSearch = false } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const { outputText, usage } = await aiStructured({
                schema, schemaName, input, effort, webSearch,
                maxTokens: MAX_OUTPUT_TOKENS, tier: 'main',
            });
            logUsage(tag, usage);
            return JSON.parse(outputText);
        } catch (e) {
            lastErr = e;
            // Sai key / thiếu key thì thử lại cũng vô nghĩa.
            if (/Thiếu API key/.test(e.message) || /\b401\b|\b403\b/.test(e.message)) throw e;
            console.warn(`[${tag}] lượt gọi lỗi (lần ${attempt}/3): ${e.message}`);
            if (attempt === 3) throw new Error(`gọi AI thất bại sau 3 lần: ${lastErr.message}`);
            await new Promise(r => setTimeout(r, 5000 * attempt));
        }
    }
}

// Bỏ citation kiểu ([vnexpress.net](https://...)) và URL trần mà web search hay chèn.
const stripCitations = s => String(s || '').replace(/\s*\([^)]*\(https?:[^)]+\)[^)]*\)/g, '').replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();

function planScript(minutes) {
    const targetWords = Math.max(200, Math.round(minutes * WORDS_PER_MINUTE));
    const sectionCount = Math.min(SECTION_MAX, Math.max(SECTION_MIN, Math.round(targetWords / WORDS_PER_SECTION)));
    return { minutes, targetWords, sectionCount, wordsPerSection: Math.round(targetWords / sectionCount) };
}

// ---------- Bước 1: dàn ý ----------
function buildOutlineInput({ prompt, style, targetLang, plan, avoidBlock, conflictBlock }) {
    const langName = langNameOf(targetLang);
    const lines = [
        'Bạn là biên tập viên chính của một kênh podcast. Nhiệm vụ lần này: LÊN DÀN Ý (chưa viết lời thoại).',
        `Tập podcast dài khoảng ${plan.minutes} phút đọc, tức khoảng ${plan.targetWords} từ lời đọc.`,
        style ? `Thể loại / phong cách yêu cầu: ${style}` : '',
        `Ngôn ngữ đọc chính: ${langName}${targetLang === 'vi' ? '' : ' (bản tiếng Việt sẽ đi kèm khi viết)'}.`,
        '',
        `Chia thành ĐÚNG ${plan.sectionCount} phần nối tiếp nhau. Mỗi phần sau này do MỘT lượt gọi riêng viết, lượt đó chỉ thấy dàn ý + đuôi phần trước, nên dàn ý phải tự đủ nghĩa:`,
        `- "heading_vi" / "heading": tên phần (tiếng Việt / ${langName}). Đây là nhãn nội bộ, KHÔNG đọc lên.`,
        '- "purpose": phần này phải làm được gì trong mạch kể, và khác gì phần liền kề.',
        '- "key_points": 3-6 việc CỤ THỂ phần này phải nói (tình tiết, số liệu, tình huống, lời thoại chính) — cụ thể tới mức hai phần không thể viết ra cùng một thứ.',
        `- "target_words": số từ phần này chiếm (cộng lại khoảng ${plan.targetWords}, mỗi phần khoảng ${plan.wordsPerSection}).`,
        '',
        'Luật cấu trúc:',
        '- Phần 1 mở tập (câu móc + dựng bối cảnh). Phần CUỐI đóng tập (chốt ý / kết truyện / lời chào). Các phần giữa đẩy mạch đi lên, KHÔNG lặp lại nhau.',
        '- Không tạo hai phần nói cùng một chuyện bằng cách diễn đạt khác.',
        '',
        '"characters": LIỆT KÊ ĐẦY ĐỦ mọi nhân vật/nhân vật có tên xuất hiện trong tập (tên, vai trò, mô tả ngắn). Đây là danh sách được lưu lại để các tập sau không dùng trùng — thiếu tên nào là tập sau có thể trùng tên đó.',
        '"settings": các bối cảnh chính. "keywords": 5-10 từ khoá nội dung.',
        '"logline": 1 câu tóm cả tập. "summary": 3-5 câu tóm nội dung. "angle": góc kể xuyên suốt để nhiều lượt viết rời rạc vẫn ra MỘT tập.',
        `Tiêu đề tiếng Việt ở "title_vi", tiêu đề ${langName} ở "title".`,
        'Tuyệt đối không trích nguồn, không chèn URL, không chú thích.',
        '',
        '===== YÊU CẦU CỦA BIÊN TẬP =====',
        prompt,
    ];
    if (avoidBlock) lines.push('', avoidBlock);
    if (conflictBlock) lines.push('', conflictBlock);
    return lines.filter(l => l !== '').join('\n');
}

async function generateOutline({ prompt, style, targetLang, plan, webSearch }) {
    const memEntries = listEntries();
    const avoidBlock = buildAvoidBlock(memEntries);
    if (memEntries.length) console.log(`[podcast_ai] Bộ nhớ: ${memEntries.length} tập cũ, ${new Set(memEntries.flatMap(e => (e.characters || []).map(c => c.name))).size} tên nhân vật đã dùng.`);
    else console.log('[podcast_ai] Bộ nhớ trống — đây là tập đầu tiên.');

    let conflictBlock = '';
    let outline = null, conflicts = { characters: [], topics: [] };
    for (let attempt = 0; attempt <= DEDUP_RETRY; attempt++) {
        const tag = attempt ? `AI:outline:retry${attempt}` : 'AI:outline';
        outline = await callJson(
            buildOutlineInput({ prompt, style, targetLang, plan, avoidBlock, conflictBlock }),
            OUTLINE_SCHEMA, 'podcast_outline', tag, { effort: OUTLINE_EFFORT, webSearch });
        outline = cleanOutline(outline, plan);
        conflicts = findConflicts(outline, memEntries);
        if (!hasConflict(conflicts)) break;

        console.warn(`[podcast_ai] ⚠️ Dàn ý trùng bài cũ: ${conflicts.characters.length} nhân vật, ${conflicts.topics.length} đề tài.`);
        conflicts.characters.forEach(c => console.warn(`    • nhân vật "${c.name}" đã có ở "${c.usedTitle || c.usedIn}"`));
        conflicts.topics.slice(0, 3).forEach(t => console.warn(`    • đề tài giống ${t.similarity}% "${t.usedTitle || t.usedIn}"`));
        if (attempt === DEDUP_RETRY) {
            console.warn('[podcast_ai] ⚠️ Hết lượt lên lại dàn ý — VẪN VIẾT nhưng ghi nhận là có trùng (xem ai_outline.json).');
            break;
        }
        conflictBlock = buildConflictBlock(conflicts);
    }

    console.log(`[podcast_ai] === DÀN Ý (${outline.sections.length} phần, ~${outline.sections.reduce((n, s) => n + s.target_words, 0)} từ) ===`);
    console.log('  Tiêu đề :', outline.title_vi, '|', outline.title);
    console.log('  Góc kể  :', outline.angle);
    console.log('  Nhân vật:', outline.characters.map(c => `${c.name}${c.role ? ` (${c.role})` : ''}`).join(', ') || '(không có)');
    outline.sections.forEach((s, i) => {
        console.log(`  [${i + 1}] ${s.heading_vi} (~${s.target_words} từ) — ${s.purpose}`);
        s.key_points.forEach(k => console.log(`        • ${k}`));
    });
    return { outline, conflicts };
}

function cleanOutline(outline, plan) {
    let sections = (outline.sections || []).filter(s => (s.heading_vi || s.heading) && (s.purpose || '').trim());
    if (!sections.length) throw new Error('AI trả dàn ý rỗng');
    // Thừa phần thì cắt phần GIỮA, luôn giữ phần kết (cắt đuôi là mất đoạn chốt tập).
    if (sections.length > SECTION_MAX) sections = [...sections.slice(0, SECTION_MAX - 1), sections[sections.length - 1]];
    sections = sections.map(s => ({
        heading: stripCitations(s.heading), heading_vi: stripCitations(s.heading_vi),
        purpose: stripCitations(s.purpose),
        key_points: (Array.isArray(s.key_points) ? s.key_points : []).map(stripCitations).filter(Boolean),
        target_words: Math.min(1800, Math.max(300, Number(s.target_words) || plan.wordsPerSection)),
    }));
    return {
        title: stripCitations(outline.title), title_vi: stripCitations(outline.title_vi),
        logline: stripCitations(outline.logline), summary: stripCitations(outline.summary),
        angle: stripCitations(outline.angle),
        characters: (outline.characters || []).map(c => ({
            name: stripCitations(c.name), role: stripCitations(c.role), description: stripCitations(c.description),
        })).filter(c => c.name),
        settings: (outline.settings || []).map(stripCitations).filter(Boolean),
        keywords: (outline.keywords || []).map(stripCitations).filter(Boolean),
        sections,
    };
}

// ---------- Bước 2: viết từng phần ----------

// Đuôi phần trước (2 đoạn cuối) để nối giọng, nối mạch — cắt ngắn cho khỏi phình input.
function tailOf(sentences, nParas = 2, maxChars = 1200) {
    const tail = (sentences || []).slice(-nParas).map(s => (s.vi || '').trim()).filter(Boolean).join('\n\n');
    return tail.length > maxChars ? '...' + tail.slice(-maxChars) : tail;
}

function buildSectionInput({ prompt, style, targetLang, outline, index, coveredPoints, prevTail }) {
    const sec = outline.sections[index];
    const total = outline.sections.length;
    const langName = langNameOf(targetLang);
    const mono = targetLang === 'vi';
    const lines = [
        `Bạn là người viết kịch bản podcast. Viết PHẦN ${index + 1}/${total} của tập "${outline.title_vi}".`,
        style ? `Thể loại / phong cách: ${style}` : '',
        `Góc kể xuyên suốt: ${outline.angle}`,
        outline.characters.length ? `Nhân vật (dùng ĐÚNG những tên này, không đổi, không thêm tên mới trừ khi dàn ý yêu cầu): ${outline.characters.map(c => `${c.name} — ${c.role}: ${c.description}`).join(' | ')}` : '',
        '',
        `Phần này tên: ${sec.heading_vi}`,
        `Mục đích: ${sec.purpose}`,
        `Bắt buộc nói được: ${sec.key_points.map((k, i) => `\n  ${i + 1}. ${k}`).join('')}`,
        `Độ dài: khoảng ${sec.target_words} từ lời đọc.`,
        '',
        'Dàn ý cả tập (để biết phần khác lo việc gì — KHÔNG viết hộ phần của người ta):',
        ...outline.sections.map((s, i) => `  ${i === index ? '>>' : '  '} ${i + 1}. ${s.heading_vi}: ${s.purpose}`),
        '',
        coveredPoints.length ? `Những ý đã nói ở các phần trước (CẤM lặp lại): \n${coveredPoints.map(p => `  • ${p}`).join('\n')}` : '',
        prevTail ? `===== ĐUÔI PHẦN TRƯỚC (viết nối tiếp từ đây, không tóm tắt lại) =====\n${prevTail}` : '',
        '',
        'LUẬT VIẾT:',
        '- Đây là lời ĐỌC của podcast: viết văn nói, liền mạch, không tiêu đề, không gạch đầu dòng, không "phần 1", không chỉ dẫn sân khấu.',
        '- Chia thành các ĐOẠN 3-5 câu, mỗi phần tử của "sentences" là MỘT ĐOẠN hoàn chỉnh (không phải một câu ngắn).',
        `- Cắt mỗi đoạn thành các CÂU ĐỌC ngắn trong mảng "units": mỗi câu đọc là một mẩu tự đứng được, tối đa khoảng ${MAX_UNIT_CHARS} ký tự. Cắt ở hết câu trước, câu còn dài thì cắt tiếp ở dấu phẩy/ngắt ý tự nhiên. Không cắt giữa tên riêng hay con số.`,
        '- Ghép tất cả "units" lại phải ra ĐÚNG nội dung của đoạn, không thêm bớt, không đảo thứ tự.',
        '- Không trích nguồn, không URL, không chú thích, không nhắc tới dàn ý hay việc bạn là AI.',
        mono
            ? '- Viết bằng TIẾNG VIỆT. Mỗi đoạn có "text" (cả đoạn) và "units" (mảng chuỗi, các câu đọc đã cắt).'
            : `- Viết SONG SONG hai bản: "vi" (tiếng Việt) và "target" (${langName}), là bản dịch của nhau. Số lượng và thứ tự "units" phải khớp nhau hoàn toàn: unit thứ i của bản tiếng Việt nói đúng điều unit thứ i của bản ${langName} nói.`,
        // Đã gặp thật (bài tiếng Hàn): bản "vi" lẫn địa danh 구리, lời thoại “프로젝트 정리해 준 동료야.”
        // và có câu nguyên vẹn tiếng Hàn — người đọc bản tiếng Việt thấy chữ lạ giữa bài.
        mono ? '' : `- BẢN "vi" PHẢI LÀ TIẾNG VIỆT 100%. Tuyệt đối KHÔNG để sót bất kỳ chữ nào thuộc hệ chữ của ${langName} trong bản "vi" — kể cả tên riêng, địa danh, tên tổ chức, và LỜI THOẠI TRONG NGOẶC KÉP. Không được chép nguyên câu ${langName} sang ô "vi".`,
        mono ? '' : `- Tên riêng trong bản "vi": TÊN NGƯỜI giữ nguyên ở dạng phiên âm Latin (이다온 → "Lee Da-on"), KHÔNG dịch nghĩa thành tên Việt; địa danh/tổ chức dùng tên quen dùng hoặc phiên âm Latin (구리 → "Guri", 東京 → "Tokyo"). Bản "target" thì giữ nguyên dạng ${langName}.`,
        mono ? '' : '- Trước khi trả kết quả, rà lại toàn bộ ô "vi" (cả đoạn lẫn từng unit): còn chữ nước ngoài nào thì dịch nốt sang tiếng Việt.',
        '- Chỉ trả về các đoạn của RIÊNG phần này.',
        '',
        '===== YÊU CẦU GỐC CỦA BIÊN TẬP =====',
        prompt,
    ];
    return lines.filter(l => l !== '').join('\n');
}

// Chuẩn hoá kết quả 1 phần về dạng chung { vi, target, units:[{vi,target}] }.
function normalizeSentences(raw, targetLang) {
    const mono = targetLang === 'vi';
    return (raw || []).map(s => {
        if (mono) {
            const text = stripCitations(s.text);
            const units = (Array.isArray(s.units) ? s.units : []).map(u => stripCitations(u)).filter(Boolean);
            return { vi: text, target: text, units: units.map(u => ({ vi: u, target: u })) };
        }
        const vi = stripCitations(s.vi), target = stripCitations(s.target);
        const rawUnits = Array.isArray(s.units) ? s.units : [];
        const us = rawUnits
            .map(u => ({ vi: stripCitations(u?.vi || ''), target: stripCitations(u?.target || '') }))
            .filter(u => u.vi && u.target);
        // Lệch cặp vi↔target thì bỏ hết units, lùi về 1 câu = cả đoạn: đọc chồng
        // câu tiếng Việt lên câu tiếng đích khác còn tệ hơn đoạn dài.
        return { vi, target, units: us.length === rawUnits.length && us.length ? us : [] };
    }).filter(s => s.vi || s.target);
}

// ===================== GÁC BẢN TIẾNG VIỆT =====================
// Luật trong prompt là chưa đủ: model vẫn để lọt chữ ngôn ngữ đích vào ô "vi"
// (địa danh, lời thoại trong ngoặc kép, có khi cả câu). Nên phải KIỂM BẰNG MÁY rồi tự dịch nốt.
//
// Hệ chữ không phải Latin thì bắt được chắc chắn (Hàn, Nhật, Hán, Thái, Ả Rập, Kirin, Do Thái).
const FOREIGN_SCRIPT = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u1100-\u11ff\u0e00-\u0e7f\u0600-\u06ff\u0400-\u04ff\u0590-\u05ff]/;
const hasForeignScript = (s) => FOREIGN_SCRIPT.test(String(s || ''));
// Ngôn ngữ đích cũng dùng chữ Latin (en/fr/es...) thì không soi được theo hệ chữ;
// bắt trường hợp lộ liễu nhất là chép nguyên bản đích sang ô "vi".
const isCopyOfTarget = (vi, target) => !!vi && !!target && vi.trim() === target.trim();

const needsViFix = (vi, target) => !vi || hasForeignScript(vi) || isCopyOfTarget(vi, target);

const VI_FIX_RULES = (langName) => [
    'Bạn là biên dịch viên. Dịch sang TIẾNG VIỆT tự nhiên, giữ đúng giọng văn nói của podcast.',
    `Nguồn có thể là ${langName} hoặc đã là tiếng Việt nhưng còn lẫn chữ ${langName}.`,
    'Yêu cầu:',
    '- Kết quả PHẢI là tiếng Việt 100%, không còn sót chữ nước ngoài nào, kể cả trong ngoặc kép.',
    '- TÊN NGƯỜI: giữ nguyên tên gốc ở dạng phiên âm Latin (이다온 → "Lee Da-on", 民規 → "Min-kyu"). TUYỆT ĐỐI không dịch nghĩa tên thành tên Việt.',
    '- ĐỊA DANH / TỔ CHỨC: dùng tên quen dùng trong tiếng Việt hoặc phiên âm Latin (구리 → "Guri", 東京 → "Tokyo").',
    '- Không gộp, không tách, không thêm lời bình.',
];

// Dịch 1 chuỗi lẻ — dùng để vá những câu mà lượt dịch cả mẻ bỏ sót.
async function translateOneToVi(text, langName, tag) {
    const { content, usage } = await aiChat({
        tier: 'mini', json: true,
        messages: [
            { role: 'system', content: [...VI_FIX_RULES(langName), 'Trả về json dạng {"vi": "<bản tiếng Việt>"}.'].join('\n') },
            { role: 'user', content: JSON.stringify({ text }) },
        ],
    });
    logUsage(tag, usage);
    try {
        const out = JSON.parse(String(content).trim().replace(/^```json\s*/i, '').replace(/```$/i, ''));
        return String(out?.vi || '').trim() || null;
    } catch { return null; }
}

// Dịch một mớ chuỗi sang tiếng Việt trong 1 lượt gọi rẻ (tier 'mini').
//
// Ghép kết quả THEO SỐ THỨ TỰ chứ không theo vị trí trong mảng: model nhỏ hay trả thiếu/gộp câu
// (đã gặp: xin 5 câu, trả về 4) — ghép theo vị trí là lệch hết bài, mà bỏ cả mẻ thì chẳng vá được gì.
// Câu nào thiếu thì dịch lẻ lại câu đó.
async function translateBatchToVi(texts, langName, tag) {
    if (!texts.length) return texts;
    const sys = [
        ...VI_FIX_RULES(langName),
        'Đầu vào là json {"items": [{"i": <số>, "text": "<câu gốc>"}, ...]}.',
        `Trả về json {"items": [{"i": <đúng số i đã cho>, "vi": "<bản tiếng Việt>"}, ...]} cho ĐỦ cả ${texts.length} câu, không bỏ sót số nào.`,
    ].join('\n');
    const { content, usage } = await aiChat({
        tier: 'mini', json: true,
        messages: [
            { role: 'system', content: sys },
            { role: 'user', content: JSON.stringify({ items: texts.map((text, i) => ({ i, text })) }) },
        ],
    });
    logUsage(tag, usage);

    const byIndex = new Map();
    try {
        const out = JSON.parse(String(content).trim().replace(/^```json\s*/i, '').replace(/```$/i, ''));
        for (const it of (Array.isArray(out?.items) ? out.items : [])) {
            const i = Number(it?.i);
            const vi = String(it?.vi || '').trim();
            if (Number.isInteger(i) && i >= 0 && i < texts.length && vi) byIndex.set(i, vi);
        }
    } catch { console.warn(`[${tag}] ⚠️ không đọc được kết quả dịch cả mẻ → dịch lẻ từng câu`); }

    const missing = texts.map((_, i) => i).filter(i => !byIndex.has(i));
    if (missing.length) {
        console.warn(`[${tag}] ⚠️ lượt dịch cả mẻ thiếu ${missing.length}/${texts.length} câu → dịch lẻ bù`);
        for (const i of missing) {
            const one = await translateOneToVi(texts[i], langName, tag);
            if (one) byIndex.set(i, one);
        }
    }
    // Vẫn không dịch được thì trả lại chuỗi cũ — chỗ gọi tự đếm là "còn sót" và báo ra log.
    return texts.map((t, i) => byIndex.get(i) || t);
}

// Rà + vá bản tiếng Việt của 1 phần. Sửa TẠI CHỖ trong mảng sentences.
async function enforceVietnamese(sentences, targetLang, tag) {
    if (targetLang === 'vi') return { checked: 0, fixed: 0, left: 0 };
    const langName = langNameOf(targetLang);
    // Gom mọi ô "vi" hỏng (cả đoạn lẫn từng câu đọc) vào một mẻ dịch chung.
    const slots = [];
    for (const s of sentences) {
        if (needsViFix(s.vi, s.target)) slots.push({ get: () => s.target, set: (v) => { s.vi = v; } });
        for (const u of s.units) {
            if (needsViFix(u.vi, u.target)) slots.push({ get: () => u.target, set: (v) => { u.vi = v; } });
        }
    }
    const total = sentences.reduce((n, s) => n + 1 + s.units.length, 0);
    if (!slots.length) return { checked: total, fixed: 0, left: 0 };

    console.warn(`[${tag}] ⚠️ ${slots.length}/${total} ô tiếng Việt còn lẫn ${langName} (hoặc bỏ trống) → dịch lại`);
    // Dịch từ bản ĐÍCH chứ không từ bản vi hỏng: bản đích luôn đầy đủ nghĩa.
    const CHUNK = 30;
    for (let i = 0; i < slots.length; i += CHUNK) {
        const part = slots.slice(i, i + CHUNK);
        const fixed = await translateBatchToVi(part.map(s => s.get()), langName, `${tag}:vi-fix`);
        part.forEach((slot, k) => slot.set(fixed[k]));
    }
    // Còn sót thì nói thẳng ra log chứ không im lặng (bản đích vốn là chữ nước ngoài,
    // dịch hỏng nghĩa là ô đó vẫn là chữ nước ngoài).
    let left = 0;
    for (const s of sentences) {
        if (hasForeignScript(s.vi)) left++;
        for (const u of s.units) if (hasForeignScript(u.vi)) left++;
    }
    if (left) console.warn(`[${tag}] ⚠️ vẫn còn ${left} ô lẫn chữ ${langName} sau khi dịch lại`);
    return { checked: total, fixed: slots.length, left };
}

async function writeSection(ctx) {
    const { targetLang, outline, index, webSearch } = ctx;
    const schema = targetLang === 'vi' ? SECTION_SCHEMA_MONO : SECTION_SCHEMA_BI;
    const tag = `AI:part${index + 1}`;
    const res = await callJson(buildSectionInput(ctx), schema, 'podcast_section', tag,
        { effort: SECTION_EFFORT, webSearch });
    const sentences = normalizeSentences(res.sentences, targetLang);
    await enforceVietnamese(sentences, targetLang, tag);
    if (!sentences.length) throw new Error(`phần ${index + 1} không ra đoạn nào`);
    const nUnits = sentences.reduce((n, s) => n + (s.units.length || 1), 0);
    const words = sentences.reduce((n, s) => n + (s.vi || '').split(/\s+/).length, 0);
    console.log(`[${tag}] ${outline.sections[index].heading_vi}: ${sentences.length} đoạn / ${nUnits} câu đọc / ~${words} từ`);
    sentences.forEach((s, i) => console.log(`    [${i + 1}] ${(s.vi || '').slice(0, 110)}...`));
    return sentences;
}

async function generateScript({ prompt, style, targetLang, outline, webSearch }) {
    const all = [];
    const coveredPoints = [];
    for (let i = 0; i < outline.sections.length; i++) {
        const sentences = await writeSection({
            prompt, style, targetLang, outline, index: i, webSearch,
            coveredPoints: coveredPoints.slice(),
            prevTail: tailOf(all),
        });
        all.push(...sentences);
        coveredPoints.push(...outline.sections[i].key_points);
    }
    const nUnits = all.reduce((n, s) => n + (s.units.length || 1), 0);
    console.log(`[podcast_ai] === KỊCH BẢN: ${all.length} đoạn / ${nUnits} câu đọc ===`);
    return all;
}

// ===================== GHI DB =====================
// Y hệt podcast_srt.js: Paragraph = 1 cảnh (1 đoạn), ParagraphDetail = 1 câu đọc (1 mp3).
async function saveToDb({ projectId, title, targetLang, sentences }) {
    const db = await getDb();
    await db.run(
        'INSERT OR IGNORE INTO Post (project_id, title, status, voice_content_type, target_lang, genre) VALUES (?, ?, ?, ?, ?, ?)',
        [projectId, title, 'crawling', targetLang === 'vi' ? 'content_vi' : 'content', targetLang, 'podcast']
    );
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;
    await db.run(
        "UPDATE Post SET genre = 'podcast', status = 'crawling', title = ?, voice_content_type = ?, target_lang = ? WHERE id = ?",
        [title, targetLang === 'vi' ? 'content_vi' : 'content', targetLang, postId]
    );

    // Chạy lại cùng projectId -> xoá nội dung cũ, tránh nhân đôi cảnh.
    const oldParas = await db.all('SELECT id FROM Paragraph WHERE post_id = ?', [postId]);
    for (const p of oldParas) {
        await db.run('DELETE FROM ParagraphDetail WHERE paragraph_id = ?', [p.id]);
        await db.run('DELETE FROM Paragraph WHERE id = ?', [p.id]);
    }

    let nUnits = 0;
    for (const [si, s] of sentences.entries()) {
        const paraRes = await db.run(
            'INSERT INTO Paragraph (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, s.target || s.vi, s.vi || s.target, si + 1]
        );
        const units = s.units.length ? s.units : [{ vi: s.vi, target: s.target }];
        for (const [li, u] of units.entries()) {
            await db.run(
                'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
                [paraRes.lastID, u.target || u.vi, u.vi || u.target, li + 1]
            );
            nUnits++;
        }
    }
    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    return { postId, nUnits };
}

// ===================== VÁ BẢN TIẾNG VIỆT CHO DỰ ÁN ĐÃ CÓ =====================
//   node src/workers/podcast_ai.js --fixVi --postId <id>
//   node src/workers/podcast_ai.js --fixVi --projectId <project_id>
//
// Dịch nốt những ô tiếng Việt còn lẫn chữ ngôn ngữ đích (hoặc bỏ trống) trong DB.
// Dịch TỪ CỘT ĐÍCH chứ không sửa vặt trên bản vi hỏng — bản đích luôn đủ nghĩa.
// Dòng JSON cuối cùng in ra là kết quả để server đọc.
async function fixViForPost({ postId, projectId }) {
    const db = await getDb();
    const post = postId
        ? await db.get('SELECT id, project_id, target_lang FROM Post WHERE id = ?', [postId])
        : await db.get('SELECT id, project_id, target_lang FROM Post WHERE project_id = ?', [projectId]);
    if (!post) { await db.close(); throw new Error(`không thấy dự án (${postId || projectId})`); }

    const lang = post.target_lang || 'vi';
    if (lang === 'vi') {
        await db.close();
        console.log('[podcast_ai:fixVi] Dự án đọc tiếng Việt (target_lang=vi) — hai cột vốn là một, không có gì để vá.');
        return { projectId: post.project_id, lang, total: 0, fixed: 0, left: 0 };
    }
    const langName = langNameOf(lang);

    const paras = await db.all('SELECT id, content, content_vi FROM Paragraph WHERE post_id = ? ORDER BY "order"', [post.id]);
    const details = await db.all(
        `SELECT d.id, d.content, d.content_vi, d.content_vi_audio FROM ParagraphDetail d
         JOIN Paragraph p ON p.id = d.paragraph_id WHERE p.post_id = ? ORDER BY p."order", d."order"`, [post.id]);

    const slots = [];
    for (const p of paras) if (needsViFix(p.content_vi, p.content)) slots.push({ table: 'Paragraph', id: p.id, src: p.content });
    for (const d of details) if (needsViFix(d.content_vi, d.content)) slots.push({ table: 'ParagraphDetail', id: d.id, src: d.content, hasAudio: !!d.content_vi_audio });

    const total = paras.length + details.length;
    console.log(`[podcast_ai:fixVi] ${post.project_id} (${langName}): ${slots.length}/${total} ô tiếng Việt cần dịch lại.`);
    if (!slots.length) { await db.close(); return { projectId: post.project_id, lang, total, fixed: 0, left: 0 }; }

    // Câu đã có giọng đọc tiếng Việt: sửa chữ xong thì mp3 cũ không còn khớp — phải nói rõ.
    const withAudio = slots.filter(s => s.hasAudio).length;
    if (withAudio) console.warn(`[podcast_ai:fixVi] ⚠️ ${withAudio} câu đã có audio tiếng Việt — sửa chữ xong phải tạo lại voice cho khớp.`);

    const CHUNK = 30;
    let fixed = 0;
    for (let i = 0; i < slots.length; i += CHUNK) {
        const part = slots.slice(i, i + CHUNK);
        const out = await translateBatchToVi(part.map(s => s.src), langName, 'podcast_ai:fixVi');
        for (const [k, slot] of part.entries()) {
            const text = out[k];
            if (!text || text === slot.src) continue;      // dịch hỏng -> giữ nguyên, đếm vào "còn sót"
            await db.run(`UPDATE ${slot.table} SET content_vi = ? WHERE id = ?`, [text, slot.id]);
            fixed++;
        }
        console.log(`[podcast_ai:fixVi] đã vá ${Math.min(i + CHUNK, slots.length)}/${slots.length} ô`);
    }

    // Đếm lại trên DB thật (chứ không tin bộ đếm trong bộ nhớ) xem còn sót gì không.
    const after = await db.all(
        `SELECT d.content_vi cv FROM ParagraphDetail d JOIN Paragraph p ON p.id = d.paragraph_id WHERE p.post_id = ?
         UNION ALL SELECT content_vi FROM Paragraph WHERE post_id = ?`, [post.id, post.id]);
    const left = after.filter(r => hasForeignScript(r.cv)).length;
    await db.close();
    console.log(`[podcast_ai:fixVi] ✅ ${post.project_id}: vá ${fixed}/${slots.length} ô, còn ${left} ô lẫn chữ ${langName}.`);
    return { projectId: post.project_id, lang, total, fixed, left, needVoiceRedo: withAudio };
}

// ===================== MAIN =====================
function parseArgs(argv) {
    const o = { lang: 'vi', minutes: 10, style: '', web: false, title: '', projectId: '', prompt: '', fixVi: false, postId: '' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--fixVi') o.fixVi = true;
        else if (a === '--postId') o.postId = (argv[++i] || '').trim();
        else if (a === '--projectId') o.projectId = (argv[++i] || '').trim();
        else if (a === '--prompt') o.prompt = (argv[++i] || '').trim();
        else if (a === '--lang') o.lang = (argv[++i] || 'vi').trim() || 'vi';
        else if (a === '--minutes') o.minutes = Math.min(120, Math.max(1, parseInt(argv[++i], 10) || 10));
        else if (a === '--style') o.style = (argv[++i] || '').trim();
        else if (a === '--title') o.title = (argv[++i] || '').trim();
        else if (a === '--web') o.web = true;
    }
    return o;
}

async function main() {
    const opt = parseArgs(process.argv.slice(2));

    if (opt.fixVi) {
        if (!opt.postId && !opt.projectId) {
            console.error('Usage: node podcast_ai.js --fixVi --postId <id> | --projectId <project_id>');
            process.exit(1);
        }
        assertAiKey();
        const r = await fixViForPost({ postId: opt.postId, projectId: opt.projectId });
        console.log(JSON.stringify(r));    // dòng cuối = kết quả cho server đọc
        return;
    }

    if (!opt.projectId || !opt.prompt) {
        console.error('Usage: node podcast_ai.js --projectId <id> --prompt "<chủ đề>" [--lang vi] [--minutes 15] [--style "..."] [--web] [--title "..."]');
        process.exit(1);
    }
    assertAiKey();
    teeLogToProject(opt.projectId);
    const projectDir = path.join(MEDIA_DIR, opt.projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const plan = planScript(opt.minutes);
    console.log(`[podcast_ai] ${opt.projectId} — ${aiProviderName()} · ${opt.minutes} phút (~${plan.targetWords} từ, ${plan.sectionCount} phần) · lang=${opt.lang}${opt.web ? ' · web search' : ''}`);
    console.log(`[podcast_ai] Chủ đề: ${opt.prompt}`);

    // Dựng Post SỚM để dashboard hiện dự án ngay, không phải đợi AI viết xong (mất vài phút).
    const db0 = await getDb();
    await db0.run(
        "INSERT OR IGNORE INTO Post (project_id, title, status, genre, target_lang) VALUES (?, ?, 'crawling', 'podcast', ?)",
        [opt.projectId, opt.title || opt.projectId, opt.lang]
    );
    await db0.run("UPDATE Post SET status = 'crawling', genre = 'podcast' WHERE project_id = ?", [opt.projectId]);
    await db0.close();
    await notifyDashboard(opt.projectId, 'crawling');

    const { outline, conflicts } = await generateOutline({
        prompt: opt.prompt, style: opt.style, targetLang: opt.lang, plan, webSearch: opt.web,
    });
    fs.writeFileSync(path.join(projectDir, 'ai_outline.json'),
        JSON.stringify({ prompt: opt.prompt, style: opt.style, lang: opt.lang, minutes: opt.minutes, outline, conflicts }, null, 2));

    const sentences = await generateScript({
        prompt: opt.prompt, style: opt.style, targetLang: opt.lang, outline, webSearch: opt.web,
    });
    fs.writeFileSync(path.join(projectDir, 'ai_content.json'),
        JSON.stringify({ title: outline.title_vi, lang: opt.lang, sentences }, null, 2));

    const title = opt.title || outline.title_vi || outline.title || opt.projectId;
    const { postId, nUnits } = await saveToDb({ projectId: opt.projectId, title, targetLang: opt.lang, sentences });

    // Ghi thẻ nhớ SAU CÙNG: bài hỏng giữa chừng không được chiếm chỗ tên nhân vật.
    const entry = saveEntry({
        projectId: opt.projectId, title: outline.title, titleVi: outline.title_vi,
        lang: opt.lang, minutes: opt.minutes, topic: opt.prompt,
        logline: outline.logline, summary: outline.summary, angle: outline.angle,
        keyPoints: outline.sections.flatMap(s => s.key_points).slice(0, 30),
        characters: outline.characters, settings: outline.settings, keywords: outline.keywords,
    });
    console.log(`[podcast_ai] 🧠 Đã lưu thẻ nhớ: ${entry.characters.length} nhân vật (${entry.characters.map(c => c.name).join(', ') || '—'}), ${entry.keyPoints.length} ý chính.`);

    await notifyDashboard(opt.projectId, null);
    console.log(`[podcast_ai] ✅ '${opt.projectId}' (post ${postId}): ${sentences.length} cảnh / ${nUnits} câu đọc — "${title}"`);
}

main().catch(async (e) => {
    console.error('[podcast_ai] LỖI:', e.message);
    const opt = parseArgs(process.argv.slice(2));
    // Chế độ vá chỉ đụng vào dự án CÓ SẴN — không được dọn dẹp gì cả.
    if (opt.fixVi) process.exit(1);
    // Dọn "ghost project": post đã tạo nhưng chưa có cảnh nào -> xoá, không để dashboard kẹt dự án rỗng.
    const projectId = opt.projectId;
    try {
        const db = await getDb();
        const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
        if (post) {
            const np = await db.get('SELECT COUNT(*) AS n FROM Paragraph WHERE post_id = ?', [post.id]);
            if (!np || !np.n) await db.run('DELETE FROM Post WHERE id = ?', [post.id]);
            else await db.run('UPDATE Post SET status = NULL WHERE id = ?', [post.id]);
        }
        await db.close();
    } catch (_) {}
    await notifyDashboard(projectId, null, true);   // silent: dự án lỗi, không bắn Slack
    process.exit(1);
});
