import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'url';
import { crawlKeywordImageRotate } from '../crawlers/imageCrawlRotate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');   // src/workers -> gốc repo

const OPENAI_KEY = process.env.OPENAI_KEY;
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const PORT = process.env.PORT || 3000;
const IMAGES_PER_KEYWORD = 8;
// Trần token đầu ra của GPT-5 cho 1 bài phân tích. Cần rộng vì mỗi đoạn trả về CẢ đoạn
// nguyên (vi/target) LẪN các câu đã cắt trong "units" → nội dung bị lặp ~2 lần.
// Chạm trần thì GPT trả status='incomplete' và mất trắng cả bài. Chỉnh qua env nếu cần.
const MAX_OUTPUT_TOKENS = parseInt(process.env.SPORTS_MAX_OUTPUT_TOKENS || '50000', 10);
// Bài dưới ngưỡng điểm này -> gọi GPT-5 viết lại, LẶP tới khi đạt (hoặc hết số lần). 0 = tắt chấm/viết lại.
// Chỉ áp dụng cho chế độ --prompt (bài do GPT viết); chế độ SRT là kịch bản của người dùng, không đụng vào.
const REWRITE_SCORE_THRESHOLD = parseInt(process.env.SPORTS_REWRITE_BELOW || '75', 10);
// Trần số lần viết lại — mỗi lần là 1 lượt GPT-5 đầy đủ (đắt), nên để thấp hơn geo.
const REWRITE_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.SPORTS_REWRITE_MAX_ATTEMPTS, 10) || 2);

// ===== CHẾ ĐỘ BÀI DÀI (20-40 phút) =====
// 1 lượt GPT-5 không viết nổi 20-40 phút: trần token đầu ra có hạn (mà "units" nhân đôi output),
// và bài càng dài model càng loãng ý, lặp lại. Nên chia làm 2 tầng:
//   1) 1 lượt lên DÀN Ý (chia phần, mỗi phần có mục đích + luận điểm + số từ)
//   2) mỗi phần 1 lượt viết RIÊNG, chạy TUẦN TỰ và mang theo: dàn ý tổng, các ý đã nói ở phần trước
//      (để không lặp), và ĐUÔI văn bản của phần liền trước (để nối giọng cho liền mạch).
// Chấm + viết lại làm NGAY từng phần, trước khi viết phần sau — như vậy phần sau nối vào bản đã tốt.
const LONG_MIN_MINUTES = parseInt(process.env.SPORTS_LONG_MIN_MINUTES || '12', 10);   // dài hơn mức này mới chạy dàn ý
const WORDS_PER_MINUTE = parseInt(process.env.SPORTS_WORDS_PER_MINUTE || '330', 10);  // tốc độ đọc (khớp mốc 8-10' ≈ 2400-3500 từ)
const WORDS_PER_SECTION = parseInt(process.env.SPORTS_WORDS_PER_SECTION || '1300', 10); // mỗi lượt gọi viết bấy nhiêu từ
const SECTION_MIN = 3, SECTION_MAX = 12;
// Viết lại từng phần chưa đạt điểm. 0 = tắt (chỉ viết 1 lượt/phần, nhanh và rẻ hơn nhiều).
const SECTION_REWRITE_MAX = Math.max(0, parseInt(process.env.SPORTS_SECTION_REWRITE_MAX, 10) || 1);
// Mức suy luận khi viết TỪNG PHẦN. 'high' cho chất lượng cao nhất nhưng mỗi lượt lâu vài phút;
// bài dài gọi cả chục lượt nên đây là nút hạ thời gian chạy đáng kể nhất ('medium' nhanh hơn nhiều).
// Dàn ý LUÔN dùng 'high' — sai dàn ý là hỏng cả bài, mà nó chỉ tốn đúng 1 lượt.
const SECTION_EFFORT = ['low', 'medium', 'high'].includes(process.env.SPORTS_SECTION_EFFORT) ? process.env.SPORTS_SECTION_EFFORT : 'high';
// Model CHẤM ĐIỂM. Phải ngang cấp với model viết bài: gpt-4o-mini chấm bài gpt-5 cho ra điểm gần như
// cố định nên vòng viết lại chạy mù. effort 'medium' là chỗ cân bằng — chấm không cần suy luận sâu
// bằng lúc viết, mà mỗi phần lại chấm 1-2 lần nên để 'high' là đội thêm rất nhiều thời gian.
const SCORE_MODEL = process.env.SPORTS_SCORE_MODEL || 'gpt-5';
const SCORE_EFFORT = ['low', 'medium', 'high'].includes(process.env.SPORTS_SCORE_EFFORT) ? process.env.SPORTS_SCORE_EFFORT : 'medium';

// Số phần + số từ mỗi phần cho độ dài yêu cầu.
function planLongArticle(minutes) {
    const targetWords = Math.round(minutes * WORDS_PER_MINUTE);
    const sectionCount = Math.min(SECTION_MAX, Math.max(SECTION_MIN, Math.round(targetWords / WORDS_PER_SECTION)));
    return { targetWords, sectionCount, wordsPerSection: Math.round(targetWords / sectionCount) };
}

const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

// Ghi song song mọi console.* ra <project>/process.log. Log của worker vốn chỉ đổ vào stdout của
// server (thường là 1 terminal ai đó lỡ đóng là mất), mà bài dài chạy 15-40 phút thì phải nhìn được
// nó đang ở phần mấy. File này chính là thứ /api/project-log/:projectId trả về cho nút "Log" trên UI.
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
                // Ghi log hỏng (đầy đĩa, mất quyền) KHÔNG được làm chết pipeline đang viết bài.
                try { fs.appendFileSync(file, `[${new Date().toTimeString().slice(0, 8)}] ${a.map(fmt).join(' ')}\n`); } catch (_) {}
            };
        }
        console.log(`[sports_srt] Ghi log tiến độ vào ${file}`);
    } catch (_) {}
}

// Tạo/cập nhật Post SỚM để dashboard hiện dự án NGAY từ lúc bấm tạo, không phải đợi GPT-5 viết xong
// (khâu viết + chấm + viết lại mất vài phút, trước đây màn hình trắng trơn nên tưởng treo). status:
//   'scripting' -> đang viết kịch bản | 'rewriting' -> chưa đủ điểm, đang viết lại
//   'crawling'  -> đang cào ảnh       | null -> xong
// silent=true: chỉ đẩy SSE, KHÔNG bắn Slack (dùng khi dọn dự án lỗi — không phải "crawl xong").
async function setSportsStatus(projectId, status, { title = null, silent = false } = {}) {
    if (!projectId) return;
    try {
        const db = await getDb();
        await db.run("INSERT OR IGNORE INTO Post (project_id, genre) VALUES (?, 'sport')", [projectId]);
        if (title) await db.run('UPDATE Post SET status = ?, title = ? WHERE project_id = ?', [status, title, projectId]);
        else await db.run('UPDATE Post SET status = ? WHERE project_id = ?', [status, projectId]);
        await db.close();
    } catch (e) { console.warn('[sports_srt] set status lỗi:', e.message); }
    await notifyDashboard(projectId, status, silent);
}

// Báo dashboard qua SSE (KHÔNG đụng DB): dự án chưa có trong danh sách thì client tự nạp lại (status != null).
// silent=true -> server bỏ qua Slack (dùng cho status=null của dự án lỗi, không phải "crawl xong").
// Luôn resolve (server chưa chạy / lỗi mạng cũng kệ) và PHẢI await trước process.exit, kẻo request bị cắt giữa chừng.
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

// Đọc file phụ trợ cho prompt viết kịch bản (glossary thuật ngữ...).
// Ưu tiên bản theo ngôn ngữ <base>.<lang>.txt rồi mới tới bản chung <base>.txt — cùng quy ước
// với src/services/seoTitle.js, nên sau này thêm thuatngu_bongda.en.txt là tự động dùng cho 'en'.
// Tìm trong repo trước, rồi tới MEDIA_DIR (cho phép sửa glossary ngoài repo mà không phải deploy).
// Thiếu file thì trả '' và pipeline chạy bình thường như trước — glossary là tuỳ chọn, không bắt buộc.
function readContentPrompt(base, lang) {
    const wanted = [`${base}.${lang}.txt`, `${base}.txt`].map(n => n.toLowerCase());
    for (const dir of [path.join(ROOT, 'prompts', 'contents'), path.join(MEDIA_DIR, 'prompts', 'contents')]) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const w of wanted) {
            const hit = files.find(f => f.toLowerCase() === w);
            if (hit) {
                const txt = fs.readFileSync(path.join(dir, hit), 'utf8').trim();
                if (txt) return { text: txt, file: path.join(dir, hit) };
            }
        }
    }
    return { text: '', file: '' };
}

// Trần thời gian KHÔNG NHẬN ĐƯỢC BYTE NÀO của 1 lượt gọi. GPT-5 effort=high + web_search
// im lặng rất lâu trong lúc "nghĩ" nên phải để rộng; chỉnh qua env nếu mạng hay rớt.
const HTTP_TIMEOUT_MS = parseInt(process.env.SPORTS_HTTP_TIMEOUT_MS || '600000', 10);

// QUAN TRỌNG: phải có timeout. Không có thì kết nối bị cắt âm thầm (NAT/proxy dọn luồng đứng yên
// suốt mấy phút GPT-5 nghĩ) sẽ để promise TREO VĨNH VIỄN — worker đứng im, không log, không chết,
// nhìn y như "đang viết rất lâu". Bài dài gọi 10-20 lượt nối tiếp nên khả năng dính cao gấp bội.
function httpsPost(url, headers, body, { timeoutMs = HTTP_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const data = JSON.stringify(body);
        const req = https.request(
            { hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', family: 4, headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
            (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, body: raw })); }
        );
        // Đếm theo LẦN CUỐI có dữ liệu (socket timeout), nên response chảy về từng chunk vẫn không bị cắt oan.
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`không phản hồi sau ${Math.round(timeoutMs / 1000)}s`)));
        // Keepalive để thiết bị mạng ở giữa không coi luồng là chết trong lúc chờ model nghĩ.
        req.on('socket', s => s.setKeepAlive(true, 30000));
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

