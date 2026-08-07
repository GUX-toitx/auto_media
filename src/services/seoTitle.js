// seoTitle.js — Sinh TITLE (+ mô tả, tags) SEO cho video theo khung prompts/seo/Nhiemvu.txt.
// Thay đoạn "Tôi cung cấp 3 file: ..." trong Nhiemvu.txt bằng NỘI DUNG THẬT của 3 file:
//   kichban = nội dung sub/kịch bản dự án, tieudemau.txt, thuatngu.txt.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { aiChat, assertAiKey } from '../lib/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');   // src/services -> gốc repo
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';

// Đọc file SEO theo ĐÚNG ngôn ngữ. base = 'Nhiemvu'|'tieudemau'|'thuatngu' (+ hậu tố thể loại).
// Chỉ thử <base>.<lang>.txt -> <base>.txt (KHÔNG dùng lang khác). Thiếu -> trả ''.
// dirs: cho phép tìm thêm ngoài prompts/seo (sport mượn glossary ở prompts/contents).
function readSeoLang(base, lang, dirs = null) {
    const wanted = [`${base}.${lang}.txt`, `${base}.txt`].map(n => n.toLowerCase());
    const roots = dirs || [['prompts', 'seo']];
    for (const parts of roots) {
        for (const dir of [path.join(ROOT, ...parts), path.join(MEDIA_DIR, ...parts)]) {
            if (!fs.existsSync(dir)) continue;
            // So khớp không phân biệt hoa/thường (Nhiemvu.ja.txt ~ nhiemvu.ja.txt)
            const files = fs.readdirSync(dir);
            for (const w of wanted) {
                const hit = files.find(f => f.toLowerCase() === w);
                if (hit) return fs.readFileSync(path.join(dir, hit), 'utf8');
            }
        }
    }
    return '';
}

// Thể loại sport dùng BỘ FILE RIÊNG (hậu tố _bongda): khung nhiệm vụ + 100 tiêu đề mẫu của
// báo bóng đá Nhật, khác hẳn bộ mặc định. Thêm thể loại mới chỉ cần thêm 1 dòng ở đây.
const SEO_GENRE_SUFFIX = { sport: '_bongda' };

// Dựng prompt cuối: Nhiemvu.<lang>.txt với block liệt kê 3 file -> thay bằng nội dung thật.
// Trả null nếu THIẾU file Nhiemvu cho ngôn ngữ/thể loại này.
export function buildSeoTitlePrompt(script, lang = 'en', genre = null) {
    const sfx = SEO_GENRE_SUFFIX[genre] || '';
    const nhiemVu = readSeoLang(`Nhiemvu${sfx}`, lang);
    if (!nhiemVu.trim()) return null;
    const tieuDeMau = readSeoLang(`tieudemau${sfx}`, lang);
    // Glossary: ưu tiên bản SEO riêng của thể loại, không có thì mượn glossary dùng cho khâu
    // viết kịch bản ở prompts/contents (sport đang chỉ có file ở đó), cuối cùng mới về bản mặc định.
    const thuatNgu = sfx
        ? (readSeoLang(`thuatngu${sfx}`, lang, [['prompts', 'seo'], ['prompts', 'contents']]) || readSeoLang('thuatngu', lang))
        : readSeoLang('thuatngu', lang);

    const filesBlock = `Dữ liệu đầu vào (NỘI DUNG THỰC TẾ của 3 file, dùng trực tiếp bên dưới):

===== kichban.txt (kịch bản/sub của video) =====
${(script || '').slice(0, 8000)}

===== tieudemau.txt (tiêu đề mẫu) =====
${tieuDeMau}

===== thuatngu.txt (glossary thuật ngữ) =====
${thuatNgu}`;

    // Thay từ "Dữ liệu đầu vào\nTôi cung cấp 3 file:" ... đến hết dòng liệt kê file thuatngu.txt
    const re = /Dữ liệu đầu vào\s*\nTôi cung cấp 3 file:[\s\S]*?thuatngu\.txt[^\n]*/;
    if (re.test(nhiemVu)) return nhiemVu.replace(re, filesBlock);
    // fallback: nếu không match, chèn nội dung 3 file vào cuối
    return `${nhiemVu}\n\n${filesBlock}`;
}

// Gọi GPT -> trả { target, vi }: target = kết quả SEO theo Output Format (ngôn ngữ đích);
// vi = bản dịch tiếng Việt của target để đối chiếu (giữ nguyên cấu trúc/nhãn).
export async function generateSeoTitle(script, lang = 'en', genre = null) {
    assertAiKey();   // kiểm key theo AI_PROVIDER (openai/deepseek)
    const base = buildSeoTitlePrompt(script, lang, genre);
    if (!base) {
        const sfx = SEO_GENRE_SUFFIX[genre] || '';
        throw new Error(`Chưa có file SEO cho ngôn ngữ "${lang}"${sfx ? ` (thể loại ${genre})` : ''}. `
            + `Hãy tạo prompts/seo/Nhiemvu${sfx}.${lang}.txt hoặc Nhiemvu${sfx}.txt (kèm tieudemau${sfx}, thuatngu${sfx}).`);
    }

    const prompt = `${base}

---
Trả về JSON đúng schema:
- "target": TOÀN BỘ kết quả SEO theo đúng "Output Format" ở trên, bằng NGÔN NGỮ ĐÍCH.
- "vi": bản dịch TIẾNG VIỆT của "target" để người dùng đối chiếu — giữ NGUYÊN cấu trúc, nhãn mục (🎯/📝/🏷️/📊), emoji và thứ tự; chỉ dịch phần chữ.`;

    // Ép JSON: dùng json_object cho cả 2 provider (DeepSeek không có json_schema strict) + tả schema trong prompt.
    const { content } = await aiChat({
        tier: 'std', temperature: 0.8, json: true,
        messages: [{ role: 'user', content: `${prompt}\n\nTrả về DUY NHẤT một object json dạng {"target": "<chuỗi>", "vi": "<chuỗi>"} — không thêm trường nào khác, không bọc markdown.` }],
    });
    if (!content) throw new Error('AI không trả kết quả');
    const parsed = JSON.parse(String(content).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
    return { target: parsed.target || '', vi: parsed.vi || '' };
}
