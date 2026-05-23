import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import 'dotenv/config';
import https from 'https';
import http from 'http';
import path from 'path';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const BASE_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || '/usr/gux/media-team/db';
const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');
const OPENAI_KEY = process.env.OPENAI_KEY;
const PORT = process.env.PORT || 3000;

const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

const args = process.argv.slice(2);
const projectId = args[args.indexOf('--projectId') + 1];
const contentArg = args[args.indexOf('--content') + 1];
const sourcesArg = args[args.indexOf('--sources') + 1] || '';
const targetLang = args[args.indexOf('--targetLang') + 1] || 'en';
const sources = sourcesArg ? sourcesArg.split('|').join(', ') : 'Reuters, AP, BBC, CNN, DW, Al Jazeera, NATO';

if (!projectId || !contentArg) {
    console.error('[process_content] Thiếu --projectId hoặc --content');
    process.exit(1);
}


async function translateText(text, lang) {
    if (!lang || lang === 'vi') return text;
    const res = await httpsPost(
        'https://api.openai.com/v1/chat/completions',
        { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: `Translate to ${lang}. Return ONLY translated text, no explanation.` },
                { role: 'user', content: text }
            ],
            temperature: 0.2
        }
    );
    if (res.status !== 200) return text;
    const data = JSON.parse(res.body);
    return data.choices?.[0]?.message?.content?.trim() || text;
}

function httpsGet(url) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET', family: 4, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 };
        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location).then(resolve);
            }
            if (res.statusCode !== 200) return resolve(null);
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const data = JSON.stringify(body);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            family: 4,
            headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
        };
        const req = https.request(options, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function analyzeWithGPT5(topic, sources) {
    const schema = {
        type: 'object',
        properties: {
            tieu_de: { type: 'string' },
            mo_bai: { type: 'string' },
            tom_tat: { type: 'string' },
            luan_diem: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        tieu_de_luan_diem: { type: 'string' },
                        noi_dung_luan_diem: { type: 'string' },
                        luan_cu: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    tieu_de_luan_cu: { type: 'string' },
                                    noi_dung_luan_cu: { type: 'string' },
                                    anh: { type: 'array', items: { type: 'string' } },
                                    video: { type: 'array', items: { type: 'string' } },
                                    nguon: { type: 'array', items: { type: 'string' } }
                                },
                                required: ['tieu_de_luan_cu', 'noi_dung_luan_cu', 'anh', 'video', 'nguon'],
                                additionalProperties: false
                            }
                        }
                    },
                    required: ['tieu_de_luan_diem', 'noi_dung_luan_diem', 'luan_cu'],
                    additionalProperties: false
                }
            },
            ket_luan: { type: 'string' }
        },
        required: ['tieu_de', 'mo_bai', 'tom_tat', 'luan_diem', 'ket_luan'],
        additionalProperties: false
    };

    const input = `Hãy phân tích cho tôi sự kiện ${topic} mới nhất. Viết theo phong cách bình luận thời sự chuyên sâu. Chia luận điểm và luận cứ rõ ràng. Mỗi luận cứ cần có 2 ảnh + 2 video minh họa bằng URL trực tiếp chính xác. Ưu tiên ${sources} và YouTube chính thức. Chỉ trả về JSON hợp lệ, không markdown, không giải thích thêm.`;

    console.log(`[process_content] Gọi GPT-5 Responses API cho: ${topic}`);

    const res = await httpsPost(
        'https://api.openai.com/v1/responses',
        {
            'Authorization': `Bearer ${OPENAI_KEY}`,
            'Content-Type': 'application/json'
        },
        {
            model: 'gpt-5',
            reasoning: { effort: 'medium' },
            max_output_tokens: 40000,
            tools: [{ type: 'web_search_preview' }],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'phan_tich_dia_chinh_tri',
                    schema,
                    strict: true
                }
            },
            input
        }
    );

    if (res.status !== 200) {
        throw new Error(`GPT-5 API lỗi: ${res.status} ${res.body}`);
    }

    const data = JSON.parse(res.body);
    const outputText = data.output?.find(o => o.type === 'message')
        ?.content?.find(c => c.type === 'output_text')?.text;

    if (!outputText) throw new Error('Không lấy được output từ API: ' + JSON.stringify(data).slice(0, 200));
    
    // Log output GPT để phân tích
    console.log('[process_content] === GPT OUTPUT ===');
    console.log(outputText);
    console.log('[process_content] === END GPT OUTPUT ===');
    
    return JSON.parse(outputText);
}