const SPORTS_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        title_vi: { type: 'string' },
        sentences: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    vi: { type: 'string' },
                    target: { type: 'string' },
                    image_suggestions: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    // Đoạn được CHÍNH GPT cắt sẵn thành các câu ngắn, vi/target ghép cặp 1-1.
                    // Không tự cắt bằng regex ở phía Node: tiếng Nhật/Trung kết câu bằng 。
                    // và không có dấu cách, cắt kiểu latin sẽ hỏng và làm lệch số dòng vi↔target.
                    units: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                vi: { type: 'string' },
                                target: { type: 'string' }
                            },
                            required: ['vi', 'target'],
                            additionalProperties: false
                        }
                    }
                },
                required: ['vi', 'target', 'image_suggestions', 'units'],
                additionalProperties: false
            }
        }
    },
    required: ['title', 'title_vi', 'sentences'],
    additionalProperties: false
};

// Chỉ có "sentences" — dùng cho từng PHẦN của bài dài (tiêu đề đã nằm ở dàn ý, không xin lại).
const SECTION_SCHEMA = {
    type: 'object',
    properties: { sentences: SPORTS_SCHEMA.properties.sentences },
    required: ['sentences'],
    additionalProperties: false,
};

// Dàn ý bài dài: chia phần, mỗi phần nêu rõ mục đích + luận điểm bắt buộc + số từ.
// "angle" là góc kể xuyên suốt — thứ giữ cho các lượt gọi API rời rạc vẫn ra một bài thống nhất.
const OUTLINE_SCHEMA = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        title_vi: { type: 'string' },
        angle: { type: 'string' },
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
    required: ['title', 'title_vi', 'angle', 'sections'],
    additionalProperties: false,
};

