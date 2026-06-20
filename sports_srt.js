import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fetchFromGoogleImageBot } from './googleImageCrawler.js';

const OPENAI_KEY = process.env.OPENAI_KEY;
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const IMAGES_PER_KEYWORD = 8;

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

async function generateSentencesFromPrompt(prompt, targetLang) {
    const langName = { vi: 'tieng Viet', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish', th: 'Thai', id: 'Bahasa Indonesia' }[targetLang] || targetLang;
    const schema = {
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
                        }
                    },
                    required: ['vi', 'target', 'image_suggestions'],
                    additionalProperties: false
                }
            }
        },
        required: ['title', 'title_vi', 'sentences'],
        additionalProperties: false
    };
    const systemPrompt = `You are a professional sports commentator and analyst with access to the latest football data up to 2026.
Task:
1. Write a detailed sports analysis article simultaneously in Vietnamese AND ${langName}.
2. Use the most up-to-date data: current squad, recent form, head-to-head, key players, tactical setup.
3. Pronounce player names, coaches, tournaments correctly in both languages.
4. Cover: team form, key players, tactics, injury updates, prediction.
5. Target duration: 8-10 minutes of presentation content (approximately 2400-3500 words in the target language). Divide the analysis into paragraphs of 3-5 sentences each. Each "sentence" in the JSON output should be a FULL PARAGRAPH (multiple sentences combined), not a single short sentence. Group related ideas into one cohesive paragraph.
6. For each paragraph, provide the flow in Vietnamese and sequentially list the important keywords (following the subtitle flow) to search for images that match the subtitle.
7. NEVER cite sources, never add footnotes, never mention where data comes from, never add URLs, never add links in parentheses like ([source.com](url)).
7. Output ONLY clean sentences with no citations, no references, no URLs whatsoever.
8. Return JSON where each sentence has both "vi" (Vietnamese) and "target" (${langName}) versions.
9. No need to confirm with me, just go ahead.`;
    const res = await httpsPost(
        'https://api.openai.com/v1/responses',
        { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        {
            model: 'gpt-5',
            reasoning: { effort: 'high' },
            tools: [{ type: 'web_search_preview' }],
            max_output_tokens: 32000,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'sports_analysis',
                    schema,
                    strict: true
                }
            },
            input: systemPrompt + '\n\nRequest: ' + prompt
        }
    );
    if (res.status !== 200) throw new Error(`GPT loi ${res.status}: ${res.body.slice(0, 200)}`);
    const data = JSON.parse(res.body);
    const usage = data.usage;
    console.log(`[GPT-5] tokens - input: ${usage?.input_tokens}, output: ${usage?.output_tokens}, reasoning: ${usage?.output_tokens_details?.reasoning_tokens}`);
    if (data.status === 'incomplete') {
        const reason = data.incomplete_details?.reason || 'unknown';
        throw new Error(`GPT-5 incomplete: ${reason}. Output tokens: ${usage?.output_tokens}/${32000}`);
    }
    const outputText = data.output?.find(o => o.type === 'message')
        ?.content?.find(c => c.type === 'output_text')?.text;
    if (!outputText) throw new Error('GPT-5 khong tra ve output: ' + JSON.stringify(data).slice(0, 200));
    const parsed = JSON.parse(outputText);
    // Strip citations nếu GPT vẫn thêm vào
    const stripCitations = s => s.replace(/\s*\([^)]*\(https?:[^)]+\)[^)]*\)/g, '').replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();
    parsed.sentences = (parsed.sentences || []).map(s => ({ vi: stripCitations(s.vi), target: stripCitations(s.target), image_suggestions: s.image_suggestions || [] }));
    console.log('[GPT-5] === OUTPUT ===');
    console.log('Title VI:', parsed.title_vi);
    console.log('Title:', parsed.title);
    (parsed.sentences || []).forEach((s, i) => console.log(`  [${i+1}] VI: ${s.vi} | TARGET: ${s.target}`));
    console.log('[GPT-5] === END OUTPUT ===');
    return { title: parsed.title || '', title_vi: parsed.title_vi || '', sentences: parsed.sentences || [] };
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
                        content: 'You are a sports image search expert. Given a sports commentary paragraph, return 4-8 specific English Bing image search queries to find relevant photos. Prefer specific player names, team names, or match names when present. If the paragraph is about history, economy, or culture (no specific players), use relevant contextual terms (e.g. "Japan football 1980s", "Toyota factory 1980"). Always return at least 4 queries. Return ONLY a raw JSON array, no explanation.'
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
        if (Array.isArray(parsed)) return parsed.filter(Boolean).slice(0, 6);
        const val = Object.values(parsed)[0];
        return Array.isArray(val) ? val.filter(Boolean).slice(0, 6) : [];
    } catch {
        const match = content.match(/\[.*?\]/s);
        if (match) try { return JSON.parse(match[0]).filter(Boolean).slice(0, 6); } catch(_) {}
        return [];
    }
}

