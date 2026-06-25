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
4. Target length: 8-10 minutes of voice-over (approximately 2400-3500 words per language). Divide into paragraphs of 3-5 sentences each. Each "sentence" in the JSON output should be a FULL PARAGRAPH (multiple sentences combined), not a single short sentence. Group related ideas into one cohesive paragraph.
5. Use analogies and relatable examples to explain complex concepts.
6. NEVER cite sources, never add URLs, never add footnotes or references.
7. Output clean sentences only with no citations whatsoever.`;

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
    const mode = args[0]; // topic text, --srt, --youtube

    let projectId, targetLang, rawSentences = null, postTitleVi = '';

    if (mode === '--srt') {
        const srtPath = args[1];
        projectId = args[2];
        const srtTargetPath = args[3] && !args[3].match(/^[a-z]{2}$/) ? args[3] : null;
        targetLang = (srtTargetPath ? args[4] : args[3]) || 'vi';
        if (!srtPath || !projectId) { console.error('Usage: node naze_content.js --srt <srt> <projectId> [srtTarget] [lang]'); process.exit(1); }
        const { readFileSync } = await import('fs');
        const parseSrt = (p) => {
            const blocks = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim().split(/\n\n+/);
            return blocks.map(b => { const lines = b.trim().split('\n'); return lines.length >= 3 ? lines.slice(2).join(' ').trim() : null; }).filter(Boolean);
        };
        const srcSentences = parseSrt(srtPath);
        const tgtSentences = srtTargetPath ? parseSrt(srtTargetPath) : null;
        rawSentences = srcSentences.map((vi, i) => ({ vi, target: tgtSentences?.[i] || vi }));
        postTitleVi = projectId;
        console.log(`[naze] SRT mode: ${rawSentences.length} sentences`);
    } else if (mode === '--youtube') {
        const url = args[1];
        projectId = args[2];
        targetLang = args[3] || 'vi';
        if (!url || !projectId) { console.error('Usage: node naze_content.js --youtube <url> <projectId> [lang]'); process.exit(1); }
        console.log(`[naze] YouTube mode: ${url} | targetLang: ${targetLang}`);
        const { execSync } = await import('child_process');
        const { mkdirSync, existsSync, readdirSync, readFileSync } = await import('fs');
        const targetDir = path.join(MEDIA_DIR, projectId);
        if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

        // Tải transcript qua youtube-transcript-api (Python)
        const getTranscript = (videoId, langs, noFallback = false) => {
            const langArg = langs.join(',');
            const fallbackCode = noFallback ? 'raise' : `tl = api.list('${videoId}')\n    t = list(tl)[0].fetch()\n    print(json.dumps({'lang': t.language_code, 'texts': [s.text for s in t.snippets]}))`;
            try {
                const out = execSync(`python3 -c "
import sys, json
from youtube_transcript_api import YouTubeTranscriptApi
api = YouTubeTranscriptApi()
langs = '${langArg}'.split(',')
try:
    t = api.fetch('${videoId}', languages=langs)
    print(json.dumps({'lang': t.language_code, 'texts': [s.text for s in t.snippets]}))
except Exception as e:
    ${fallbackCode}