// Kết quả chấm điểm. Dùng json_schema strict thay cho response_format:'json_object' như trước:
// model buộc trả đủ 5 tiêu chí đúng kiểu, không còn cảnh thiếu trường rồi phải vá bằng default.
const SCORE_SCHEMA = {
    type: 'object',
    properties: {
        score: { type: 'integer' },
        reason: { type: 'string' },
        criteria: {
            type: 'array',
            items: {
                type: 'object',
                properties: { name: { type: 'string' }, score: { type: 'integer' }, comment: { type: 'string' } },
                required: ['name', 'score', 'comment'],
                additionalProperties: false,
            },
        },
        strengths: { type: 'array', items: { type: 'string' } },
        weaknesses: { type: 'array', items: { type: 'string' } },
        suggestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['score', 'reason', 'criteria', 'strengths', 'weaknesses', 'suggestions'],
    additionalProperties: false,
};

const langNameOf = (targetLang) => ({ vi: 'tieng Viet', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish', th: 'Thai', id: 'Bahasa Indonesia' }[targetLang] || targetLang);

// Toàn bộ luật viết bài (+ glossary). Dùng CHUNG cho lượt viết đầu và các lượt viết lại —
// bản viết lại phải tuân thủ y hệt luật cũ, nếu không sửa điểm yếu xong lại vỡ format/units.
// lengthLine: câu quy định ĐỘ DÀI ở luật 5. Bài dài gọi nhiều lượt, mỗi lượt chỉ viết 1 phần
// nên phải thay câu "8-10 phút / 2400-3500 từ" bằng chỉ tiêu của riêng phần đó.
function buildSystemPrompt(targetLang, lengthLine) {
    const langName = langNameOf(targetLang);
    const systemPrompt = `You are a professional sports commentator and analyst with access to the latest football data up to 2026.
Task:
1. Write a detailed sports analysis article simultaneously in Vietnamese AND ${langName}.
2. Use the most up-to-date data: current squad, recent form, head-to-head, key players, tactical setup.
3. Pronounce player names, coaches, tournaments correctly in both languages.
4. Content: Provide a detailed and logical analysis of a specific team or player, or both teams (pre-match analysis, including head-to-head history if available). Each category I've mentioned should be analyzed in a suitable format. Pre-match analysis will be more in-depth, including: form, tactics, key players (competition between players, e.g., midfielders, forwards, defenders), injury information, predictions, etc. Additionally, include interesting match-related information (such as potential records, player transfers, or any breaking news; any recent stories about players or coaches from either team reported in the press – this should only be done if you verify and find accurate information from reliable sources).
5. ${lengthLine || 'Target duration: 8-10 minutes of presentation content (approximately 2400-3500 words in the target language).'} Divide the analysis into paragraphs of 3-5 sentences each. Each "sentence" in the JSON output should be a FULL PARAGRAPH (multiple sentences combined), not a single short sentence. Group related ideas into one cohesive paragraph.
6. For each paragraph, provide the flow in Vietnamese and sequentially list the important keywords (following the subtitle flow) to search for images that match the subtitle.
7. NEVER cite sources, never add footnotes, never mention where data comes from, never add URLs, never add links in parentheses like ([source.com](url)).
8. Output ONLY clean sentences with no citations, no references, no URLs whatsoever.
9. Return JSON where each sentence has both "vi" (Vietnamese) and "target" (${langName}) versions.
10. SPLIT EACH PARAGRAPH INTO SHORT SPOKEN UNITS in the "units" array. Rules:
   - Each unit is one short, self-contained chunk of speech. Cut at sentence ends first; if a sentence is still long, cut it further at a natural clause boundary (comma, colon, semicolon, or the equivalent punctuation in ${langName}).
   - Keep each unit at MOST about 160 Vietnamese characters (roughly 25-30 words). Shorter is fine. Never exceed ~200.
   - Every unit MUST have both "vi" and "target", and they MUST be translations of each other. The number of units and their order MUST be identical in meaning across the two languages - unit i in Vietnamese says exactly what unit i in ${langName} says.
   - Concatenating all "vi" units MUST reproduce the paragraph's "vi" text, and the same for "target". Do not add, drop, or reorder any content.
   - Do not cut in the middle of a name, number, or figure.
11. No need to confirm with me, just go ahead.`;

    // Glossary thuật ngữ bóng đá (prompts/contents/thuatngu_bongda.txt). Ép GPT dùng đúng thuật ngữ
    // nhà nghề thay vì tự dịch thô — nhất là bản ${langName}, nơi dịch máy hay ra chữ không ai dùng.
    // Nối vào CUỐI system prompt để phần nhiệm vụ vẫn nằm gần đầu, không bị glossary dài đẩy trôi.
    const glossary = readContentPrompt('thuatngu_bongda', targetLang);
    let systemPromptFull = systemPrompt;
    if (glossary.text) {
        systemPromptFull += `

===== GLOSSARY: thuật ngữ bóng đá chuẩn =====
Dưới đây là bảng thuật ngữ bóng đá. Định dạng mỗi dòng: thuật ngữ ${langName} (phiên âm/tên gốc): giải nghĩa tiếng Việt.
Khi CẦN nói tới một khái niệm có trong bảng, hãy dùng ĐÚNG thuật ngữ ở đây — dạng ${langName} cho bản "target", dạng tiếng Việt cho bản "vi".
Không tự dịch lại theo cách khác, không bịa thuật ngữ mới. Không nhắc tới bảng thuật ngữ này trong bài viết, và KHÔNG liệt kê nó ra.
Đây chỉ là từ điển tham chiếu, KHÔNG phải chủ đề bài viết.

QUY TẮC SỬ DỤNG THUẬT NGỮ (BẮT BUỘC TUÂN THỦ):
- Mức độ sử dụng: Ưu tiên diễn đạt bằng văn phong mượt mà, dễ hiểu. Chỉ dùng thuật ngữ trong danh sách khi THẬT SỰ CẦN THIẾT để phân tích tình huống/chiến thuật. Tần suất trung bình: TỐI ĐA 1-2 thuật ngữ cho mỗi 300 từ.
- Không lạm dụng: TUYỆT ĐỐI KHÔNG nhồi nhét thuật ngữ. Nếu một câu có thể diễn đạt bằng ${langName} thông thường mà vẫn hay, hãy dùng ${langName} thông thường.
- Tính ngữ cảnh: Chỉ dùng thuật ngữ khi ngữ cảnh đòi hỏi độ chính xác chuyên môn cao. Không gượng ép chèn từ vào các đoạn dẫn dắt, mở bài, kết bài hay câu chuyển ý thông thường.
- Tự kiểm trước khi trả kết quả: rà lại toàn bài, nếu mật độ thuật ngữ vượt mức trên thì viết lại các câu thừa thuật ngữ bằng lời văn thông thường.

${glossary.text}`;
        console.log(`[GPT-5] Đã nạp glossary: ${glossary.file} (${glossary.text.length} ký tự)`);
    } else {
        console.log('[GPT-5] Không có file thuatngu_bongda.txt → viết kịch bản không kèm glossary.');
    }
    return systemPromptFull;
}

// 1 lượt gọi GPT-5 (web search + JSON schema) -> object đã parse. Dùng chung cho dàn ý lẫn viết bài.
// Lỗi MẠNG/timeout thì thử lại (mỗi lượt rất đắt, rớt mạng mà bỏ luôn là phí cả phần bài);
// lỗi 4xx (sai key, sai schema) thì hỏng hẳn, thử lại vô nghĩa nên ném luôn.
async function callGpt5Json(input, schema, schemaName, tag, opts = {}) {
    const { model = 'gpt-5', effort = 'high', webSearch = true } = opts;
    let res, lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            res = await httpsPost(
                'https://api.openai.com/v1/responses',
                { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
                {
                    model,
                    // Tham số reasoning chỉ hợp lệ với dòng model suy luận (gpt-5, o*); gửi cho gpt-4o là lỗi 400.
                    ...(/^(gpt-5|o\d)/.test(model) ? { reasoning: { effort } } : {}),
                    ...(webSearch ? { tools: [{ type: 'web_search_preview' }] } : {}),
                    max_output_tokens: MAX_OUTPUT_TOKENS,
                    text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } },
                    input
                }
            );
            if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 150)}`);
            break;
        } catch (e) {
            lastErr = e;
            console.warn(`[${tag}] lượt gọi lỗi (lần ${attempt}/3): ${e.message}`);
            if (attempt === 3) throw new Error(`gọi GPT-5 thất bại sau 3 lần: ${lastErr.message}`);
            await new Promise(r => setTimeout(r, 5000 * attempt));
        }
    }
    if (res.status !== 200) throw new Error(`GPT loi ${res.status}: ${res.body.slice(0, 200)}`);
    const data = JSON.parse(res.body);
    const usage = data.usage;
    console.log(`[${tag}] tokens - input: ${usage?.input_tokens}, output: ${usage?.output_tokens}, reasoning: ${usage?.output_tokens_details?.reasoning_tokens}`);
    if (data.status === 'incomplete') {
        const reason = data.incomplete_details?.reason || 'unknown';
        throw new Error(`GPT-5 incomplete: ${reason}. Output tokens: ${usage?.output_tokens}/${MAX_OUTPUT_TOKENS}`);
    }
    const outputText = data.output?.find(o => o.type === 'message')
        ?.content?.find(c => c.type === 'output_text')?.text;
    if (!outputText) throw new Error('GPT-5 khong tra ve output: ' + JSON.stringify(data).slice(0, 200));
    return JSON.parse(outputText);
}

// Bỏ citation kiểu ([uefa.com](https://...)) và URL trần mà web_search hay chèn vào.
const stripCitations = s => String(s || '').replace(/\s*\([^)]*\(https?:[^)]+\)[^)]*\)/g, '').replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();

// Dọn citation + lọc units lệch cặp cho mảng sentences trả về từ GPT.
function cleanSentences(rawSentences) {
    // Chỉ nhận units khi vi/target ghép cặp đầy đủ. Lệch cặp mà vẫn dùng thì dòng tiếng Việt
    // sẽ đọc chồng lên câu tiếng đích khác → thà lùi về 1 detail nguyên đoạn như cũ.
    const cleanUnits = (s) => {
        const raw = Array.isArray(s.units) ? s.units : [];
        const us = raw
            .map(u => ({ vi: stripCitations(u?.vi || ''), target: stripCitations(u?.target || '') }))
            .filter(u => u.vi && u.target);
        return us.length === raw.length && us.length > 0 ? us : [];
    };
    return (rawSentences || []).map(s => ({
        vi: stripCitations(s.vi), target: stripCitations(s.target),
        image_suggestions: s.image_suggestions || [], units: cleanUnits(s),
    }));
}

// 1 lượt GPT-5 sinh bài theo SPORTS_SCHEMA (dùng cho cả lượt viết đầu lẫn viết lại).
// Trả { title, title_vi, sentences } đã dọn citation + lọc units lệch cặp.
async function callSportsGpt(input, tag = 'GPT-5') {
    const parsed = await callGpt5Json(input, SPORTS_SCHEMA, 'sports_analysis', tag);
    parsed.sentences = cleanSentences(parsed.sentences);
    console.log(`[${tag}] === OUTPUT ===`);
    console.log('Title VI:', parsed.title_vi);
    console.log('Title:', parsed.title);
    (parsed.sentences || []).forEach((s, i) => {
        console.log(`  [${i + 1}] (${s.units.length} câu) VI: ${s.vi}`);
        s.units.forEach((u, k) => console.log(`      ${i + 1}.${k + 1} (${u.vi.length}) ${u.vi}`));
    });
    const noSplit = (parsed.sentences || []).filter(s => !s.units.length).length;
    if (noSplit) console.warn(`[${tag}] ⚠️ ${noSplit} đoạn không cắt được câu (units lệch cặp) → giữ nguyên cả đoạn.`);
    console.log(`[${tag}] === END OUTPUT ===`);
    return { title: parsed.title || '', title_vi: parsed.title_vi || '', sentences: parsed.sentences || [] };
}

async function generateSentencesFromPrompt(prompt, targetLang) {
    return callSportsGpt(buildSystemPrompt(targetLang) + '\n\nRequest: ' + prompt, 'GPT-5');
}

// ===================== BÀI DÀI: DÀN Ý -> VIẾT TỪNG PHẦN =====================

// Bước 1: 1 lượt GPT-5 lên dàn ý. Không viết chữ nào của bài, chỉ chia phần + chốt luận điểm,
// vì đây là thứ giữ cho các lượt viết sau (mỗi lượt 1 context riêng) không lạc đề và không lặp nhau.
async function generateOutline(prompt, targetLang, plan) {
    const langName = langNameOf(targetLang);
    const input = [
        `You are the head writer of a football analysis YouTube channel, with access to the latest data up to 2026.`,
        `Plan (DO NOT WRITE THE SCRIPT YET) a LONG video script of about ${plan.minutes} minutes — roughly ${plan.targetWords} words of spoken Vietnamese in total.`,
        '',
        `Break it into EXACTLY ${plan.sectionCount} sequential parts. Each part will later be written by a SEPARATE model call that only sees this outline plus the tail of the previous part, so the outline must be self-sufficient:`,
        `- "heading_vi" / "heading": short name of the part (Vietnamese / ${langName}). These are internal labels, they are NOT read out loud.`,
        '- "purpose": what this part must accomplish in the narrative arc, and how it differs from its neighbours.',
        '- "key_points": 3-6 CONCRETE things this part must cover (specific players, matches, numbers, tactical themes, storylines). Be specific enough that two parts can never end up writing the same thing.',
        `- "target_words": how many Vietnamese words this part should take (they must add up to about ${plan.targetWords}; aim for ~${plan.wordsPerSection} each).`,
        '',
        'Structure rules:',
        '- Part 1 must open the video (hook + framing). The LAST part must close it (verdict / prediction / sign-off). The middle parts carry the analysis and must escalate, not repeat.',
        '- Order the parts so the script builds naturally: context -> form -> tactics -> key players/duels -> injuries & squad news -> storylines/records -> prediction.',
        '- Do NOT create two parts that cover the same ground from a different wording. Each part must own its material.',
        '',
        `Use web search to ground the plan in the most up-to-date real data (squads, form, injuries, head-to-head, transfers). Never invent facts.`,
        `"angle" = one sentence describing the through-line / editorial angle that every part must serve, so the finished script reads as ONE video, not ${plan.sectionCount} separate ones.`,
        `Title in Vietnamese ("title_vi") and in ${langName} ("title").`,
        '',
        '===== REQUEST FROM THE EDITOR =====',
        prompt,
    ].join('\n');

    const outline = await callGpt5Json(input, OUTLINE_SCHEMA, 'sports_outline', 'GPT-5:outline');
    let sections = (outline.sections || []).filter(s => (s.heading_vi || s.heading) && (s.purpose || '').trim());
    if (!sections.length) throw new Error('GPT-5 trả dàn ý rỗng');
    // GPT hay trả thừa/thiếu phần so với yêu cầu; cắt bớt thì mất phần kết -> chỉ cắt phần GIỮA, luôn giữ phần cuối.
    if (sections.length > SECTION_MAX) sections = [...sections.slice(0, SECTION_MAX - 1), sections[sections.length - 1]];
    // Số từ GPT tự chia hay lệch xa; ép về mức an toàn cho 1 lượt gọi.
    // Dọn citation NGAY ở dàn ý: web_search nhét ([uefa.com](https://...)) vào từng luận điểm, mà luận
    // điểm được chép nguyên vào prompt viết bài -> vừa phí token vừa mồi cho model chép citation ra bài
    // (dù stripCitations có dọn đầu ra, đừng đưa thứ mình cấm vào ngay trong đề bài).
    sections = sections.map(s => ({
        ...s,
        purpose: stripCitations(s.purpose),
        key_points: (Array.isArray(s.key_points) ? s.key_points : []).map(stripCitations).filter(Boolean),
        target_words: Math.min(2000, Math.max(600, Number(s.target_words) || plan.wordsPerSection)),
    }));
    outline.sections = sections;

    console.log(`[GPT-5:outline] === DÀN Ý (${sections.length} phần, ~${sections.reduce((n, s) => n + s.target_words, 0)} từ) ===`);
    console.log('  Tiêu đề:', outline.title_vi, '|', outline.title);
    console.log('  Góc kể :', outline.angle);
    sections.forEach((s, i) => {
        console.log(`  [${i + 1}] ${s.heading_vi} (~${s.target_words} từ) — ${s.purpose}`);
        s.key_points.forEach(k => console.log(`        • ${k}`));
    });
    return outline;
}

// Đuôi bài đã viết (2 đoạn cuối) — đưa nguyên văn cho lượt sau để nối giọng, nối mạch.
// Cắt ngắn để không phình input: chỉ cần đủ để model bắt được nhịp và biết câu trước dừng ở đâu.
function tailOf(sentences, nParas = 2, maxChars = 1200) {
    const tail = (sentences || []).slice(-nParas).map(s => (s.vi || '').trim()).filter(Boolean).join('\n\n');
    return tail.length > maxChars ? '...' + tail.slice(-maxChars) : tail;
}

// Prompt viết 1 PHẦN. Tách riêng vì lượt viết lại phải dùng LẠI Y HỆT prompt này rồi mới nối
// thêm nhận xét của biên tập — khác luật một chút là phần viết lại lệch format/giọng với các phần kia.
function buildSectionInput({ prompt, targetLang, outline, index, coveredPoints, prevTail }) {
    const sec = outline.sections[index];
    const total = outline.sections.length;
    const isFirst = index === 0, isLast = index === total - 1;
    const lengthLine = `You are writing ONLY PART ${index + 1} OF ${total} of a long video script. Write approximately ${sec.target_words} words for THIS PART ONLY — do not write the other parts.`;

    return [
        buildSystemPrompt(targetLang, lengthLine),
        '',
        '===== THIS IS ONE PART OF A LONGER SCRIPT =====',
        `Original request from the editor: ${prompt}`,
        `Video title: ${outline.title_vi} | ${outline.title}`,
        `Through-line every part must serve: ${outline.angle}`,
        '',
        'FULL OUTLINE (context only — never write another part):',
        outline.sections.map((s, i) => `  ${i + 1}. ${s.heading_vi}${i === index ? '   <<<<< WRITE THIS PART NOW' : ''} — ${s.purpose}`).join('\n'),
        '',
        `===== PART ${index + 1}/${total} TO WRITE: ${sec.heading_vi} (${sec.heading}) =====`,
        `Purpose of this part: ${sec.purpose}`,
        sec.key_points.length ? 'It MUST cover:\n' + sec.key_points.map(k => '  - ' + k).join('\n') : '',
        '',
        coveredPoints.length
            ? 'ALREADY SAID IN EARLIER PARTS — DO NOT SAY IT AGAIN (a one-clause callback is allowed, repeating the analysis is not):\n' + coveredPoints.map(k => '  - ' + k).join('\n')
            : 'Nothing has been written yet — this is the very beginning of the video.',
        '',
        prevTail
            ? 'THE SCRIPT SO FAR ENDS EXACTLY LIKE THIS — your first paragraph must read as the next breath after it:\n"""\n' + prevTail + '\n"""'
            : '',
        '',
        '===== CONTINUITY RULES (MANDATORY) =====',
        isFirst
            ? '- This is the OPENING: hook the viewer in the first paragraph and frame the topic. Do NOT summarise what the video will cover part by part, and do NOT conclude.'
            : '- Do NOT greet the viewer, do NOT re-introduce the teams/topic, do NOT say things like "in this video" or "as we said". Continue mid-flow from the text above.',
        isLast
            ? '- This is the FINAL part: land the analysis with a clear verdict/prediction and a natural sign-off.'
            : '- Do NOT conclude, do NOT sign off, do NOT write a summary of the whole video — the script continues after this part.',
        '- Keep the same narrator voice, tense and formality as the text above; the viewer must not feel a seam.',
        '- Bring NEW material: new data, deeper analysis, different angle. Never restate an earlier part in new words.',
        `- Respect the word budget (~${sec.target_words} words). Going far over eats the next part's material.`,
        '- Return ONLY this part\'s paragraphs in "sentences" (with image_suggestions and units as usual). No title, no headings inside the text.',
    ].filter(Boolean).join('\n');
}

