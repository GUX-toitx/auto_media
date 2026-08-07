import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { crawlKeywordImageRotate } from '../crawlers/imageCrawlRotate.js';

const OPENAI_KEY = process.env.OPENAI_KEY;
const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const IMAGES_PER_KEYWORD = 6;

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

async function getKeywordsFromGPT(sentence) {
    const res = await httpsPost(
        'https://api.openai.com/v1/chat/completions',
        { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        {
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a football image search expert. Given a Vietnamese sports commentary sentence, return exactly 4 specific English Bing image search queries that will return real football photos. Each query must contain a specific player name, team name, or match name. Never use generic terms. Return ONLY a raw JSON array, no explanation. Example: ["Kevin De Bruyne Belgium training", "Romelu Lukaku goal", "Belgium national team 2024", "Jeremy Doku dribbling"]'
                },
                { role: 'user', content: sentence }
            ],
            temperature: 0.3
        }
    );
    if (res.status !== 200) throw new Error(`GPT lỗi: ${res.status}`);
    const data = JSON.parse(res.body);
    let content = data.choices?.[0]?.message?.content || '[]';
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) return parsed.slice(0, 4);
        const val = Object.values(parsed)[0];
        return Array.isArray(val) ? val.slice(0, 4) : [sentence.slice(0, 60)];
    } catch {
        const match = content.match(/\[.*?\]/s);
        if (match) try { return JSON.parse(match[0]).slice(0, 4); } catch(_) {}
        return [sentence.slice(0, 60)];
    }
}

async function main() {
    const args = process.argv.slice(2);
    const postId = parseInt(args[0]);
    const projectId = args[1];

    if (!postId || !projectId) {
        console.error('Usage: node sports_retry.js <postId> <projectId>');
        process.exit(1);
    }

    const db = await getDb();
    const missing = await db.all(
        'SELECT p.id, p.content, p."order" FROM Paragraph p WHERE p.post_id = ? AND NOT EXISTS (SELECT 1 FROM Keyword k WHERE k.paragraph_id = p.id) ORDER BY p."order"',
        [postId]
    );
    console.log(`[retry] ${missing.length} câu chưa có keyword`);

    await db.run('UPDATE Post SET status = ? WHERE id = ?', ['crawling', postId]);

    for (const { id: paragraphId, content: text, order: index } of missing) {
        console.log(`\n[${index}] "${text.slice(0, 60)}..."`);

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

        const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(0), ms))]);
        await Promise.all(keywords.map((kw, i) => {
            console.log(`    -> Crawl: "${kw}"`);
            return withTimeout(
                crawlKeywordImageRotate(kw, imgDir, i, IMAGES_PER_KEYWORD)
                    .then(got => console.log(`    -> ${got} ảnh (${kw})`))
                    .catch(e => console.error(`    -> Lỗi: ${e.message}`)),
                60000
            );
        }));

        const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
        if (fs.existsSync(imgDir)) {
            for (const file of fs.readdirSync(imgDir)) {
                if (!imageExts.has(path.extname(file).toLowerCase())) continue;
                const rel = path.join(projectId, 'assets', '_raw_images', String(index), file);
                const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [rel]);
                if (!exists) await db.run('INSERT INTO Asset (paragraph_id, type, file_path) VALUES (?, ?, ?)', [paragraphId, 'image', rel]);
            }
        }
    }

    await db.run('UPDATE Post SET status = NULL WHERE id = ?', [postId]);
    await db.close();
    console.log('\n[retry] ✅ Hoàn thành!');
}

main().catch(e => { console.error('[retry] LỖI:', e.message); process.exit(1); });
