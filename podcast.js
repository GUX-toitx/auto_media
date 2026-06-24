import 'dotenv/config';
import path from 'path';
import https from 'https';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const OPENAI_KEY = process.env.OPENAI_KEY;
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const data = JSON.stringify(body);
        const req = https.request(
            { hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', family: 4, headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
            (res) => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, body: raw })); }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// Parse kịch bản thủ công thành segments bằng GPT
async function parseScriptWithGPT(rawScript, title, targetLang) {
    const schema = {
        type: 'object',
        properties: {
            segments: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        speaker: { type: 'string' },
                        text: { type: 'string' },
                        text_vi: { type: 'string' }
                    },
                    required: ['speaker', 'text', 'text_vi'],
                    additionalProperties: false
                }
            }
        },
        required: ['segments'],
        additionalProperties: false
    };

    const prompt = `Bạn là một công cụ parse kịch bản podcast tiếng Việt. Nhiệm vụ là tách kịch bản thành các segment lời thoại theo từng nhân vật.

Quy tắc xử lý tag speaker:
- Tag có dạng: [Voice (Nhân vật X, giới tính Y)] hoặc [Voice (Nhân vật X - mô tả, giới tính Y)]
- Trích xuất tên nhân vật từ tag đó làm giá trị "speaker". Ví dụ: "Nhân vật Tôi", "Nhân vật Huy", "Nhân vật Bạn gái hiện tại", "Nhân vật Phụ xe"
- Nếu có "Súy nghĩ nội tâm" trong tag, ghi rõ vào speaker: "Nhân vật Tôi - Nội tâm"

Quy tắc xử lý nội dung:
- Bỏ toàn bộ dòng âm thanh nền/soundscape: dòng bắt đầu bằng (hoặc chứa "Âm thanh nền", "Nhạc", "Soundscape", "Outro", "Intro")
- Bỏ các dòng chỉ dẫn sân khấu nằm trong dấu ngặc đơn đứng độc lập trên một dòng: (Tiếng...), (Ẩm thanh...), (Nhạc...), (Hành động...)
- Giữ nguyên các cụm từ chỉ hành động nằm giữa lời thoại nếu chúng là mô tả hành động của nhân vật đang kể chuyện
- Xóa dấu ngoặc kép bao quanh lời thoại (“...” hoặc "...")
- Gộp các dòng liên tiếp cùng 1 speaker thành 1 segment duy nhất
- Không bỏ sót bất kỳ lời thoại nào
- "text" và "text_vi": đều điền nội dung tiếng Việt (vì kịch bản đã là tiếng Việt)

Kịch bản:
${rawScript}`;

    const res = await httpsPost(
        'https://api.openai.com/v1/chat/completions',
        { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_schema', json_schema: { name: 'script_segments', strict: true, schema } },
            temperature: 0.1
        }
    );
    if (res.status !== 200) throw new Error(`GPT parse error ${res.status}: ${res.body.slice(0, 200)}`);
    const data = JSON.parse(res.body);
    const parsed = JSON.parse(data.choices[0].message.content);
    console.log(`[podcast] GPT parsed ${parsed.segments.length} segments`);
    return { title, segments: parsed.segments, lang: targetLang };
}