"`, { encoding: 'utf8' });
                return JSON.parse(out.trim());
            } catch (e) { throw new Error('youtube-transcript-api loi: ' + e.message.slice(0, 100)); }
        };

        const videoId = url.match(/[?&]v=([^&]+)/)?.[1] || url.split('/').pop();
        console.log(`[naze] Fetching transcript for videoId: ${videoId}`);

        // Lấy transcript gốc
        const prefLangs = targetLang === 'vi' ? ['vi', 'en', 'ja'] : [targetLang, 'vi', 'en', 'ja'];
        const srcTranscript = getTranscript(videoId, prefLangs);
        console.log(`[naze] Got ${srcTranscript.texts.length} entries in ${srcTranscript.lang}`);

        // Cố lấy thêm vi nếu có
        let viTranscript = null;
        if (srcTranscript.lang !== 'vi') {
            try { viTranscript = getTranscript(videoId, ['vi'], true); } catch (_) {}
        }

        // Ghép text thành câu liên tục (remove HTML tags, join)
        const joinTexts = (texts) => texts.map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
        const srcText = joinTexts(srcTranscript.texts);
        const viText = viTranscript ? joinTexts(viTranscript.texts) : null;

        // Placeholder cho parseSrt - không dùng nữa
        const viFile = viText ? '__vi__' : null;
        const targetFile = srcTranscript.lang === targetLang ? '__target__' : null;
        const anyFile = '__any__';
        const parseSrtText = (text) => text.split(/[.!?。！？]+/).map(s => s.trim()).filter(s => s.length > 5);

        // Hàm làm mịn sub bằng GPT-4o (gộp câu bị cắt, loại ký tự thừa)
        const smoothSub = async (sentences, lang) => {
            const langName = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish' }[lang] || lang;
            console.log(`[naze] Smoothing ${sentences.length} sentences in ${langName}...`);
            const text = sentences.join(' ');
            const res = await httpsPost(
                'https://api.openai.com/v1/chat/completions',
                { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
                {
                    model: 'gpt-4o',
                    messages: [
                        { role: 'system', content: `You are a subtitle editor. Given raw auto-generated subtitle text in ${langName}, clean it up:
1. Fix broken sentences (subtitles are often cut mid-sentence - rejoin them).
2. Remove filler words, stutters, repeated words.
3. Split into complete, natural sentences suitable for voice-over (10-25 words each).
4. KEEP all content and meaning, do NOT summarize or remove information.
5. Return ONLY a JSON array of clean sentences: ["sentence 1", "sentence 2", ...]` },
                        { role: 'user', content: text.slice(0, 12000) }
                    ],
                    temperature: 0.3,
                    response_format: { type: 'json_object' }
                }
            );
            if (res.status !== 200) { console.error(`[naze] GPT smooth error ${res.status}`); return sentences; }
            const data = JSON.parse(res.body);
            const parsed = JSON.parse(data.choices[0].message.content);
            const result = Array.isArray(parsed) ? parsed : Object.values(parsed)[0];
            console.log(`[naze] Smoothed: ${result.length} sentences`);
            const clean = (Array.isArray(result) ? result : sentences).map(s => String(s).replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
            return clean;
        };

        // Hàm dịch mảng câu
        const translateSentences = async (sentences, fromLang, toLang) => {
            const toLangName = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', fr: 'French', es: 'Spanish' }[toLang] || toLang;
            console.log(`[naze] Translating ${sentences.length} sentences to ${toLangName}...`);
            const numbered = sentences.map((s, i) => `${i+1}. ${s}`).join('\n');
            const res = await httpsPost(
                'https://api.openai.com/v1/chat/completions',
                { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
                {
                    model: 'gpt-4o',
                    messages: [
                        { role: 'system', content: `Translate each numbered sentence to ${toLangName}. Keep numbering. Return JSON: {"sentences": ["translated 1", "translated 2", ...]}` },
                        { role: 'user', content: numbered.slice(0, 12000) }
                    ],
                    temperature: 0.2,
                    response_format: { type: 'json_object' }
                }
            );
            if (res.status !== 200) { console.error(`[naze] GPT translate error`); return sentences; }
            const data = JSON.parse(res.body);
            const parsed = JSON.parse(data.choices[0].message.content);
            return (parsed.sentences || sentences).map(s => String(s).replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
        };

        let viSentences, targetSentences;

        if (viText && srcTranscript.lang === targetLang) {
            // Có cả vi và target
            viSentences = await smoothSub(parseSrtText(viText), 'vi');
            targetSentences = await smoothSub(parseSrtText(srcText), targetLang);
        } else if (srcTranscript.lang === 'vi') {
            // Gốc là vi
            viSentences = await smoothSub(parseSrtText(srcText), 'vi');
            targetSentences = targetLang === 'vi' ? viSentences : await translateSentences(viSentences, 'vi', targetLang);
        } else {
            // Gốc là ngôn ngữ khác
            const detectedLang = srcTranscript.lang;
            const rawSents = await smoothSub(parseSrtText(srcText), detectedLang);
            if (targetLang === detectedLang) {
                targetSentences = rawSents;
            } else {
                targetSentences = await translateSentences(rawSents, detectedLang, targetLang);
            }
            viSentences = viText
                ? await smoothSub(parseSrtText(viText), 'vi')
                : await translateSentences(rawSents, detectedLang, 'vi');
        }

        // Căn chỉnh độ dài
        const maxLen = Math.max(viSentences.length, targetSentences.length);
        rawSentences = Array.from({ length: maxLen }, (_, i) => ({
            vi: viSentences[i] || viSentences[viSentences.length - 1] || '',
            target: targetSentences[i] || targetSentences[targetSentences.length - 1] || ''
        }));
        postTitleVi = projectId;
        console.log(`[naze] YouTube done: ${rawSentences.length} sentences`);
    } else {
        const topic = mode;
        projectId = args[1];
        targetLang = args[2] || 'vi';
        if (!topic || !projectId) { console.error('Usage: node naze_content.js <topic> <projectId> [targetLang]'); process.exit(1); }
        console.log(`[naze] Topic: ${topic} | Lang: ${targetLang}`);
    }

    const result = rawSentences ? null : await generateContent(mode, targetLang);
    if (result) { rawSentences = result.sentences; postTitleVi = result.title_vi || result.title; }

    const db = await getDb();
    await db.run('INSERT OR IGNORE INTO Post (project_id, title, status, voice_content_type, target_lang) VALUES (?, ?, ?, ?, ?)',
        [projectId, postTitleVi || projectId, 'crawling', targetLang === 'vi' ? 'content_vi' : 'content', targetLang]);
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;

    const paragraphIds = [];
    for (const [i, s] of rawSentences.entries()) {
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
    console.log(`[naze] ✅ Đã lưu ${rawSentences.length} câu vào DB`);

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

        // Sinh image_suggestion bằng GPT-4o-mini
        try {
            const sugRes = await httpsPost(
                'https://api.openai.com/v1/chat/completions',
                { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
                {
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: 'You are an image/video suggestion expert. Read the given text and return a JSON array of Vietnamese search terms (5-8 terms) describing visuals that would illustrate the content. Return ONLY a JSON array, no explanation. Example: ["bầu trời đầy sao", "vũ trụ nhìn từ không gian", "trái đất từ vệ tinh"]' },
                        { role: 'user', content: text }
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

        const imgDir = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', String(index));
        const vidDir = path.join(MEDIA_DIR, projectId, 'assets', '_raw_videos', String(index));
        const { mkdirSync, existsSync, readdirSync } = await import('fs');
        if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });
        if (!existsSync(vidDir)) mkdirSync(vidDir, { recursive: true });

        const syncDir = async (dir, type, exts) => {
            if (!existsSync(dir)) return;
            for (const file of readdirSync(dir)) {
                if (!exts.includes(path.extname(file).toLowerCase())) continue;
                const rel = path.relative(MEDIA_DIR, path.join(dir, file));
                const ex = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                if (!ex) await db.run('INSERT INTO Asset (paragraph_id, type, file_path) VALUES (?, ?, ?)', [paragraphId, type, rel]);
            }
        };

        // Chạy tuần tự, sync DB ngay sau mỗi keyword
        for (const kw of keywords) {
            await Promise.allSettled([
                fetchFromGoogleImageBot(kw, 'image', imgDir, IMAGES_PER_KEYWORD).then(n => console.log(`      [${kw}] ${n} images`)).catch(e => console.error(`      [${kw}] img loi: ${e.message}`)),
                fetchFromStoryblocksBot(kw, 'video', vidDir, 4).then(n => console.log(`      [${kw}] ${n} videos`)).catch(() => {}),
            ]);
            await syncDir(imgDir, 'image', ['.jpg', '.jpeg', '.png', '.webp']);
            await syncDir(vidDir, 'video', ['.mp4', '.mov']);
        }
    }

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    console.log('\n[naze] ✅ Hoàn thành!');
}

main().catch(e => { console.error('[naze] LỖI:', e.message); process.exit(1); });