// Viết (và nếu cần: chấm + viết lại) 1 phần. Trả { sentences, evals } — evals để dựng lịch sử chấm điểm.
async function writeSection({ prompt, targetLang, outline, index, coveredPoints, prevTail, projectId }) {
    const sec = outline.sections[index];
    const total = outline.sections.length;
    const baseInput = buildSectionInput({ prompt, targetLang, outline, index, coveredPoints, prevTail });
    // Kèm tiến độ vào status ("scripting:3/8") — bài dài chạy 15-40 phút, không có số phần thì
    // trên dashboard chỉ thấy "đang viết kịch bản" đứng im, không biết còn sống hay treo.
    const prog = `:${index + 1}/${total}`;

    await setSportsStatus(projectId, 'scripting' + prog);
    console.log(`[GPT-5:part] ✍️  Viết phần ${index + 1}/${total}: ${sec.heading_vi} (~${sec.target_words} từ)`);
    const first = await callGpt5Json(baseInput, SECTION_SCHEMA, 'sports_section', `GPT-5:part${index + 1}`, { effort: SECTION_EFFORT });
    let sentences = cleanSentences(first.sentences);
    if (!sentences.length) throw new Error(`phần ${index + 1} trả về rỗng`);

    const evals = [];
    if (REWRITE_SCORE_THRESHOLD <= 0 || SECTION_REWRITE_MAX <= 0) {
        logSection(index, total, sentences);
        return { sentences, evals };
    }

    // Chấm + viết lại NGAY phần này, TRƯỚC khi viết phần sau: phần sau nối vào đuôi của bản đã tốt,
    // chứ sửa sau thì đuôi đổi mà phần sau vẫn nối theo bản cũ -> gãy mạch.
    let scoreObj = await scoreArticleWithGPT({ sentences }, sectionScoreOpts(sec, index, total));
    if (scoreObj) evals.push({ stage: 'section', section: index + 1, heading: sec.heading_vi, score: scoreObj.score, reason: scoreObj.reason, detail: scoreObj.detail, at: new Date().toISOString(), used: true });

    for (let attempt = 1; scoreObj && scoreObj.score < REWRITE_SCORE_THRESHOLD && attempt <= SECTION_REWRITE_MAX; attempt++) {
        await setSportsStatus(projectId, 'rewriting' + prog);
        console.log(`[GPT-5:part] ✍️  Viết lại phần ${index + 1} lần ${attempt} — điểm ${scoreObj.score} < ${REWRITE_SCORE_THRESHOLD}`);
        let redone = null;
        try {
            const rewriteInput = [
                baseInput,
                '',
                '===== THIS ROUND: REWRITE THIS PART =====',
                `Your draft of this part scored ${scoreObj.score}/100 — below the pass mark (${REWRITE_SCORE_THRESHOLD}). Rewrite THIS PART ONLY, as high-quality as you can.`,
                '- Fix EVERY weakness and apply EVERY suggestion below; keep the listed strengths.',
                '- Same part, same purpose, same key points, same word budget, same continuity rules as above.',
                '- Use web search again to verify facts and add concrete, checkable data. Never invent statistics.',
                '',
                '===== EDITOR REVIEW (Vietnamese — address all of it) =====',
                formatEvaluation(scoreObj),
                '',
                '===== YOUR PREVIOUS DRAFT OF THIS PART (units stripped) =====',
                JSON.stringify(sentences.map(s => ({ vi: s.vi, target: s.target }))),
            ].join('\n');
            const r = await callGpt5Json(rewriteInput, SECTION_SCHEMA, 'sports_section', `GPT-5:part${index + 1}:rewrite`, { effort: SECTION_EFFORT });
            const cleaned = cleanSentences(r.sentences);
            if (cleaned.length) redone = cleaned;
        } catch (e) { console.warn(`[GPT-5:part] viết lại phần ${index + 1} lỗi:`, e.message); }
        if (!redone) break;

        const reScore = await scoreArticleWithGPT({ sentences: redone }, sectionScoreOpts(sec, index, total));
        const better = !!reScore && reScore.score > scoreObj.score;
        evals.push({ stage: 'section_rewrite', section: index + 1, heading: sec.heading_vi, attempt, score: reScore ? reScore.score : null, reason: reScore ? reScore.reason : 'không chấm lại được', detail: reScore ? reScore.detail : null, at: new Date().toISOString(), used: better });
        if (better) {
            console.log(`[GPT-5:part] ✅ Nhận bản viết lại phần ${index + 1}: ${scoreObj.score} -> ${reScore.score}/100`);
            for (const e of evals) if (e.section === index + 1) e.used = false;
            evals[evals.length - 1].used = true;
            sentences = redone;
            scoreObj = reScore;
        } else {
            console.log(`[GPT-5:part] ↩️  Bản viết lại phần ${index + 1} không tốt hơn (${reScore ? reScore.score : '?'}) -> giữ bản cũ`);
        }
    }
    logSection(index, total, sentences);
    return { sentences, evals };
}

// Tiêu chí chấm cho 1 PHẦN: đừng trừ điểm vì thiếu mở bài/kết bài — phần giữa vốn không có.
function sectionScoreOpts(sec, index, total) {
    const isFirst = index === 0, isLast = index === total - 1;
    return {
        lengthCriterion: `khoảng ${sec.target_words} từ cho phần này, mỗi đoạn 3-5 câu, mạch lạc` + (isLast ? ', có nhận định/dự đoán ở cuối' : ''),
        contextNote: `Đây là PHẦN ${index + 1}/${total} ("${sec.heading_vi}") của một kịch bản DÀI, không phải bài hoàn chỉnh. `
            + (isFirst ? 'Phần này mở đầu video nên PHẢI có hook, nhưng KHÔNG được có kết luận.'
                : isLast ? 'Phần này kết video nên PHẢI có nhận định/dự đoán, và KHÔNG được chào hỏi lại từ đầu.'
                    : 'Phần này nằm GIỮA video: KHÔNG được có lời chào/mở bài, cũng KHÔNG được có kết luận — đừng trừ điểm vì thiếu chúng.')
            + ` Nhiệm vụ của phần: ${sec.purpose}`,
    };
}

function logSection(index, total, sentences) {
    const words = sentences.map(s => s.vi || '').join(' ').split(/\s+/).filter(Boolean).length;
    console.log(`[GPT-5:part] === PHẦN ${index + 1}/${total}: ${sentences.length} đoạn / ${words} từ ===`);
    sentences.forEach((s, i) => console.log(`   [${i + 1}] (${s.units.length} câu) ${(s.vi || '').slice(0, 110)}...`));
}

