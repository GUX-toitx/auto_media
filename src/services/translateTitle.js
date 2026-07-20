// translateTitle.js — dịch title dự án sang NGÔN NGỮ ĐÍCH.
// Không phụ thuộc mã lang: dịch sang cùng ngôn ngữ với đoạn content đích (refText); fallback langHint.
import https from 'https';

const OPENAI_KEY = process.env.OPENAI_KEY;

function openaiPost(pathname, body, timeoutMs = 60000) {
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

// Trả bản dịch của `title`. Nếu thiếu key/lỗi -> trả nguyên `title`.
export async function translateTitle(title, refText = '', langHint = '') {
    if (!OPENAI_KEY || !title) return title;
    const langLine = refText.trim()
        ? `Ngôn ngữ đích = CÙNG ngôn ngữ với đoạn tham chiếu sau:\n"""${refText.slice(0, 500)}"""`
        : `Ngôn ngữ đích: ${langHint || 'English'}`;
    const prompt = `Dịch tiêu đề video sau sang ngôn ngữ đích. Giữ nguyên ý, tự nhiên, súc tích. CHỈ trả về bản dịch, không thêm giải thích/ngoặc kép.
${langLine}

Tiêu đề: ${title}`;
    try {
        const res = await openaiPost('/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
        });
        if (res.status !== 200) return title;
        const out = JSON.parse(res.body).choices?.[0]?.message?.content?.trim();
        return out ? out.replace(/^["“”']|["“”']$/g, '') : title;
    } catch { return title; }
}