async function main() {
    const args = process.argv.slice(2);
    const isPromptMode = args[0] === '--prompt';
    const projectId = isPromptMode ? args[1] : args[1];
    const targetLang = isPromptMode ? (args[3] || 'vi') : (args[3] || 'vi');

    if (!projectId) {
        console.error('Usage: node sports_srt.js <file.srt> <projectId> [file_translated.srt] [targetLang]');
        console.error('       node sports_srt.js --prompt <projectId> <promptText> [targetLang]');
        process.exit(1);
    }

    let rawSentences; // [{ index, text }]
    let postTitle = '';
    let postTitleVi = '';

    if (isPromptMode) {
        const promptText = args[2];
        console.log(`[sports_srt] Prompt mode: generating sentences from GPT...`);
        const result = await generateSentencesFromPrompt(promptText, targetLang);
        postTitle = result.title;
        postTitleVi = result.title_vi || result.title;
        rawSentences = result.sentences.map((s, i) => ({ index: i + 1, text: s.target, textVi: s.vi, imageSuggestions: s.image_suggestions || [] }));
        console.log(`[sports_srt] GPT generated ${rawSentences.length} sentences. Title: ${postTitle}`);
    } else {
        const srtPath = args[0];
        const srtTranslatedPath = args[2] || null;
        if (!srtPath) { console.error('Missing srt path'); process.exit(1); }
        const srtSentences = parseSrt(srtPath);
        const translatedSentences = srtTranslatedPath ? parseSrt(srtTranslatedPath) : null;
        console.log(`[sports_srt] Đọc được ${srtSentences.length} câu từ ${srtPath}`);
        rawSentences = srtSentences.map(({ index, text }) => ({
            index,
            text: translatedSentences?.find(s => s.index === index)?.text || text,
            textVi: text
        }));
    }

    const db = await getDb();
    await db.run('INSERT OR IGNORE INTO Post (project_id, title, status, voice_content_type, target_lang) VALUES (?, ?, ?, ?, ?)',
        [projectId, postTitleVi || postTitle || projectId, 'crawling', targetLang === 'vi' ? 'content_vi' : 'content', targetLang]);
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;

    // Bước 1: Lưu toàn bộ paragraph vào DB trước
    const paragraphIds = [];
    for (const { index, text, textVi, imageSuggestions } of rawSentences) {
        const contentVi = textVi || text;
        const paraRes = await db.run(
            'INSERT INTO Paragraph (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, text, contentVi, index]
        );
        const paragraphId = paraRes.lastID;
        await db.run(
            'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [paragraphId, text, contentVi, 1]
        );
        // Lưu image_suggestions vào Keyword
        for (const sug of (imageSuggestions || [])) {
            if (sug) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, sug, 'image_suggestion']);
        }
        paragraphIds.push({ index, text, textVi: contentVi, paragraphId });
    }
    console.log(`[sports_srt] ✅ Đã lưu ${rawSentences.length} câu vào DB`);

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

        const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(0), ms))]);
        await Promise.all(keywords.map(kw => {
            console.log(`    -> Crawl ảnh: "${kw}"`);
            return withTimeout(
                fetchFromGoogleImageBot(kw, 'image', imgDir, IMAGES_PER_KEYWORD)
                    .then(got => console.log(`    -> Tải được: ${got} ảnh (${kw})`))
                    .catch(e => console.error(`    -> Lỗi crawl: ${e.message}`)),
                60000
            );
        }));

        const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
        if (fs.existsSync(imgDir)) {
            for (const file of fs.readdirSync(imgDir)) {
                if (!imageExts.has(path.extname(file).toLowerCase())) continue;
                const rel = path.join(projectId, 'assets', '_raw_images', String(index), file);
                const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                if (!exists) {
                    await db.run('INSERT INTO Asset (paragraph_id, type, file_path) VALUES (?, ?, ?)', [paragraphId, 'image', rel]);
                }
            }
        }
    }

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    console.log('\n[sports_srt] ✅ Hoàn thành!');
}

main().catch(e => { console.error('[sports_srt] LỖI:', e.message); process.exit(1); });