// Toàn bộ luồng bài dài: dàn ý -> viết tuần tự từng phần -> ghép.
// Trả { title, title_vi, sentences, scoreObj, history } giống hệt luồng ngắn để phần lưu DB dùng chung.
async function generateLongArticle(prompt, targetLang, minutes, projectId) {
    const plan = { minutes, ...planLongArticle(minutes) };
    console.log(`[sports_srt] 📐 Bài dài ${minutes} phút -> ~${plan.targetWords} từ, chia ${plan.sectionCount} phần (~${plan.wordsPerSection} từ/phần).`);

    await setSportsStatus(projectId, 'outlining');
    const outline = await generateOutline(prompt, targetLang, plan);

    const sentences = [];
    const history = [];
    const coveredPoints = [];
    let prevTail = '';
    let failed = 0;

    for (let i = 0; i < outline.sections.length; i++) {
        const sec = outline.sections[i];
        let part = null;
        // 1 phần hỏng thì thử lại 1 lần; vẫn hỏng thì BỎ QUA phần đó và đi tiếp — mất 1 phần
        // vẫn hơn là vứt cả bài đã viết được 8 phần trước đó.
        for (let attempt = 1; attempt <= 2 && !part; attempt++) {
            try {
                part = await writeSection({ prompt, targetLang, outline, index: i, coveredPoints, prevTail, projectId });
            } catch (e) {
                console.warn(`[sports_srt] ⚠️ Phần ${i + 1} lỗi (lần ${attempt}/2): ${e.message}`);
                if (attempt === 2) failed++;
            }
        }
        if (!part) continue;
        sentences.push(...part.sentences);
        history.push(...part.evals);
        // Nối tiếp: ý của phần này thành "đã nói" cho các phần sau, đuôi phần này thành mồi cho phần kế.
        coveredPoints.push(`[${sec.heading_vi}] ` + (sec.key_points.join('; ') || sec.purpose));
        prevTail = tailOf(part.sentences);
    }

    if (!sentences.length) throw new Error('Không viết được phần nào của bài dài');
    if (failed) console.warn(`[sports_srt] ⚠️ ${failed}/${outline.sections.length} phần thất bại -> bài ngắn hơn dự kiến.`);

    const words = sentences.map(s => s.vi || '').join(' ').split(/\s+/).filter(Boolean).length;
    console.log(`[sports_srt] 📝 Bài dài xong: ${sentences.length} đoạn / ${words} từ (~${Math.round(words / WORDS_PER_MINUTE)} phút đọc).`);

    // Điểm tổng = trung bình điểm BẢN ĐANG DÙNG của từng phần (bản viết lại thắng thì lấy điểm bản đó).
    const used = history.filter(h => h.used && Number.isFinite(h.score));
    const scoreObj = used.length
        ? {
            score: Math.round(used.reduce((n, h) => n + h.score, 0) / used.length),
            reason: `Trung bình ${used.length} phần của bài dài ${minutes} phút (${sentences.length} đoạn / ${words} từ)`,
            detail: { criteria: [], strengths: [], weaknesses: [], suggestions: used.map(h => `Phần ${h.section} — ${h.heading}: ${h.score}/100. ${h.reason || ''}`) },
        }
        : null;
    return { title: outline.title || '', title_vi: outline.title_vi || '', sentences, scoreObj, history };
}

// Ghép bài thành text thuần để chấm điểm / đưa lại cho GPT khi viết lại.
// Dùng bản TIẾNG VIỆT: đó là bản model nghĩ ra trước (bản target chỉ là bản song ngữ đi kèm),
// và nhận xét trả về cũng bằng tiếng Việt cho biên tập đọc.
function articleToText(article) {
    const paras = (article.sentences || []).map(s => (s.vi || '').trim()).filter(Boolean);
    const words = paras.join(' ').split(/\s+/).filter(Boolean).length;
    return { paras, words, text: [article.title_vi || article.title || '', ...paras].join('\n\n') };
}

// Chấm CHẤT LƯỢNG bài phân tích thể thao (0-100).
// Trả { score, reason, detail } hoặc null nếu lỗi — chấm điểm hỏng KHÔNG được chặn pipeline.
// opts (chỉ dùng cho bài dài): lengthCriterion đổi chỉ tiêu độ dài ở tiêu chí 5, contextNote nói rõ
// đây chỉ là 1 PHẦN của kịch bản để giám khảo không trừ điểm vì thiếu mở bài/kết bài.
async function scoreArticleWithGPT(article, opts = {}) {
    try {
        const { paras, words, text } = articleToText(article);
        if (!text.trim() || !paras.length) return null;
        const sys = [
            'Bạn là biên tập viên trưởng của kênh YouTube phân tích bóng đá, rất khó tính. Chấm CHẤT LƯỢNG bài phân tích theo 5 TIÊU CHÍ, mỗi tiêu chí 0-20 điểm (tổng 100):',
            '1. Chiều sâu chuyên môn (chiến thuật, sơ đồ, phong độ, đối đầu, nhân sự — có phân tích thật hay chỉ nói chung chung)',
            '2. Độ cụ thể & đáng tin của dữ liệu (tên cầu thủ/HLV, tỉ số, số liệu, mốc thời gian chính xác; không bịa, không mơ hồ kiểu "gần đây họ chơi tốt")',
            '3. Độ cuốn hút & giữ chân người xem (mở bài hút, nhịp lên xuống, có cao trào, không lê thê)',
            '4. Văn phong bình luận thể thao tự nhiên (giọng người bình luận thật, không lộ AI, không lặp ý, không sáo rỗng)',
            `5. Cấu trúc & độ dài (${opts.lengthCriterion || 'đủ 2400-3500 từ, mỗi đoạn 3-5 câu, mạch lạc, có nhận định/dự đoán ở cuối'})`,
            opts.contextNote ? 'BỐI CẢNH BẮT BUỘC LƯU Ý KHI CHẤM: ' + opts.contextNote : '',
            'Nghiêm khắc, phân bổ điểm thực tế (trung bình 60-75, xuất sắc 85+). Điểm tổng = tổng 5 tiêu chí.',
            'Chấm theo ĐÚNG bài này, không dùng nhận xét khuôn mẫu: "reason" và các "comment" phải nêu chi tiết CÓ THẬT trong bài (tên cầu thủ, số liệu, câu cụ thể). Hai bài khác nhau thì nhận xét phải khác nhau.',
            'Nhận xét bằng TIẾNG VIỆT, cụ thể, trích ví dụ có thật trong bài.',
            'criteria phải có ĐỦ 5 mục theo ĐÚNG thứ tự các tiêu chí trên.',
        ].filter(Boolean).join('\n');
        const j = await callGpt5Json(
            `${sys}\n\n===== BÀI CẦN CHẤM =====\nSỐ ĐOẠN: ${paras.length} — SỐ TỪ (bản tiếng Việt): ${words}\n\n${text.slice(0, 30000)}`,
            SCORE_SCHEMA, 'sports_score', 'GPT:score',
            // Giám khảo phải NGANG CẤP với model viết bài — gpt-4o-mini chấm bài gpt-5 thì trả về
            // điểm gần như cố định (đo thực tế: bản đầu và bản viết lại đều 72, nhận xét giống từng chữ),
            // khiến vòng "chấm -> viết lại -> chấm lại" không có tín hiệu nào để bám.
            // Không bật web_search: giám khảo chấm chất lượng viết, không đi xác minh lại dữ liệu (rất chậm).
            { model: SCORE_MODEL, effort: SCORE_EFFORT, webSearch: false }
        );
        let score = Math.round(Number(j.score));
        if (!Number.isFinite(score)) return null;
        score = Math.max(0, Math.min(100, score));
        const detail = {
            criteria: Array.isArray(j.criteria) ? j.criteria.map(c => ({ name: String(c.name || ''), score: Math.max(0, Math.min(20, Math.round(Number(c.score) || 0))), comment: String(c.comment || '') })) : [],
            strengths: Array.isArray(j.strengths) ? j.strengths.map(String) : [],
            weaknesses: Array.isArray(j.weaknesses) ? j.weaknesses.map(String) : [],
            suggestions: Array.isArray(j.suggestions) ? j.suggestions.map(String) : [],
        };
        console.log(`[sports_srt] 📊 Điểm nội dung: ${score}/100 (${paras.length} đoạn, ${words} từ) — ${j.reason || ''}`);
        return { score, reason: String(j.reason || ''), detail };
    } catch (e) { console.warn('[sports_srt] chấm điểm lỗi:', e.message); return null; }
}

// Đánh giá -> văn bản để GPT biết phải sửa gì.
function formatEvaluation(scoreObj) {
    const d = scoreObj.detail || {};
    const list = (title, arr) => (arr || []).length ? [title, ...arr.map(s => '- ' + s)].join('\n') : '';
    return [
        `ĐIỂM HIỆN TẠI: ${scoreObj.score}/100 — ${scoreObj.reason || ''}`,
        (d.criteria || []).length ? 'CHI TIẾT TỪNG TIÊU CHÍ:\n' + d.criteria.map(c => `- ${c.name}: ${c.score}/20 — ${c.comment}`).join('\n') : '',
        list('ĐIỂM MẠNH (BẮT BUỘC GIỮ LẠI, KHÔNG ĐƯỢC LÀM YẾU ĐI):', d.strengths),
        list('ĐIỂM YẾU (BẮT BUỘC SỬA TRIỆT ĐỂ):', d.weaknesses),
        list('GỢI Ý CẢI THIỆN (BẮT BUỘC ÁP DỤNG):', d.suggestions),
    ].filter(Boolean).join('\n\n');
}

// Viết lại TOÀN BỘ bài khi điểm dưới ngưỡng: đưa yêu cầu gốc + bản cũ + toàn bộ đánh giá cho GPT-5.
// Trả bài mới hoặc null nếu lỗi (giữ bản cũ).
async function rewriteArticleWithGPT(promptText, article, scoreObj, targetLang) {
    try {
        const { paras, words } = articleToText(article);
        // Bỏ units/image_suggestions khỏi bản cũ: bản viết lại sinh lại hết, giữ chúng chỉ làm
        // input phình gấp đôi (units lặp lại nguyên nội dung đoạn) và dễ chạm trần token.
        const draft = JSON.stringify({
            title: article.title, title_vi: article.title_vi,
            sentences: (article.sentences || []).map(s => ({ vi: s.vi, target: s.target })),
        });
        const input = [
            buildSystemPrompt(targetLang),
            '',
            '===== THIS ROUND: REWRITE THE WHOLE ARTICLE =====',
            `The draft below was scored ${scoreObj.score}/100 by the editor — BELOW the pass mark (${REWRITE_SCORE_THRESHOLD}). Rewrite it completely to score as high as possible.`,
            '- Keep the same topic, match, teams and players as the original request; do NOT switch subject.',
            '- Fix EVERY weakness and apply EVERY suggestion below; keep the listed strengths intact.',
            '- Use web search again to verify facts and add concrete, checkable data. NEVER invent statistics, scores or transfers.',
            `- Current draft: ${paras.length} paragraphs / ${words} Vietnamese words. Obey the 2400-3500 word target above.`,
            '- Follow ALL the rules above again: same JSON schema, both languages, image_suggestions, and the "units" split. No citations, no URLs.',
            '',
            '===== ORIGINAL REQUEST =====',
            promptText,
            '',
            '===== EDITOR REVIEW (in Vietnamese — address all of it) =====',
            formatEvaluation(scoreObj),
            '',
            '===== OLD DRAFT (JSON, units stripped) =====',
            draft,
        ].join('\n');

        console.log('[sports_srt] ✍️  Gọi GPT-5 viết lại bài...');
        const rewritten = await callSportsGpt(input, 'GPT-5:rewrite');
        if (!(rewritten.sentences || []).length) {
            console.warn('[sports_srt] ⚠ bản viết lại rỗng đoạn -> bỏ, giữ bản cũ');
            return null;
        }
        return rewritten;
    } catch (e) { console.warn('[sports_srt] viết lại lỗi:', e.message); return null; }
}

