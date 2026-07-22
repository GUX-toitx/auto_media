// translateTitle.js — dịch title dự án sang NGÔN NGỮ ĐÍCH.
// Không phụ thuộc mã lang: dịch sang cùng ngôn ngữ với đoạn content đích (refText); fallback langHint.
import { aiChat } from '../lib/ai.js';


// Trả bản dịch của `title`. Nếu thiếu key/lỗi -> trả nguyên `title`.
export async function translateTitle(title, refText = '', langHint = '') {
    if (!title) return title;   // key do lib ai.js kiểm tra theo AI_PROVIDER (openai/deepseek)
    const langLine = refText.trim()
        ? `Ngôn ngữ đích = CÙNG ngôn ngữ với đoạn tham chiếu sau:\n"""${refText.slice(0, 500)}"""`
        : `Ngôn ngữ đích: ${langHint || 'English'}`;
    const prompt = `Dịch tiêu đề video sau sang ngôn ngữ đích. Giữ nguyên ý, tự nhiên, súc tích. CHỈ trả về bản dịch, không thêm giải thích/ngoặc kép.
${langLine}

Tiêu đề: ${title}`;
    try {
        const { content } = await aiChat({
            tier: 'mini', temperature: 0.2,
            messages: [{ role: 'user', content: prompt }],
        });
        const out = content?.trim();
        return out ? out.replace(/^["“”']|["“”']$/g, '') : title;
    } catch { return title; }
}