// GPT sinh script từ topic
async function generateScript(topic, style, targetLang) {
    const langName = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean' }[targetLang] || targetLang;
    const isDialog = style === 'dialog';

    const schema = {
        type: 'object',
        properties: {
            title: { type: 'string' },
            title_vi: { type: 'string' },
            segments: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        speaker: { type: 'string' },
                        text: { type: 'string' },
                        text_vi: { type: 'string' }
                    },
                    required: ['speaker', 'text', 'text_vi'],
                    additionalProperties: false
                }
            }
        },
        required: ['title', 'title_vi', 'segments'],
        additionalProperties: false
    };

    const systemPrompt = isDialog
        ? `You are a podcast scriptwriter. Write a natural, engaging podcast DIALOGUE in ${langName} between a host and a guest.
- Target: 10-15 minutes (~1500-2000 words total)
- Each segment = one speaking turn (2-5 sentences, conversational)
- "speaker": use natural names like "Host", "Guest" or names fitting the topic
- "text": ${langName} version
- "text_vi": Vietnamese version
- "title_vi": Vietnamese title
- No stage directions, pure speech only`
        : `You are a podcast scriptwriter. Write an engaging solo podcast MONOLOGUE in ${langName}.
- Target: 10-15 minutes (~1500-2000 words total)
- Each segment = one paragraph/thought (3-5 sentences)
- "speaker": host name fitting the topic
- "text": ${langName} version
- "text_vi": Vietnamese version
- "title_vi": Vietnamese title
- No stage directions, pure speech only`;

    const res = await httpsPost(
        'https://api.openai.com/v1/responses',
        { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        {
            model: 'gpt-5',
            reasoning: { effort: 'high' },
            tools: [{ type: 'web_search_preview' }],
            max_output_tokens: 16000,
            text: { format: { type: 'json_schema', name: 'podcast_script', schema, strict: true } },
            input: systemPrompt + '\n\nTopic: ' + topic
        }
    );
    if (res.status !== 200) throw new Error(`GPT error ${res.status}: ${res.body.slice(0, 200)}`);
    const data = JSON.parse(res.body);
    const usage = data.usage;
    console.log(`[GPT-5] tokens - input: ${usage?.input_tokens}, output: ${usage?.output_tokens}`);
    if (data.status === 'incomplete') throw new Error(`GPT incomplete: ${data.incomplete_details?.reason}`);
    const outputText = data.output?.find(o => o.type === 'message')?.content?.find(c => c.type === 'output_text')?.text;
    if (!outputText) throw new Error('GPT no output');
    const parsed = JSON.parse(outputText);
    return { title: parsed.title_vi || parsed.title, segments: parsed.segments, lang: targetLang };
}

async function main() {
    const args = process.argv.slice(2);
    // args layout:
    // script mode: [projectId, '--script', scriptPath, title, lang]
    // topic mode:  [projectId, '--topic', style, lang, ...topic]
    const projectId = args[0];
    const mode = args[1];

    if (!projectId) { console.error('Usage: node podcast.js <projectId> --script|--topic ...'); process.exit(1); }

    const db = await getDb();
    let result;

    if (mode === '--script') {
        const scriptPath = args[2];
        const title = args[3] || projectId;
        const lang = args[4] || 'vi';
        console.log(`[podcast] Script mode: parsing "${title}"...`);
        const { readFileSync } = await import('fs');
        result = await parseScriptWithGPT(readFileSync(scriptPath, 'utf8'), title, lang);
    } else {
        const style = args[2] || 'dialog';
        const lang = args[3] || 'vi';
        const topic = args.slice(4).join(' ') || 'Podcast';
        console.log(`[podcast] Topic mode: "${topic}"`);
        result = await generateScript(topic, style, lang);
    }
    // Lưu vào DB như sports_srt - dùng Post + Paragraph + ParagraphDetail
    await db.run('INSERT OR IGNORE INTO Post (project_id, title, status, voice_content_type, target_lang) VALUES (?, ?, ?, ?, ?)',
        [projectId, result.title || projectId, 'crawling', result.lang === 'vi' ? 'content_vi' : 'content', result.lang || 'vi']);
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;

    await db.run('UPDATE Post SET title = ? WHERE id = ?', [result.title || projectId, postId]);

    const lang = result.lang || 'vi';
    for (let i = 0; i < result.segments.length; i++) {
        const seg = result.segments[i];
        const text = lang === 'vi' ? seg.text_vi : seg.text;
        const textVi = seg.text_vi;

        const paraRes = await db.run(
            'INSERT INTO Paragraph (post_id, content, content_vi, title_vi, "order") VALUES (?, ?, ?, ?, ?)',
            [postId, text, textVi, seg.speaker, i + 1]
        );
        const paragraphId = paraRes.lastID;
        await db.run(
            'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [paragraphId, text, textVi, 1]
        );
    }

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    console.log(`[podcast] ✅ Done! ${result.segments.length} segments → Post#${postId} "${result.title}"`);
}

main().catch(e => { console.error('[podcast] LỖI:', e.message); process.exit(1); });