// Chấm điểm -> dưới ngưỡng thì viết lại, LẶP tới khi đạt (hoặc hết số lần). Luôn giữ bản điểm CAO NHẤT.
// Trả { article, scoreObj, history } — history để dashboard so sánh từng bản.
async function scoreAndRewrite(promptText, article, targetLang, projectId) {
    const history = [];
    if (REWRITE_SCORE_THRESHOLD <= 0) return { article, scoreObj: null, history };

    let scoreObj = await scoreArticleWithGPT(article);
    if (scoreObj) history.push({ stage: 'initial', score: scoreObj.score, reason: scoreObj.reason, detail: scoreObj.detail, at: new Date().toISOString(), used: true });

    let attempt = 0;
    while (scoreObj && scoreObj.score < REWRITE_SCORE_THRESHOLD && attempt < REWRITE_MAX_ATTEMPTS) {
        attempt++;
        await setSportsStatus(projectId, 'rewriting');
        console.log(`[sports_srt] ✍️  Viết lại lần ${attempt}/${REWRITE_MAX_ATTEMPTS} — điểm ${scoreObj.score} < ${REWRITE_SCORE_THRESHOLD}...`);
        const rewritten = await rewriteArticleWithGPT(promptText, article, scoreObj, targetLang);
        if (!rewritten) { console.warn('[sports_srt] viết lại thất bại → dừng vòng, giữ bản tốt nhất'); break; }
        const reScore = await scoreArticleWithGPT(rewritten);
        // Không chấm lại được thì coi như không tốt hơn — thà giữ bản đã biết điểm.
        const better = !!reScore && reScore.score > scoreObj.score;
        history.push({ stage: 'rewrite', attempt, score: reScore ? reScore.score : null, reason: reScore ? reScore.reason : 'không chấm lại được', detail: reScore ? reScore.detail : null, at: new Date().toISOString(), used: better });
        if (better) {
            console.log(`[sports_srt] ✅ Nhận bản viết lại lần ${attempt}: điểm ${scoreObj.score} -> ${reScore.score}/100`);
            for (const h of history) h.used = false;   // bản này thắng → các bản trước không dùng
            history[history.length - 1].used = true;
            article = rewritten;
            scoreObj = reScore;
        } else {
            console.log(`[sports_srt] ↩️  Bản viết lại lần ${attempt} không tốt hơn (điểm ${reScore ? reScore.score : '?'}) -> giữ bản cũ, thử lại`);
        }
    }
    if (scoreObj && scoreObj.score < REWRITE_SCORE_THRESHOLD) {
        console.log(`[sports_srt] ⚠️  Vẫn dưới ngưỡng sau ${attempt} lần viết lại (điểm ${scoreObj.score}/${REWRITE_SCORE_THRESHOLD}) → dùng bản tốt nhất.`);
    }
    return { article, scoreObj, history };
}

// "00:01:02,500" (hoặc dấu chấm) -> giây. Sai định dạng -> null.
function tcToSec(tc) {
    const m = String(tc || '').trim().match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

function parseSrt(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = content.trim().split(/\n\n+/);
    const sentences = [];
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;
        const index = parseInt(lines[0]);
        if (isNaN(index)) continue;
        const text = lines.slice(2).join(' ').trim();
        if (text) sentences.push({ index, timecode: lines[1], text });
    }
    return sentences;
}

// ===================== DỊCH FILE SRT =====================
// Chỉ upload 1 file SRT + bật option dịch -> tự dịch sang ngôn ngữ đích và XUẤT RA file .srt đã dịch
// (giữ nguyên số thứ tự + timecode gốc, chỉ thay dòng chữ).
const TRANSLATE_MODEL = process.env.SPORTS_TRANSLATE_MODEL || 'gpt-5';
const TRANSLATE_EFFORT = ['low', 'medium', 'high'].includes(process.env.SPORTS_TRANSLATE_EFFORT) ? process.env.SPORTS_TRANSLATE_EFFORT : 'medium';
// Dịch theo LÔ để giữ ngữ cảnh giữa các dòng liền kề (dịch lẻ từng dòng thì mất mạch, sai đại từ).
// Lô quá to thì dễ lệch số dòng và chạm trần token -> 30 là mức an toàn đã cân nhắc.
const TRANSLATE_CHUNK = Math.max(5, parseInt(process.env.SPORTS_TRANSLATE_CHUNK, 10) || 30);

const TRANSLATION_SCHEMA = {
    type: 'object',
    properties: { translations: { type: 'array', items: { type: 'string' } } },
    required: ['translations'],
    additionalProperties: false,
};

// Dịch 1 lô dòng phụ đề. Trả mảng ĐÚNG bằng số dòng đưa vào, hoặc null nếu lệch.
// Lệch số dòng là hỏng nặng: dòng dịch sẽ gán sang timecode của câu khác -> thà trả null để bên gọi xử lý.
async function translateChunk(lines, targetLang, glossaryText, tag) {
    const langName = langNameOf(targetLang);
    const input = [
        `You are a professional subtitle translator for football/sports content. Translate each numbered subtitle line into ${langName}.`,
        '',
        'HARD RULES:',
        `1. Return EXACTLY ${lines.length} strings in "translations", in the SAME ORDER as the input. One output string per input line — never merge, split, drop or reorder lines.`,
        '2. Translate line by line, but read the whole block first so pronouns, tense and terminology stay consistent across lines.',
        '3. Keep it natural spoken ' + langName + ' as a commentator would say it — not literal word-for-word.',
        '4. Keep player names, club names, competition names and numbers exactly right. Do not invent or drop facts.',
        '5. Keep each line roughly the same length as the source (it is a subtitle cue that must be read in the same time).',
        '6. No quotes around the output, no line numbers, no notes, no explanation — only the translated sentence itself.',
        '7. If a line is already in ' + langName + ', return it unchanged.',
        glossaryText ? `\n===== GLOSSARY: dùng ĐÚNG thuật ngữ ${langName} trong bảng này khi gặp khái niệm tương ứng =====\n${glossaryText}` : '',
        '',
        '===== SUBTITLE LINES =====',
        lines.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    ].filter(Boolean).join('\n');

    const r = await callGpt5Json(input, TRANSLATION_SCHEMA, 'srt_translation', tag,
        { model: TRANSLATE_MODEL, effort: TRANSLATE_EFFORT, webSearch: false });
    const out = Array.isArray(r.translations) ? r.translations.map(s => String(s || '').replace(/\s+/g, ' ').trim()) : [];
    return out.length === lines.length && out.every(Boolean) ? out : null;
}

// Dịch cả file. Trả { translations, failed } — failed = số dòng phải giữ nguyên câu gốc.
//
// Phân biệt HAI kiểu hỏng, vì cách chữa ngược nhau:
//   • LỆCH SỐ DÒNG (model trả thiếu/thừa) -> thử lại 1 lần, vẫn lệch thì CHIA ĐÔI lô: lô nhỏ dễ khớp hơn.
//   • LỖI API (5xx/mạng) -> callGpt5Json đã tự thử lại 3 lần kèm backoff rồi. Chia đôi hay thử lại nữa
//     chỉ nhân số lượt gọi theo cấp số nhân (đo thực tế: 3 dòng mà bắn hơn 40 lượt, chạy không dứt).
//     Nên bỏ lô đó NGAY, và nếu hỏng liên tiếp thì dừng hẳn — API đang chết, cố thêm vô nghĩa.
const TRANSLATE_MAX_API_FAILS = 3;