async function saveToDb(projectId, result) {
    const db = await getDb();
    const postTitle = projectId;

    await db.run('INSERT OR IGNORE INTO Post (title) VALUES (?)', [postTitle]);
    await db.run('UPDATE Post SET status = ? WHERE title = ?', ['crawling', postTitle]);

    // Notify dashboard
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
        .end(JSON.stringify({ postTitle, status: 'crawling' }));

    const post = await db.get('SELECT id FROM Post WHERE title = ?', [postTitle]);
    const postId = post.id;

    // Lưu tieu_de, mo_bai, tom_tat
    const mo_bai_translated = await translateText(result.mo_bai, targetLang);
    const tom_tat_translated = await translateText(result.tom_tat, targetLang);
    await db.run(
        'UPDATE Post SET tieu_de = ?, mo_bai = ?, mo_bai_vi = ?, tom_tat = ?, tom_tat_vi = ? WHERE id = ?',
        [result.tieu_de, mo_bai_translated, result.mo_bai, tom_tat_translated, result.tom_tat, postId]
    );

    let sentenceOrder = 0;
    await db.run('BEGIN TRANSACTION');
    try {
        for (let i = 0; i < result.luan_diem.length; i++) {
            const cau = result.luan_diem[i];
            // Paragraph = Luận điểm
            // content = noi_dung đã dịch (ngôn ngữ đích)
            // original_content = noi_dung tiếng Việt
            // audio field không dùng, dùng Keyword để lưu tieu_de
            const paraContentTranslated = await translateText(cau.noi_dung_luan_diem, targetLang);
            const paraTitleTranslated = await translateText(cau.tieu_de_luan_diem, targetLang);
            const paraRes = await db.run(
                'INSERT INTO Paragraph (post_id, content, original_content, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                [postId, paraContentTranslated, cau.noi_dung_luan_diem, paraTitleTranslated, cau.tieu_de_luan_diem, i + 1]
            );
            const paragraphId = paraRes.lastID;

            // Tạo folder assets
            const gid = String(i + 1);
            const vFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_videos', gid);
            const iFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_images', gid);
            [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

            // Keyword = tieu_de_luan_diem (hiển thị trên UI như tag)
            await db.run('INSERT INTO Keyword (paragraph_id, content) VALUES (?, ?)', [paragraphId, cau.tieu_de_luan_diem]);

            // Mỗi luan_cu = 1 Sentence (không split câu)
            for (let j = 0; j < cau.luan_cu.length; j++) {
                const doan = cau.luan_cu[j];

                // Lưu metadata anh/video/nguon
                const metaPath = path.join(BASE_DIR, projectId, 'assets', `meta_${gid}_${j + 1}.json`);
                fs.writeFileSync(metaPath, JSON.stringify({ anh: doan.anh || [], video: doan.video || [], nguon: doan.nguon || [] }, null, 2));

                sentenceOrder++;
                const doanTranslated = await translateText(doan.noi_dung_luan_cu, targetLang);
                const doanTitleTranslated = await translateText(doan.tieu_de_luan_cu, targetLang);
                const sentenceRes = await db.run(
                    'INSERT INTO Sentence (paragraph_id, content, original_content, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                    [paragraphId, doanTranslated, doan.noi_dung_luan_cu, doanTitleTranslated, doan.tieu_de_luan_cu, sentenceOrder]
                );
                const sentenceId = sentenceRes.lastID;
                // Luu sentenceId de tai anh/video sau khi commit
                doan._sentenceId = sentenceId;
                doan._paragraphId = paragraphId;
                doan._gid = gid;
            }
        }
        await db.run('COMMIT');
        console.log(`[process_content] ✅ Đã lưu ${result.luan_diem.length} luận điểm vào DB`);
    } catch (e) {
        await db.run('ROLLBACK');
        throw e;
    }

    // Tải ảnh/video sau khi commit transaction
    for (let i = 0; i < result.luan_diem.length; i++) {
        const cau = result.luan_diem[i];
        const gid = String(i + 1);
        for (let j = 0; j < cau.luan_cu.length; j++) {
            const doan = cau.luan_cu[j];
            const sentenceId = doan._sentenceId;
            const paragraphId = doan._paragraphId;

                // Tải ảnh từ doan.anh
                for (let ai = 0; ai < (doan.anh || []).length; ai++) {
                    const url = doan.anh[ai];
                    if (!url || !url.startsWith('http')) continue;
                    try {
                        const imgDir = path.join(BASE_DIR, projectId, 'assets', '_raw_images', gid);
                        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
                        const ext = url.includes('.png') ? 'png' : url.includes('.webp') ? 'webp' : 'jpg';
                        const fileName = `gpt_${j + 1}_${ai + 1}.${ext}`;
                        const savePath = path.join(imgDir, fileName);
                        const relativePath = path.join(projectId, 'assets', '_raw_images', gid, fileName);
                        const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [relativePath]);
                        if (!exists) {
                            const res = await httpsGet(url);
                            if (res) {
                                fs.writeFileSync(savePath, res);
                                await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, ?, ?, ?)', [paragraphId, sentenceId, 'image', relativePath]);
                                console.log(`[process_content] Ảnh ${ai + 1} của luận cứ ${j + 1} đã lưu`);
                            }
                        }
                    } catch(e) { console.log(`[process_content] Lỗi tải ảnh: ${e.message}`); }
                }

                // Tải video từ doan.video
                for (let vi = 0; vi < (doan.video || []).length; vi++) {
                    const url = doan.video[vi];
                    if (!url || !url.startsWith('http')) continue;
                    try {
                        const vidDir = path.join(BASE_DIR, projectId, 'assets', '_raw_videos', gid);
                        if (!fs.existsSync(vidDir)) fs.mkdirSync(vidDir, { recursive: true });
                        const fileName = `gpt_${j + 1}_${vi + 1}.mp4`;
                        const savePath = path.join(vidDir, fileName);
                        const relativePath = path.join(projectId, 'assets', '_raw_videos', gid, fileName);
                        const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [relativePath]);
                        if (!exists) {
                            const res = await httpsGet(url);
                            if (res && res.length > 50 * 1024) {
                                fs.writeFileSync(savePath, res);
                                await db.run('INSERT INTO Asset (paragraph_id, sentence_id, type, file_path) VALUES (?, ?, ?, ?)', [paragraphId, sentenceId, 'video', relativePath]);
                                console.log(`[process_content] Video ${vi + 1} của luận cứ ${j + 1} đã lưu`);
                            }
                        }
                    } catch(e) { console.log(`[process_content] Lỗi tải video: ${e.message}`); }
                }
        }
    }

    // Lưu tóm tắt
    const summaryPath = path.join(BASE_DIR, projectId, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        tieu_de: result.tieu_de,
        mo_bai: result.mo_bai,
        tom_tat: result.tom_tat,
        ket_luan: result.ket_luan
    }, null, 2));

    await db.run('UPDATE Post SET status = NULL WHERE title = ?', [postTitle]);
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
        .end(JSON.stringify({ postTitle, status: null }));

    await db.close();
    console.log(`[process_content] ✅ Hoàn thành project: ${projectId}`);
}

try {
    const result = await analyzeWithGPT5(contentArg, sources);
    console.log(`[process_content] GPT-5 trả về ${result.luan_diem?.length || 0} luận điểm`);
    await saveToDb(projectId, result);
    process.exit(0);
} catch (e) {
    console.error('[process_content] LỖI:', e.message);
    process.exit(1);
}
