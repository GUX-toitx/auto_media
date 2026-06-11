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
    const res = await httpsPost(
        'https://api.openai.com/v1/chat/completions',
        { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a football image search expert. Given a Vietnamese sports commentary sentence, return exactly 6 specific English Bing image search queries that will return real football photos. Each query must contain a specific player name, team name, or match name. Never use generic terms. Return ONLY a raw JSON array, no explanation. Example: ["Kevin De Bruyne Belgium training", "Romelu Lukaku goal", "Belgium national team 2024", "Jeremy Doku dribbling"]'
                },
                { role: 'user', content: sentence }
            ],
            temperature: 0.3
        }
    );
    if (res.status !== 200) throw new Error(`GPT lỗi: ${res.status}`);
    const data = JSON.parse(res.body);
    let content = data.choices?.[0]?.message?.content || '[]';
    // Strip markdown code block nếu có
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return parsed.slice(0, 6);
        const val = Object.values(parsed)[0];
        return Array.isArray(val) ? val.slice(0, 6) : [sentence.slice(0, 60)];
    } catch {
        const match = content.match(/\[.*?\]/s);
        if (match) try { return JSON.parse(match[0]).slice(0, 6); } catch(_) {}
        return [sentence.slice(0, 60)];
    }
}

async function main() {
    const args = process.argv.slice(2);
    const srtPath = args[0];
    const projectId = args[1];
    const srtTranslatedPath = args[2] || null;
    const targetLang = args[3] || 'vi';

    if (!srtPath || !projectId) {
        console.error('Usage: node sports_srt.js <file.srt> <projectId> [file_translated.srt] [targetLang]');
        process.exit(1);
    }

    const sentences = parseSrt(srtPath);
    const translatedSentences = srtTranslatedPath ? parseSrt(srtTranslatedPath) : null;
    console.log(`[sports_srt] Đọc được ${sentences.length} câu từ ${srtPath}`);

    const db = await getDb();
    await db.run('INSERT OR IGNORE INTO Post (project_id, status, voice_content_type, target_lang) VALUES (?, ?, ?, ?)', [projectId, 'crawling', targetLang === 'vi' ? 'content_vi' : 'content', targetLang]);
    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [projectId]);
    const postId = post.id;

    // Bước 1: Lưu toàn bộ paragraph vào DB trước
    const paragraphIds = [];
    for (const { index, timecode, text } of sentences) {
        const translatedText = translatedSentences?.find(s => s.index === index)?.text || text;
        const paraRes = await db.run(
            'INSERT INTO Paragraph (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, translatedText, text, index]
        );
        const paragraphId = paraRes.lastID;
        await db.run(
            'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [paragraphId, translatedText, text, 1]
        );
        paragraphIds.push({ index, text, paragraphId });
    }
    console.log(`[sports_srt] ✅ Đã lưu ${sentences.length} câu vào DB`);

    // Bước 2: Crawl ảnh cho từng câu
    for (const { index, text, paragraphId } of paragraphIds) {
        console.log(`\n[${index}/${sentences.length}] "${text.slice(0, 60)}..."`);

        let keywords;
        try {
            keywords = await getKeywordsFromGPT(text);
            console.log(`    Keywords: ${keywords.join(' | ')}`);
        } catch (e) {
            console.error(`    GPT lỗi: ${e.message}`);
            continue;
        }

        for (const kw of keywords) {
            await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [paragraphId, kw, 'factual']);
        }

        const imgDir = path.join(MEDIA_DIR, projectId, 'assets', '_raw_images', String(index));
        fs.mkdirSync(imgDir, { recursive: true });

        for (const kw of keywords) {
            console.log(`    -> Crawl ảnh: "${kw}"`);
            try {
                const got = await fetchFromGoogleImageBot(kw, 'image', imgDir, IMAGES_PER_KEYWORD);
                console.log(`    -> Tải được: ${got} ảnh`);
            } catch (e) {
                console.error(`    -> Lỗi crawl: ${e.message}`);
            }
        }

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