async function translateSrtTexts(texts, targetLang, projectId) {
    const glossary = readContentPrompt('thuatngu_bongda', targetLang);
    if (glossary.text) console.log(`[dịch SRT] Dùng glossary: ${glossary.file}`);
    const out = new Array(texts.length);
    let done = 0, failed = 0, apiFails = 0, calls = 0;
    // Trần tổng số lượt gọi. Chia đôi khi lệch số dòng là đúng, nhưng model lệch DAI DẲNG thì cây
    // chia đôi bung ra rất nhanh (đo: 90 dòng -> 180 lượt). Mức 6× số lô là rộng rãi cho vài lần
    // chia đôi bình thường, nhưng chặn được trường hợp bệnh lý.
    const callBudget = Math.ceil(texts.length / TRANSLATE_CHUNK) * 6 + 5;

    const keepSource = (start, end, why) => {
        for (let i = start; i < end; i++) { out[i] = texts[i]; failed++; }
        console.warn(`[dịch SRT] ❌ giữ nguyên câu gốc cho dòng ${start + 1}-${end} (${why})`);
    };

    const run = async (start, end, depth) => {
        const lines = texts.slice(start, end);
        if (!lines.length) return;
        const tag = `dịch ${start + 1}-${end}`;
        if (calls >= callBudget) { keepSource(start, end, 'hết trần số lượt gọi'); return; }
        for (let attempt = 1; attempt <= 2; attempt++) {
            let got;
            try {
                calls++;
                got = await translateChunk(lines, targetLang, glossary.text, tag);
            } catch (e) {
                apiFails++;
                console.warn(`[dịch SRT] ⚠️ lô ${tag} lỗi API: ${e.message}`);
                keepSource(start, end, 'lỗi API');
                return;
            }
            if (got) {
                for (let i = 0; i < got.length; i++) out[start + i] = got[i];
                done += got.length;
                console.log(`[dịch SRT] ✅ ${done}/${texts.length} dòng`);
                await setSportsStatus(projectId, `translating:${done}/${texts.length}`);
                return;
            }
            console.warn(`[dịch SRT] ⚠️ lô ${tag} trả lệch số dòng (lần ${attempt}/2)`);
        }
        // Chỉ tới đây khi LỆCH SỐ DÒNG — lúc này chia đôi mới thực sự có ích.
        if (lines.length > 1 && depth < 4) {
            const mid = start + Math.floor(lines.length / 2);
            await run(start, mid, depth + 1);
            await run(mid, end, depth + 1);
            return;
        }
        keepSource(start, end, 'lệch số dòng');
    };

    for (let i = 0; i < texts.length; i += TRANSLATE_CHUNK) {
        if (apiFails >= TRANSLATE_MAX_API_FAILS) {
            console.error(`[dịch SRT] ❌ API hỏng ${apiFails} lô liên tiếp → DỪNG dịch, phần còn lại giữ nguyên câu gốc.`);
            keepSource(i, texts.length, 'đã dừng vì API hỏng');
            break;
        }
        await run(i, Math.min(i + TRANSLATE_CHUNK, texts.length), 0);
    }
    if (failed) console.warn(`[dịch SRT] ⚠️ ${failed}/${texts.length} dòng không dịch được, giữ nguyên bản gốc.`);
    return { translations: out.map((t, i) => t || texts[i]), failed };
}

// Dựng lại file .srt: giữ NGUYÊN số thứ tự và timecode gốc, chỉ thay dòng chữ.
function buildSrtFile(cues, texts) {
    return cues.map((c, i) => `${c.index}\n${c.timecode}\n${(texts[i] || c.text).trim()}\n`).join('\n');
}

async function getKeywordsFromGPT(sentence) {
    const res = await Promise.race([
        httpsPost(
            'https://api.openai.com/v1/chat/completions',
            { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
            {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a sports image search expert for Japanese Bing image search. Given a Vietnamese sports commentary sentence, return Japanese search queries optimized for Bing Images Japan. Rules: 1) Each query MUST be in Japanese (日本語). 2) Return as many queries as needed to fully cover the meaning of the sentence - typically 4 to 7 queries for normal sentences, but if the sentence contains many distinct subjects (multiple players, teams, events, historical moments), return as many as needed with no upper limit. For very simple sentences with one subject, return as few as 2. 3) Be SPECIFIC: include exact player names (in Japanese), team names, tournament names, and year if mentioned. 4) Each query should target a different visual subject in the sentence. 5) Avoid generic or overlapping queries. 6) Use Japanese sports terminology naturally used by Japanese media. 7) Return ONLY a raw JSON array of strings, no explanation.'
                    },
                    { role: 'user', content: sentence }
                ],
                temperature: 0.3
            }
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
    ]);
    if (res.status !== 200) throw new Error(`GPT lỗi: ${res.status}`);
    const data = JSON.parse(res.body);
    let content = data.choices?.[0]?.message?.content || '[]';
    console.log(`    [DEBUG] GPT raw response (status=${res.status}): ${content.slice(0, 200)}`);
    if (data.error) console.log(`    [DEBUG] GPT error: ${JSON.stringify(data.error)}`);
    // Strip markdown code block nếu có
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
        const val = Object.values(parsed)[0];
        return Array.isArray(val) ? val.filter(Boolean) : [];
    } catch {
        const match = content.match(/\[.*?\]/s);
        if (match) try { return JSON.parse(match[0]).filter(Boolean); } catch(_) {}
        return [];
    }
}

