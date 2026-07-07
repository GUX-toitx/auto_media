// seoTitle.js — Sinh TITLE (+ mô tả, tags) SEO cho video theo khung prompts/seo/Nhiemvu.txt.
// Thay đoạn "Tôi cung cấp 3 file: ..." trong Nhiemvu.txt bằng NỘI DUNG THẬT của 3 file:
//   kichban = nội dung sub/kịch bản dự án, tieudemau.txt, thuatngu.txt.
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const OPENAI_KEY = process.env.OPENAI_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';

// Đọc file SEO theo ĐÚNG ngôn ngữ. base = 'Nhiemvu'|'tieudemau'|'thuatngu'.
// Chỉ thử <base>.<lang>.txt -> <base>.txt (KHÔNG dùng lang khác). Thiếu -> trả ''.
function readSeoLang(base, lang) {
    const wanted = [`${base}.${lang}.txt`, `${base}.txt`].map(n => n.toLowerCase());
    for (const dir of [path.join(__dirname, 'prompts', 'seo'), path.join(MEDIA_DIR, 'prompts', 'seo')]) {
        if (!fs.existsSync(dir)) continue;
        // So khớp không phân biệt hoa/thường (Nhiemvu.ja.txt ~ nhiemvu.ja.txt)
        const files = fs.readdirSync(dir);
        for (const w of wanted) {
            const hit = files.find(f => f.toLowerCase() === w);
            if (hit) return fs.readFileSync(path.join(dir, hit), 'utf8');
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

// Dựng prompt cuối: Nhiemvu.<lang>.txt với block liệt kê 3 file -> thay bằng nội dung thật.
// Trả null nếu THIẾU file Nhiemvu cho ngôn ngữ này.
export function buildSeoTitlePrompt(script, lang = 'en') {
    const nhiemVu = readSeoLang('Nhiemvu', lang);
    if (!nhiemVu.trim()) return null;
    const tieuDeMau = readSeoLang('tieudemau', lang);
    const thuatNgu = readSeoLang('thuatngu', lang);

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
export async function generateSeoTitle(script, lang = 'en') {
    if (!OPENAI_KEY) throw new Error('Thiếu OPENAI_KEY');
    const base = buildSeoTitlePrompt(script, lang);
    if (!base) throw new Error(`Chưa có file SEO cho ngôn ngữ "${lang}". Hãy tạo prompts/seo/Nhiemvu.${lang}.txt (và tieudemau.${lang}.txt, thuatngu.${lang}.txt).`);

    const prompt = `${base}

---
Trả về JSON đúng schema:
- "target": TOÀN BỘ kết quả SEO theo đúng "Output Format" ở trên, bằng NGÔN NGỮ ĐÍCH.
- "vi": bản dịch TIẾNG VIỆT của "target" để người dùng đối chiếu — giữ NGUYÊN cấu trúc, nhãn mục (🎯/📝/🏷️/📊), emoji và thứ tự; chỉ dịch phần chữ.`;

    const schema = { type: 'object', properties: { target: { type: 'string' }, vi: { type: 'string' } }, required: ['target', 'vi'], additionalProperties: false };
    const res = await openaiPost('/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'seo_result', strict: true, schema } },
        temperature: 0.8,
    });
    if (res.status !== 200) throw new Error(`GPT ${res.status}: ${res.body.slice(0, 200)}`);
    const content = JSON.parse(res.body).choices?.[0]?.message?.content;
    if (!content) throw new Error('GPT không trả kết quả');
    const parsed = JSON.parse(content);
    return { target: parsed.target || '', vi: parsed.vi || '' };
}
