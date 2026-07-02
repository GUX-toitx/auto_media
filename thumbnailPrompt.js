// thumbnailPrompt.js — Dùng GPT phỏng theo MẪU style (prompts/thumbnail/style.txt) + nội dung video
// -> sinh MỘT prompt tiếng Anh cho Google Flow: cảnh split-screen kịch tính + 3 dòng tiêu đề xếp chồng
// (vàng / đỏ máu / trắng-trên-banner-đỏ) bằng ngôn ngữ đích, khớp chủ đề video.
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const OPENAI_KEY = process.env.OPENAI_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';

const LANG_NAMES = {
    vi: 'Vietnamese', en: 'English', ja: 'Japanese (日本語)', ko: 'Korean', it: 'Italian',
    es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', ru: 'Russian', zh: 'Chinese',
    id: 'Indonesian', th: 'Thai', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish',
};

function readStyle(lang) {
    for (const dir of [path.join(__dirname, 'prompts', 'thumbnail'), path.join(MEDIA_DIR, 'prompts', 'thumbnail')]) {
        for (const name of [`style.${lang}.txt`, 'style.txt']) {
            const f = path.join(dir, name);
            if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
        }
    }
    return '';
}

function openaiPost(pathname, body, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request(
            { hostname: 'api.openai.com', path: pathname, method: 'POST', family: 4,
              headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
            (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, body: raw })); }
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// Trả về prompt tiếng Anh cho Flow (đã nhúng 3 dòng tiêu đề bằng ngôn ngữ đích).
export async function generateThumbnailFlowPrompt({ title = '', script = '', lang = 'en', hasReference = false }) {
    if (!OPENAI_KEY) throw new Error('Thiếu OPENAI_KEY');
    const style = readStyle(lang);
    const langName = LANG_NAMES[lang] || lang;

    // Nhánh NHÂN VẬT khác nhau: có ảnh mẫu -> vẽ theo ảnh mẫu; không có -> tra web lãnh đạo đương nhiệm.
    const personBlock = hasReference
        ? `- NHÂN VẬT: NGƯỜI DÙNG ĐÃ UPLOAD MỘT ẢNH MẪU của nhân vật chính. Mô tả chân dung là **"the exact person shown in the uploaded reference photo"**, GIỮ NGUYÊN khuôn mặt/đặc điểm/độ tuổi giống hệt ảnh mẫu. KHÔNG nêu tên, KHÔNG bịa nhân vật khác, KHÔNG đổi ngoại hình.`
        : `- NHÂN VẬT: Xác định (các) LÃNH ĐẠO / NHÂN VẬT CHÍNH TRỊ trung tâm của nội dung. QUAN TRỌNG:
    · Nếu nội dung nêu rõ TÊN người → dùng đúng người đó.
    · Nếu nội dung chỉ nói CHỨC VỤ (vd "thủ tướng Nhật", "tổng thống Mỹ") mà không nêu tên, hoặc nêu tên nhưng cần xác nhận đương nhiệm → **DÙNG web_search để tra ai đang GIỮ CHỨC VỤ ĐÓ TÍNH ĐẾN HÔM NAY** rồi vẽ đúng người đương nhiệm. TUYỆT ĐỐI không dựa vào trí nhớ của bạn (có thể đã lỗi thời — vd người đó đã mãn nhiệm/qua đời).
  Mô tả để vẽ **chân dung THỰC TẾ, nhận diện được đúng người đương nhiệm** (nêu tên + đặc điểm ngoại hình). KHÔNG tạo nhân vật hư cấu.`;

    const prompt = `Bạn là chuyên gia viết prompt tạo THUMBNAIL YouTube địa chính trị cho công cụ sinh ảnh (Google Flow / Imagen).

QUY CÁCH CHỮ & BỐ CỤC (BẮT BUỘC giữ nguyên — chỉ phần này lấy từ mẫu):
--- STYLE ---
${style}
--- HẾT STYLE ---

NHIỆM VỤ: Viết MỘT prompt tiếng Anh, TỰ SÁNG TÁC phần CẢNH dựa trên nội dung video, và ÁP DỤNG đúng quy cách chữ ở trên. Yêu cầu:
${personBlock}
- CẢNH/PHONG CẢNH: do bạn tự sinh cho KHỚP chủ đề (loại khủng hoảng, landmark quốc gia liên quan, bối cảnh) — không bê nguyên cảnh của mẫu.
- 3 DÒNG CHỮ TIÊU ĐỀ: viết bằng ${langName}, NGẮN, GÂY SỐC, leo thang, rút từ tiêu đề/nội dung video (KHÔNG dùng lại chữ ví dụ trong style). Ghi rõ từng dòng + màu (dòng 1 vàng distressed, dòng 2 đỏ máu distressed, dòng 3 trắng trên banner đỏ). Có thể kèm nghĩa tiếng Anh trong ngoặc.
- KHÔNG nhắc "image_0.png" hay tên file tham chiếu nào trong prompt output.
- CHỈ trả về đúng đoạn prompt (một khối văn bản), không giải thích, không markdown.

TIÊU ĐỀ VIDEO: ${title || '(không có)'}

NỘI DUNG VIDEO (tóm lược — dùng để chọn ${hasReference ? 'bối cảnh' : 'ĐÚNG lãnh đạo thật & bối cảnh'}):
${(script || '').slice(0, 3500)}`;

    // Có ảnh mẫu -> không cần web_search (nhân vật do ảnh quyết định) -> gpt-4o nhanh/rẻ.
    // Không có ảnh mẫu -> gpt-5 + web_search để tra CHÍNH XÁC lãnh đạo đương nhiệm.
    if (hasReference) {
        const res = await openaiPost('/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.8,
        });
        if (res.status !== 200) throw new Error(`GPT ${res.status}: ${res.body.slice(0, 300)}`);
        const out = JSON.parse(res.body).choices?.[0]?.message?.content?.trim();
        if (!out) throw new Error('GPT không trả prompt');
        return out;
    }

    const res = await openaiPost('/v1/responses', {
        model: 'gpt-5',
        reasoning: { effort: 'low' },
        max_output_tokens: 4000,
        tools: [{ type: 'web_search_preview' }],
        input: prompt,
    });
    if (res.status !== 200) throw new Error(`GPT ${res.status}: ${res.body.slice(0, 300)}`);
    const data = JSON.parse(res.body);
    const out = (data.output_text
        || data.output?.find(o => o.type === 'message')?.content?.find(c => c.type === 'output_text')?.text
        || '').trim();
    if (!out) throw new Error('GPT không trả prompt: ' + JSON.stringify(data).slice(0, 200));
    return out;
}