async function main() {
    // Cờ --minutes tách ra TRƯỚC khi đọc tham số vị trí (server luôn đẩy cờ xuống cuối lệnh,
    // nên process.argv[3] vẫn là projectId cho nhánh dọn ghost project ở catch bên dưới).
    const argv = process.argv.slice(2);
    const args = [];
    let minutes = 0;
    let wantTranslate = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--minutes') { minutes = parseInt(argv[++i], 10) || 0; continue; }
        if (argv[i] === '--translate') { wantTranslate = true; continue; }
        args.push(argv[i]);
    }
    const isPromptMode = args[0] === '--prompt';
    const projectId = isPromptMode ? args[1] : args[1];
    const targetLang = isPromptMode ? (args[3] || 'vi') : (args[3] || 'vi');

    if (!projectId) {
        console.error('Usage: node sports_srt.js <file.srt> <projectId> [file_translated.srt] [targetLang]');
        console.error('       node sports_srt.js --prompt <projectId> <promptText> [targetLang] [--minutes 30]');
        process.exit(1);
    }
    teeLogToProject(projectId);

    let rawSentences; // [{ index, text }]
    let postTitle = '';
    let postTitleVi = '';
    let scoreObj = null;        // { score, reason, detail } — chỉ có ở chế độ --prompt
    let scoreHistory = [];      // bản đầu + từng bản viết lại (để so sánh trên dashboard)

    if (isPromptMode) {
        const promptText = args[2];
        // Hiện dự án lên dashboard NGAY (kèm nhãn "đang viết kịch bản") — khâu GPT-5 dưới đây rất dài.
        await setSportsStatus(projectId, 'scripting', { title: projectId });
        let result;
        if (minutes >= LONG_MIN_MINUTES) {
            // BÀI DÀI: 1 lượt không đủ context -> lên dàn ý rồi viết nối tiếp từng phần.
            // Chấm + viết lại đã làm ngay trong từng phần nên KHÔNG chạy scoreAndRewrite (viết lại
            // cả bài 10.000 từ trong 1 lượt là chắc chắn chạm trần token, mất trắng).
            console.log(`[sports_srt] Prompt mode (BÀI DÀI ${minutes} phút): dàn ý -> viết từng phần...`);
            const long = await generateLongArticle(promptText, targetLang, minutes, projectId);
            result = { title: long.title, title_vi: long.title_vi, sentences: long.sentences };
            scoreObj = long.scoreObj;
            scoreHistory = long.history;
        } else {
            console.log(`[sports_srt] Prompt mode: generating sentences from GPT...`);
            result = await generateSentencesFromPrompt(promptText, targetLang);
            // Chấm điểm bài, dưới ngưỡng thì bắt GPT viết lại (SRT mode: kịch bản của người dùng, không đụng)
            ({ article: result, scoreObj, history: scoreHistory } = await scoreAndRewrite(promptText, result, targetLang, projectId));
        }
        postTitle = result.title;
        postTitleVi = result.title_vi || result.title;
        rawSentences = result.sentences.map((s, i) => ({ index: i + 1, text: s.target, textVi: s.vi, imageSuggestions: s.image_suggestions || [], units: s.units || [] }));
        const nUnits = rawSentences.reduce((n, s) => n + (s.units.length || 1), 0);
        console.log(`[sports_srt] GPT generated ${rawSentences.length} đoạn / ${nUnits} câu. Title: ${postTitle}`);
    } else {
        const srtPath = args[0];
        const srtTranslatedPath = args[2] || null;
        if (!srtPath) { console.error('Missing srt path'); process.exit(1); }
        const srtSentences = parseSrt(srtPath);
        let translatedSentences = srtTranslatedPath ? parseSrt(srtTranslatedPath) : null;
        console.log(`[sports_srt] Đọc được ${srtSentences.length} câu từ ${srtPath}`);

        // Bật --translate mà KHÔNG kèm file dịch sẵn -> tự dịch rồi ghi ra file .srt đã dịch.
        // Có file dịch sẵn thì tôn trọng file đó, không dịch đè (người dùng đã bỏ công dịch tay).
        if (wantTranslate && !translatedSentences && targetLang !== 'vi') {
            await setSportsStatus(projectId, `translating:0/${srtSentences.length}`, { title: projectId });
            console.log(`[sports_srt] 🌐 Dịch ${srtSentences.length} dòng phụ đề sang '${targetLang}'...`);
            const { translations, failed } = await translateSrtTexts(srtSentences.map(s => s.text), targetLang, projectId);
            if (failed >= srtSentences.length) {
                // Không dịch được dòng nào -> ĐỪNG ghi file "đã dịch" y hệt bản gốc, nhìn là tưởng dịch xong.
                console.error('[sports_srt] ❌ Dịch thất bại hoàn toàn → không ghi input_translated.srt, dùng câu gốc cho cả 2 cột.');
            } else {
                const outPath = path.join(MEDIA_DIR, projectId, 'input_translated.srt');
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, buildSrtFile(srtSentences, translations));
                console.log(`[sports_srt] 💾 Đã ghi file SRT đã dịch: ${outPath}` + (failed ? ` (${failed} dòng giữ nguyên bản gốc)` : ''));
                translatedSentences = srtSentences.map((s, i) => ({ ...s, text: translations[i] }));
            }
        } else if (wantTranslate && targetLang === 'vi') {
            console.log('[sports_srt] Ngôn ngữ đích là tiếng Việt = ngôn ngữ nguồn → bỏ qua bước dịch.');
        }

        rawSentences = srtSentences.map(({ index, text }) => ({
            index,
            text: translatedSentences?.find(s => s.index === index)?.text || text,
            textVi: text
        }));

        // Lưu mốc thời gian gốc (cùng định dạng v2 của podcast) để nút "📄 Tải SRT" xuất lại
        // đúng timeline ban đầu — chế độ SRT của sport là 1 cue = 1 cảnh = 1 câu đọc.
        try {
            fs.writeFileSync(
                path.join(MEDIA_DIR, projectId, 'srt_timing.json'),
                JSON.stringify({
                    source: path.basename(srtPath), lang: targetLang, version: 2,
                    // scene phải khớp Paragraph."order", mà cột đó lấy ĐÚNG số thứ tự trong file SRT
                    // (không phải vị trí i+1) — file đánh số nhảy cóc thì dùng i+1 là tra sai cảnh.
                    cues: srtSentences.map((s) => {
                        const [a, b] = String(s.timecode).split('-->');
                        return { scene: s.index, line: 1, start: tcToSec(a), end: tcToSec(b) };
                    }).filter(c => c.start !== null && c.end !== null),
                }, null, 2)
            );
        } catch (e) { console.warn('[sports_srt] không lưu được srt_timing.json:', e.message); }
    }

    const db = await getDb();
    // genre='sport' → UI v5 lọc dự án theo cột này (menu ⚽ Sport ở sidebar)
    await db.run('INSERT OR IGNORE INTO Post (project_id, title, status, voice_content_type, target_lang, genre) VALUES (?, ?, ?, ?, ?, ?)',
        [projectId, postTitleVi || postTitle || projectId, 'crawling', targetLang === 'vi' ? 'content_vi' : 'content', targetLang, 'sport']);
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;
    // INSERT OR IGNORE không cập nhật post đã tồn tại (chạy lại cùng projectId, hoặc row vừa tạo sớm để
    // hiện dự án lúc đang viết kịch bản — row đó chỉ có project_id + genre) → set lại đủ các cột ở đây.
    await db.run("UPDATE Post SET genre = 'sport', status = 'crawling', title = ?, voice_content_type = ?, target_lang = ? WHERE id = ?",
        [postTitleVi || postTitle || projectId, targetLang === 'vi' ? 'content_vi' : 'content', targetLang, postId]);
    // Điểm nội dung (chỉ chế độ --prompt). ALTER tự vá cho DB cũ chưa có cột — dashboard đọc 4 cột này để hiện ⭐.
    if (scoreObj) {
        for (const col of ['content_score INTEGER', 'content_score_reason TEXT', 'content_score_detail TEXT', 'content_score_history TEXT']) {
            await db.run(`ALTER TABLE Post ADD COLUMN ${col} DEFAULT NULL`).catch(() => {});
        }
        await db.run(
            'UPDATE Post SET content_score = ?, content_score_reason = ?, content_score_detail = ?, content_score_history = ? WHERE id = ?',
            [scoreObj.score, scoreObj.reason || null, JSON.stringify(scoreObj.detail || {}), scoreHistory.length ? JSON.stringify(scoreHistory) : null, postId]
        );
    }

    // Bước 1: Lưu toàn bộ paragraph vào DB trước.
    // Paragraph = 1 cảnh (giữ chung bộ ảnh đã cào). ParagraphDetail = TỪNG CÂU ĐỌC:
    // mỗi detail là 1 đoạn audio + 1 clip lips riêng, nên cắt nhỏ ở đây = câu ngắn lại
    // mà không phải cào thêm ảnh (ảnh bám theo paragraph, không theo detail).
    const paragraphIds = [];
    let totalUnits = 0;
    for (const { index, text, textVi, imageSuggestions, units } of rawSentences) {
        const contentVi = textVi || text;
        const paraRes = await db.run(
            'INSERT INTO Paragraph (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, text, contentVi, index]
        );
        const paragraphId = paraRes.lastID;
        // GPT không cắt được (hoặc chế độ SRT: dòng phụ đề vốn đã ngắn) → giữ nguyên cả đoạn.
        const details = (units && units.length) ? units : [{ target: text, vi: contentVi }];
        for (const [k, u] of details.entries()) {
            await db.run(
                'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
                [paragraphId, u.target, u.vi, k + 1]
            );
        }
        totalUnits += details.length;
        // Lưu image_suggestions vào Keyword
        for (const sug of (imageSuggestions || [])) {
            if (sug) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, sug, 'image_suggestion']);
        }
        paragraphIds.push({ index, text, textVi: contentVi, paragraphId });
    }
    console.log(`[sports_srt] ✅ Đã lưu ${rawSentences.length} đoạn / ${totalUnits} câu vào DB`);
    // Kịch bản đã xong, sang khâu cào ảnh: đổi nhãn trên dashboard + đẩy tên bài thật (đang là mã dự án).
    await setSportsStatus(projectId, 'crawling', { title: postTitleVi || postTitle || projectId });

    // Bước 2: Crawl ảnh cho từng câu
    for (const { index, text, paragraphId } of paragraphIds) {
        // Luôn đọc content_vi từ DB để đảm bảo dùng tiếng Việt
        const paraRow = await db.get('SELECT content_vi FROM Paragraph WHERE id=?', [paragraphId]);
        const textVi = paraRow?.content_vi || text;
        console.log(`\n[${index}/${rawSentences.length}] "${text.slice(0, 60)}..."`);

        // Sinh image_suggestion chỉ khi chưa có (SRT mode không có GPT-5 suggestions)
        const existingSugs = await db.get("SELECT COUNT(*) as c FROM Keyword WHERE paragraph_id=? AND type='image_suggestion'", [paragraphId]);
        if (existingSugs.c === 0) {
            try {
                const sugRes = await httpsPost(
                    'https://api.openai.com/v1/chat/completions',
                    { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
                    {
                        model: 'gpt-4o-mini',
                        messages: [
                            { role: 'system', content: 'You are a sports image suggestion expert. Read the given sports text and return a JSON array of Vietnamese search terms describing images that would illustrate the paragraph. Example: ["logo đội tuyển Nhật Bản", "Moriyasu huấn luyện viên", "World Cup 2026"]. Return ONLY a JSON array, no explanation.' },
                            { role: 'user', content: textVi || text }
                        ],
                        temperature: 0.3
                    }
                );
                if (sugRes.status === 200) {
                    const sugData = JSON.parse(sugRes.body);
                    const raw = sugData.choices?.[0]?.message?.content || '[]';
                    let sugs = [];
                    try { sugs = JSON.parse(raw); } catch(_) {
                        const m = raw.match(/\[.*\]/s);
                        if (m) try { sugs = JSON.parse(m[0]); } catch(_) {}
                    }
                    for (const sug of sugs) {
                        if (sug) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, sug, 'image_suggestion']);
                    }
                    console.log(`    Gợi ý ảnh (${sugs.length}): ${sugs.slice(0,3).join(' | ')}`);
                }
            } catch(e) { console.error(`    Gợi ý ảnh lỗi: ${e.message}`); }
        }

        let keywords = [];
        // Thử tối đa 3 lần nếu GPT trả về [] hoặc timeout
        for (let attempt = 0; attempt < 3 && keywords.length === 0; attempt++) {
            try {
                if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
                const inputText = textVi || text;
                console.log(`    [DEBUG] Gửi GPT (attempt ${attempt+1}): "${inputText.slice(0, 80)}"`);
                keywords = await getKeywordsFromGPT(inputText);
                console.log(`    [DEBUG] GPT raw trả về ${keywords.length} keywords`);
            } catch (e) {
                console.error(`    GPT lỗi (attempt ${attempt+1}): ${e.message}`);
            }
        }
        console.log(`    Keywords (${keywords.length}): ${keywords.join(' | ')}`);

        for (const kw of keywords) {
            await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, kw, 'factual']);
        }

        const imgDir = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', String(index));
        fs.mkdirSync(imgDir, { recursive: true });

        const syncImages = async () => {
            const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
            if (!fs.existsSync(imgDir)) return;
            for (const file of fs.readdirSync(imgDir)) {
                if (!imageExts.has(path.extname(file).toLowerCase())) continue;
                const rel = path.join(projectId, 'assets', '_raw_images', String(index), file);
                const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                if (!exists) await db.run('INSERT INTO Asset (paragraph_id, type, file_path) VALUES (?, ?, ?)', [paragraphId, 'image', rel]);
            }
        };

        const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(0), ms))]);
        // Chạy tuần tự, sync vào DB ngay sau mỗi keyword. Xoay vòng Bing/Google + log theo dự án.
        for (const [i, kw] of keywords.entries()) {
            console.log(`    -> Crawl ảnh: "${kw}"`);
            await withTimeout(
                crawlKeywordImageRotate(kw, imgDir, i, IMAGES_PER_KEYWORD)
                    .then(got => console.log(`    -> Tải được: ${got} ảnh (${kw})`))
                    .catch(e => console.error(`    -> Lỗi crawl: ${e.message}`)),
                60000
            );
            await syncImages(); // sync ngay sau mỗi keyword
        }
    }

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    await setSportsStatus(projectId, null);   // xoá spinner trên dashboard (+ báo Slack như các pipeline khác)
    console.log('\n[sports_srt] ✅ Hoàn thành!');
}

main().catch(async (e) => {
    console.error('[sports_srt] LỖI:', e.message);
    // Dọn "ghost project": row tạo sớm để hiện dự án lúc đang viết kịch bản, nhưng GPT lỗi giữa chừng
    // nên chưa có câu nào → xoá, không để dashboard kẹt 1 dự án rỗng quay mãi.
    // projectId nằm ở argv[3] trong CẢ 2 chế độ: [--prompt, projectId, ...] và [file.srt, projectId, ...].
    const projectId = process.argv[3];
    try {
        const db = await getDb();
        const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
        if (post) {
            const np = await db.get('SELECT COUNT(*) AS n FROM Paragraph WHERE post_id = ?', [post.id]);
            if (!np || !np.n) {
                await db.run('DELETE FROM Post WHERE id = ?', [post.id]);
                console.log('[sports_srt] Đã xoá ghost project rỗng:', projectId);
            } else {
                await db.run('UPDATE Post SET status = NULL WHERE id = ?', [post.id]);   // có nội dung rồi thì giữ, chỉ bỏ spinner
            }
        }
        await db.close();
    } catch (_) {}
    // Chỉ đẩy SSE, KHÔNG dùng setSportsStatus (nó INSERT OR IGNORE → hồi sinh đúng cái ghost vừa xoá).
    // silent: dự án lỗi, không bắn Slack "đã crawl xong".
    await notifyDashboard(projectId, null, true);
    process.exit(1);
});

