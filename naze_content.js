import 'dotenv/config';
import path from 'path';
import https from 'https';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fetchFromStoryblocksBot } from './storyblocksCrawler.js';
import { fetchFromGoogleImageBot } from './googleImageCrawler.js';
import { fetchIPv4 as fetch } from './fetchIPv4.js';
import { claimNextStockPath } from './stockNaming.js';
import fs from 'fs';

const OPENAI_KEY = process.env.OPENAI_KEY;
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });
const IMAGES_PER_KEYWORD = 8;

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

async function downloadFile(url, targetDir) {
    const savePath = claimNextStockPath(targetDir, 'jpg');
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) { fs.writeFileSync(savePath, Buffer.from(await res.arrayBuffer())); return true; }
    } catch (_) {}
    try { fs.unlinkSync(savePath); } catch (_) {}
    return false;
}

async function fetchFromPexels(keyword, targetDir, count) {
    if (!PEXELS_API_KEY || PEXELS_API_KEY.includes('DIEN')) return 0;
    let n = 0;
    try {
        const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${count * 2}`, { headers: { Authorization: PEXELS_API_KEY } });
        if (!res.ok) return 0;
        const data = await res.json();
        for (const item of (data.photos || [])) {
            if (n >= count) break;
            if (await downloadFile(item.src.large, targetDir)) n++;
        }
    } catch (e) { console.log('Pexels loi:', e.message); }
    return n;
}

async function fetchFromPixabay(keyword, targetDir, count) {
    if (!PIXABAY_API_KEY || PIXABAY_API_KEY.includes('DIEN')) return 0;
    let n = 0;
    try {
        const res = await fetch(`https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(keyword)}&per_page=${Math.max(3, count * 2)}&safesearch=true`);
        if (!res.ok) return 0;
        const data = await res.json();
        for (const item of (data.hits || [])) {
            if (n >= count) break;
            if (await downloadFile(item.largeImageURL, targetDir)) n++;
        }
    } catch (e) { console.log('Pixabay loi:', e.message); }
    return n;
}

async function fetchImages(keyword, targetDir, count) {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const results = await Promise.allSettled([
        fetchFromPexels(keyword, targetDir, count),
        fetchFromPixabay(keyword, targetDir, count),
        fetchFromStoryblocksBot(keyword, 'image', targetDir, count),
        fetchFromGoogleImageBot(keyword, 'image', targetDir, count),
    ]);
    return results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? (r.value || 0) : 0), 0);
}



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

async function generateContent(topic, targetLang) {
    const langName = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish', th: 'Thai', id: 'Bahasa Indonesia' }[targetLang] || targetLang;
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
                        target: { type: 'string' }
                    },
                    required: ['vi', 'target'],
                    additionalProperties: false
                }
            }
        },
        required: ['title', 'title_vi', 'sentences'],
        additionalProperties: false
    };

    const systemPrompt = `You are a professional science and knowledge YouTube narrator in the style of Vsauce, Kurzgesagt, and SciShow.
Task:
1. Write engaging educational content about the given topic in BOTH Vietnamese AND ${langName} simultaneously.
2. Style: conversational, curious, mind-blowing facts, build-up from simple to complex.
3. Structure: Hook (why this question matters) → Simple explanation → Deeper science → Surprising facts → Conclusion.
4. Target length: 4-5 minutes of voice-over (approximately 600-750 words per language, 40-60 sentences).
5. Each sentence should be short, punchy, suitable for voice-over (8-20 words).
6. Use analogies and relatable examples to explain complex concepts.
7. NEVER cite sources, never add URLs, never add footnotes or references.
8. Output clean sentences only with no citations whatsoever.`;

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
                    name: 'naze_content',
                    schema,
                    strict: true
                }
            },
            input: systemPrompt + '\n\nTopic: ' + topic
        }
    );

    if (res.status !== 200) throw new Error(`GPT loi ${res.status}: ${res.body.slice(0, 200)}`);
    const data = JSON.parse(res.body);
    const usage = data.usage;
    console.log(`[GPT-5] tokens - input: ${usage?.input_tokens}, output: ${usage?.output_tokens}, reasoning: ${usage?.output_tokens_details?.reasoning_tokens}`);
    if (data.status === 'incomplete') {
        throw new Error(`GPT-5 incomplete: ${data.incomplete_details?.reason}. Tokens: ${usage?.output_tokens}/32000`);
    }
    const outputText = data.output?.find(o => o.type === 'message')?.content?.find(c => c.type === 'output_text')?.text;
    if (!outputText) throw new Error('GPT-5 no output: ' + JSON.stringify(data).slice(0, 200));

    const parsed = JSON.parse(outputText);
    const stripCitations = s => s.replace(/\s*\([^)]*\(https?:[^)]+\)[^)]*\)/g, '').replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();
    parsed.sentences = (parsed.sentences || []).map(s => ({ vi: stripCitations(s.vi), target: stripCitations(s.target) }));

    console.log('[GPT-5] === OUTPUT ===');
    console.log('Title VI:', parsed.title_vi);
    console.log('Title:', parsed.title);
    (parsed.sentences || []).forEach((s, i) => console.log(`  [${i+1}] VI: ${s.vi} | TARGET: ${s.target}`));
    console.log('[GPT-5] === END OUTPUT ===');

    return { title: parsed.title || '', title_vi: parsed.title_vi || '', sentences: parsed.sentences || [] };
}

async function getKeywordsFromGPT(sentence) {
    const res = await httpsPost(
        'https://api.openai.com/v1/chat/completions',
        { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are an image search expert. Given a science/educational sentence, return exactly 6 specific English image search queries for stock photo sites. Focus on visual concepts, nature, science diagrams, real phenomena. Return ONLY a raw JSON array. Example: ["ocean salt crystals closeup", "salt minerals underwater", "ocean water evaporation"]'
                },
                { role: 'user', content: sentence }
            ],
            temperature: 0.3
        }
    );
    if (res.status !== 200) {
        if (res.status === 401) throw new Error(`GPT loi 401: API key khong hop le`);
        if (res.status === 429) throw new Error(`GPT loi 429: Rate limit`);
        throw new Error(`GPT loi ${res.status}`);
    }
    const data = JSON.parse(res.body);
    let content = data.choices?.[0]?.message?.content || '[]';
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return parsed.slice(0, 6);
        const val = Object.values(parsed)[0];
        return Array.isArray(val) ? val.slice(0, 6) : [content.slice(0, 60)];
    } catch {
        const match = content.match(/\[.*?\]/s);
        if (match) try { return JSON.parse(match[0]).slice(0, 6); } catch(_) {}
        return [content.slice(0, 60)];
    }
}

async function main() {
    const args = process.argv.slice(2);
    const topic = args[0];
    const projectId = args[1];
    const targetLang = args[2] || 'vi';

    if (!topic || !projectId) {
        console.error('Usage: node naze_content.js <topic> <projectId> [targetLang]');
        process.exit(1);
    }

    console.log(`[naze] Topic: ${topic} | Lang: ${targetLang}`);

    const result = await generateContent(topic, targetLang);

    const db = await getDb();
    await db.run('INSERT OR IGNORE INTO Post (project_id, title, status, voice_content_type, target_lang) VALUES (?, ?, ?, ?, ?)',
        [projectId, result.title_vi || result.title || projectId, 'crawling', targetLang === 'vi' ? 'content_vi' : 'content', targetLang]);
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;

    const paragraphIds = [];
    for (const [i, s] of result.sentences.entries()) {
        const paraRes = await db.run(
            'INSERT INTO Paragraph (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, s.target, s.vi, i + 1]
        );
        const paragraphId = paraRes.lastID;
        await db.run(
            'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [paragraphId, s.target, s.vi, 1]
        );
        paragraphIds.push({ index: i + 1, text: s.vi, paragraphId });
    }
    console.log(`[naze] ✅ Đã lưu ${result.sentences.length} câu vào DB`);

    // Crawl ảnh
    for (const { index, text, paragraphId } of paragraphIds) {
        console.log(`\n[${index}/${paragraphIds.length}] "${text.slice(0, 60)}..."`);
        let keywords;
        try {
            keywords = await getKeywordsFromGPT(text);
            console.log(`    Keywords: ${keywords.join(' | ')}`);
        } catch (e) {
            console.error(`    GPT loi: ${e.message}`);
            if (e.message.includes('401') || e.message.includes('429')) {
                try {
                    const http = await import('http');
                    http.default.request({ hostname: 'localhost', port: process.env.PORT || 3000, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
                        .end(JSON.stringify({ postTitle: projectId, status: `❌ GPT: ${e.message}` }));
                } catch (_) {}
                process.exit(1);
            }
            continue;
        }

        await db.run('DELETE FROM Keyword WHERE paragraph_id = ?', [paragraphId]);
        for (const kw of keywords) {
            await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, kw, 'factual']);
        }

        const imgDir = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', String(index));
        const { mkdirSync, existsSync } = await import('fs');
        if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });

        for (const kw of keywords) {
            try {
                const got = await fetchImages(kw, imgDir, IMAGES_PER_KEYWORD);
                console.log(`      [${kw}] ${got} images`);
            } catch (e) { console.error(`      [${kw}] loi: ${e.message}`); }
        }

        // Sync vào DB
        const { readdirSync } = await import('fs');
        const exts = ['.jpg', '.jpeg', '.png', '.webp'];
        if (existsSync(imgDir)) {
            for (const file of readdirSync(imgDir)) {
                if (!exts.includes(path.extname(file).toLowerCase())) continue;
                const rel = path.relative(MEDIA_DIR, path.join(imgDir, file));
                const ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                if (!ex) await db.run('INSERT INTO Asset (paragraph_id, type, file_path) VALUES (?, ?, ?)', [paragraphId, 'image', rel]);
            }
        }
    }

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    console.log('\n[naze] ✅ Hoàn thành!');
}

main().catch(e => { console.error('[naze] LỖI:', e.message); process.exit(1); });
