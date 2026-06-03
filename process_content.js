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

function stripLinks(text) {
    if (!text) return text;
    // Xoa markdown links: [text](url) -> text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Xoa trich dan cuoi cau: ([apnews.com](url)) hoac ([bloomberg.com])
    text = text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '');
    text = text.replace(/\s*\[\([^\]]*\)\]/g, '');
    text = text.replace(/\s*\(\[[^\]]*\]\)/g, '');
    // Xoa bare URLs
    text = text.replace(/https?:\/\/[^\s\)\"\']*/g, '');
    // Xoa ten domain trong ngoac: (apnews.com) (e.vnexpress.net) (en.sggp.org.vn)
    text = text.replace(/\s*\([a-zA-Z0-9][a-zA-Z0-9\-\.]*\.[a-zA-Z]{2,}\)/g, '');
    // Xoa tien to dau dong: Boi canh: / Dat van de: / Moi y: ...
    text = text.replace(/^(Bối cảnh( chung)?|Đặt vấn đề|Vấn đề|Mối ý|Ý mới|Ý nghĩa|Ý chính|Mở đầu|Dẫn nhập|Tóm lược|Kết luận|Phân tích|Nhận định|Bản chất|Hệ quả|Tác động|Thực trạng|Nguyên nhân|Diễn biến|Tổng quan|Luận điểm|Luận cứ|Kết quả|Giải pháp|Thách thức|Cơ hội|Rủi ro|Xu hướng|Bải học|Khái quát|Giới thiệu|Nhận xét|Tóm tắt|Nhìn lại|Tiếp theo|Trước tiên|Thứ nhất|Thứ hai|Thứ ba|Cuối cùng)\s*:\s*/gim, '');
    // Xoa khoang trang thua
    text = text.replace(/\s{2,}/g, ' ').trim();
    return text;
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
        try {
            const urlObj = new URL(url);
            const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET', family: 4, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 };
            const req = https.request(options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const location = res.headers.location;
                    // Handle relative redirect
                    const redirectUrl = location.startsWith('http') ? location : `${urlObj.protocol}//${urlObj.hostname}${location}`;
                    return httpsGet(redirectUrl).then(resolve);
                }
                if (res.statusCode !== 200) return resolve(null);
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        } catch(e) {
            resolve(null);
        }
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
            title: { type: 'string' },
            hook_vi: { type: 'string' },
            hook_target: { type: 'string' },
            hook_keywords_factual: { type: 'array', items: { type: 'string' } },
            hook_keywords_cinematic: { type: 'array', items: { type: 'string' } },
            luan_diem: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        title_vi: { type: 'string' },
                        title_target: { type: 'string' },
                        content_vi: { type: 'string' },
                        content_target: { type: 'string' },
                        keywords_factual: { type: 'array', items: { type: 'string' } },
                        keywords_cinematic: { type: 'array', items: { type: 'string' } },
                        luan_cu: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    title_vi: { type: 'string' },
                                    title_target: { type: 'string' },
                                    content_vi: { type: 'string' },
                                    content_target: { type: 'string' },
                                    keywords_factual: { type: 'array', items: { type: 'string' } },
                                    keywords_cinematic: { type: 'array', items: { type: 'string' } }
                                },
                                required: ['title_vi', 'title_target', 'content_vi', 'content_target', 'keywords_factual', 'keywords_cinematic'],
                                additionalProperties: false
                            }
                        }
                    },
                    // Đã xóa image và video khỏi required
                    required: ['title_vi', 'title_target', 'content_vi', 'content_target', 'keywords_factual', 'keywords_cinematic', 'luan_cu'],
                    additionalProperties: false
                }
            },
            conclusion_vi: { type: 'string' },
            conclusion_target: { type: 'string' },
            conclusion_keywords_factual: { type: 'array', items: { type: 'string' } },
            conclusion_keywords_cinematic: { type: 'array', items: { type: 'string' } },
            summary_vi: { type: 'string' },
            summary_target: { type: 'string' },
            summary_keywords_factual: { type: 'array', items: { type: 'string' } },
            summary_keywords_cinematic: { type: 'array', items: { type: 'string' } },
        },
        required: [
            'title',
            'hook_vi',
            'hook_target',
            'hook_keywords_factual',
            'hook_keywords_cinematic',
            'luan_diem',
            'conclusion_vi',
            'conclusion_target',
            'conclusion_keywords_factual',
            'conclusion_keywords_cinematic',
            'summary_vi',
            'summary_target',
            'summary_keywords_factual',
            'summary_keywords_cinematic',
        ],
        additionalProperties: false
    };

    const input = [
        'TAO NOI DUNG YOUTUBE DIA CHINH TRI THE GIOI THEO KIEU CINEMATIC STORYTELLING',
        '',
        'CHU DE: ' + topic,
        '',
        'MUC TIEU:',
        '- Tao bai phan tich dia chinh tri theo phong cach documentary YouTube hien dai.',
        '- Noi dung phai cuon, co chieu sau va giu retention cao.',
        '- Giong mot geopolitical documentary storytelling chuyen nghiep.',
        '- Nguoi xem phai cam thay dang theo doi mot ban co quyen luc thuc su.',
        '- Do dai tong the phai du de tao video voice-over khoang 8-10 phut.',
        '- Storytelling phai du nhiep do de giu retention trong suot video.',
        '',
        'PHONG CACH:',
        '- Viet theo phong cach cinematic geopolitical storytelling.',
        '- Giong narration voice-over documentary.',
        '- Storytelling phai co dong chay lien tuc nhu mot documentary narration.',
        '- Storytelling phai co nhip documentary: mo rong dan, dao sau dan va tang stakes tu nhien.',
        '- Chuyen doan va transition phai muot.',
        '- Dan dat tu nhien, khong gay cam giac AI.',
        '- Moi phan phai lien ket huu co voi phan truoc.',
        '- Moi transition phai tao cam giac co them mot lop su that dang duoc mo ra.',
        '- Moi doan phai ket thuc theo cach khien nguoi xem muon nghe tiep.',
        '- Transition phai tu nhien nhu dang ke chuyen.',
        '- Uu tien transition mang tinh doi lap, chien luoc hoac escalation.',
        '- Han che cac transition AI nhu:',
        '  "Khong chi vay", "Trong khi do", "Ben canh do", "Mot van de khac"...',
        '- Toan bo bai phai giu mot goc nhin narrative thong nhat tu dau toi cuoi.',
        '',
        'MO BAI: tuong ung voi hook_vi va hook_target',
        '- Mo bai ngan gon, vao thang van de.',
        '- Hook trong 2-4 cau dau.',
        '- Tao su to mo, tension hoac cam giac co mot dieu lon dang dien ra.',
        '- Sau hook phai vao ngay trung tam van de.',
        '- KHONG mo bai dai dong.',
        '',
        'GOC NHIN DIA CHINH TRI:',
        '- Moi su kien deu phai duoc nhin duoi goc nhin loi ich quoc gia.',
        '- Phan tich dong co chien luoc cua cac ben lien quan.',
        '- Chi ra ai dang huong loi, ai dang mat loi.',
        '- Lam ro tac dong kinh te, quan su, ngoai giao va anh huong khu vuc.',
        '- Dat moi dien bien vao buc tranh quyen luc lon hon.',
        '- Neu hop ly, hay chi ra hidden agenda hoac strategic signaling.',
        '',
        'NARRATIVE MODE:',
        '- Neu la chien tranh: tao tension, escalation, uncertainty.',
        '- Neu la ngoai giao: nhan manh timing, hidden signal, strategic balancing.',
        '- Neu la kinh te: nhan manh domino effect, supply chain, leverage.',
        '- Neu la trade route, cang bien, kenh dao: nhan manh strategic location va influence competition.',
        '- Neu la lien minh quan su: nhan manh balance of power.',
        '',
        'RETENTION:',
        '- Moi phan moi phai mo rong quy mo van de lon hon phan truoc.',
        '- Cu 2-3 doan phai co mot chi tiet bat ngo, nghich ly hoac cau hoi mo.',
        '- Tao cam giac tinh hinh dang am tham leo thang.',
        '- Storytelling phai co cam giac tinh hinh dang dan tro nen lon hon, phuc tap hon hoac nguy hiem hon qua tung phan.',
        '- Storytelling phai co duong cong escalation ro rang, moi phan sau phai tao cam giac stakes lon hon phan truoc.',
        '- Nhip van phai nhanh gon, khong dai dong.',
        '- Moi phan phai co cam giac dang dan nguoi xem di sau hon vao ban chat van de.',
        '- Moi phan phai tao cam giac day khong chi la mot su kien rieng le, ma la mot phan cua buc tranh quyen luc lon hon.',
        '',
        'TUYET DOI KHONG:',
        '- KHONG viet theo dang bao cao.',
        '- KHONG viet nhu sach giao khoa.',
        '- KHONG dien giai dai dong.',
        '- KHONG lap lai y.',
        '- KHONG bullet-point hoa noi dung.',
        '- KHONG dung van phong qua hoc thuat.',
        '- KHONG chen URL vao text.',
        '- KHONG viet theo kieu "giai thich cho nguoi xem".',
        '- KHONG dung giong van dang thuyet trinh.',
        '- KHONG tao cam giac AI dang phan tich tung muc rieng le.',
        '- KHONG bien moi su kien thanh khung hoang hoac chien tranh.',
        '- Giu giong dieu binh tinh, tham trong nhung dang ngai.',
        '- Han che an du, nhan hoa hoac van phong qua van chuong.',
        '- Uu tien geopolitical realism thay vi dramatic writing.',
        '- Han che dung dau "—", ";", "..." va cac dau cau mang tinh dramatic qua muc.',
        '',
        'CAU TRUC NOI DUNG:',
        '- Toan bai co 4-6 luan diem lon.',
        '- Moi luan diem phai duoc trien khai thanh mot narrative co setup, escalation, implication va consequence ro rang.',
        '- Moi luan diem phai duoc trien khai nhu mot dong narrative lien tuc.',
        '- Toan bo bai phai co cam giac nhu mot cau chuyen lien tuc thay vi cac muc tach roi.',
        '- Cac luan cu phai lien ket huu co va mo rong tu nhien tu y truoc.',
        '- Khong tao cam giac dang tach thanh cac muc rieng le.',
        '- Moi luan cu chi la mot lop thong tin moi duoc mo rong them trong cau chuyen.',
        '- Moi luan diem nen tao cam giac dang reveal them mot lop dong co, loi ich hoac chien luoc an sau.',
        '- Moi content_vi va content_target phai du chi tiet de dung thanh mot doan voice-over cinematic.',
        '- Khong viet qua ngan hoac ket luan qua som.',
        '- Moi luan diem phai dao sau vao dong co, phan ung va tac dong day chuyen.',
        '- Uu tien cau ngan, ro, cinematic va de voice-over.',
        '- Sau moi cau nen xuong dong de toi uu narration, subtitle va pacing cho voice-over.',
        '- Khong vong vo hay lap thong tin.',
        '- Moi luan diem phai co transition muot sang y tiep theo.',
        '',
        'YEU CAU PHAN TICH:',
        '- Khong chi noi dieu gi dang xay ra.',
        '- Phai giai thich:',
        '  + Vi sao no quan trong',
        '  + Dong co cua cac ben',
        '  + Ai dang huong loi',
        '  + Tac dong day chuyen',
        '  + Dieu gi co the xay ra tiep theo',
        '- Neu hop ly, hay phan tich hieu ung domino ma su kien nay co the gay ra.',
        '- Neu hop ly, hay phan tich vi sao su kien lai xay ra vao thoi diem nay.',
        '- Neu hop ly, hay lien ket voi trade route, chuoi cung ung, nang luong, an ninh khu vuc va canh tranh anh huong.',
        '- Neu hop ly, hay mo ta vi tri dia ly, trade route, khu vuc chien luoc hoac hanh lang anh huong de tao cam giac geopolitical.',
        '',
        'NGON NGU:',
        '- Viet song ngu dong thoi.',
        '- _vi = tieng Viet.',
        '- _target = ' + targetLang + '.',
        '',
        'MEDIA KEYWORDS:',
        '- Voi moi luan_diem va luan_cu, BAT BUOC phai tao 2 loai keyword tieng Anh tach biet de phuc vu he thong render tự động.',
        '- 1. keywords_factual: 3-5 tu khoa SỰ KIỆN THỰC TẾ de bot tim kiem tren bao chi (AP News, Reuters).',
        '  + CHI su dung danh tu rieng, ten chinh tri gia, dia danh, vu khi, hoac hanh dong the hien su kien.',
        '  + TUYET DOI KHONG dung tu mieu ta goc may, nghe thuat hay anh sang.',
        '  + Vi du ĐÚNG: "US Navy South China Sea", "Donald Trump press conference", "C-130J aircraft maintenance".',
        '  + Vi du SAI: "radar screen glow", "military warship cinematic".',
        '- 2. keywords_cinematic: 3-5 tu khoa B-ROLL NGHE THUAT de search tren Storyblocks/Envato.',
        '  + Mieu ta chi tiet goc may quay, cam xuc, boi canh hoac chi tiet dac ta mang tinh bieu tuong.',
        '  + Vi du: "radar screen glow macro", "satellite data flow animation", "politician shadow walking steadycam".',
        '- Tu khoa phai cuc ky sat voi noi dung cua tung luan_cu, khong duoc lay chung chung.',
        '- TUONG TU voi hook, conclusion, summary: cung phai co hook_keywords_factual, hook_keywords_cinematic,',
        '  conclusion_keywords_factual, conclusion_keywords_cinematic, summary_keywords_factual, summary_keywords_cinematic.',
        'KET BAI: tuong ung voi conclusion',
        '- BAT BUOC phai co phan conclusion_vi va conclusion_target rieng.',
        '- Ket bai chi can mot dong narrative tong ket, KHONG chia luan cu.',
        '- Ket bai phai tao du am va cam giac van de van dang tiep dien.',
        '- Co the ket bang cau hoi mo hoac du bao cho dien bien tiep theo.',
        '- Ket bai phai co cam giac documentary ket thuc nhung ban co van dang van dong.',
        '- Ket bai nen dua nguoi xem quay lai buc tranh quyen luc lon hon.',
        '- Cau cuoi cung cua ket bai nen keu goi nguoi xem like video, dang ky kenh va de lai y kien duoi phan binh luan mot cach tu nhien.',
        '- Ket bai KHONG duoc bi bo sot trong output cuoi.',
        '',
        'OUTPUT PHAI CAM GIAC NHU:',
        '- Mot documentary geopolitical hien dai.',
        '- Mot ban co quyen luc dang van dong.',
        '- Mot cuoc canh tranh anh huong dang am tham leo thang.',
        '- Khong chi la tin tuc, ma la cau chuyen cua chien luoc va loi ich.'
    ].join('\n');

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
    const usage = data.usage;
    console.log(`[process_content] 📊 Tokens - input: ${usage?.input_tokens}, output: ${usage?.output_tokens}, reasoning: ${usage?.output_tokens_details?.reasoning_tokens}`);
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

    await db.run('INSERT OR IGNORE INTO Post (project_id) VALUES (?)', [postTitle]);
    await db.run('UPDATE Post SET status = ? WHERE project_id = ?', ['crawling', postTitle]);

    // Notify dashboard
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
        .end(JSON.stringify({ postTitle, status: 'crawling' }));

    const post = await db.get('SELECT id FROM Post WHERE project_id = ?', [postTitle]);
    const postId = post.id;

    // Lưu title, hook, summary, conclusion - GPT đã sinh song ngữ sẵn
    await db.run(
        'UPDATE Post SET title = ?, hook = ?, hook_vi = ?, summary_vi = ?, summary_target = ?, conclusion_vi = ?, conclusion_target = ? WHERE id = ?',
        [stripLinks(result.title), stripLinks(result.hook_target), stripLinks(result.hook_vi),
         stripLinks(result.summary_vi), stripLinks(result.summary_target),
         stripLinks(result.conclusion_vi), stripLinks(result.conclusion_target), postId]
    );

    // Tách HookDetail
    const splitText = (text) => text ? text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean) : [];
    const hookViParts = splitText(stripLinks(result.hook_vi));
    const hookTargetParts = splitText(stripLinks(result.hook_target));
    const hookMaxLen = Math.max(hookViParts.length, hookTargetParts.length);
    for (let k = 0; k < hookMaxLen; k++) {
        await db.run(
            'INSERT INTO HookDetail (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, hookTargetParts[k] || null, hookViParts[k] || null, k + 1]
        );
    }

    // Tách SummaryDetail
    const summaryViParts = splitText(stripLinks(result.summary_vi));
    const summaryTargetParts = splitText(stripLinks(result.summary_target));
    const summaryMaxLen = Math.max(summaryViParts.length, summaryTargetParts.length);
    for (let k = 0; k < summaryMaxLen; k++) {
        await db.run(
            'INSERT INTO SummaryDetail (post_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
            [postId, summaryTargetParts[k] || null, summaryViParts[k] || null, k + 1]
        );
    }

    // Lưu keywords cho hook, conclusion, summary
    const savePostKeywords = async (section, factuals, cinematics) => {
        for (const kw of (factuals || [])) if (kw) await db.run('INSERT INTO Keyword (post_id, section, content, type) VALUES (?, ?, ?, ?)', [postId, section, kw, 'factual']);
        for (const kw of (cinematics || [])) if (kw) await db.run('INSERT INTO Keyword (post_id, section, content, type) VALUES (?, ?, ?, ?)', [postId, section, kw, 'cinematic']);
    };
    await savePostKeywords('hook', result.hook_keywords_factual, result.hook_keywords_cinematic);
    await savePostKeywords('conclusion', result.conclusion_keywords_factual, result.conclusion_keywords_cinematic);
    await savePostKeywords('summary', result.summary_keywords_factual, result.summary_keywords_cinematic);

    let sentenceOrder = 0;
    await db.run('BEGIN TRANSACTION');
    try {
        for (let i = 0; i < result.luan_diem.length; i++) {
            const cau = result.luan_diem[i];
            const paraRes = await db.run(
                'INSERT INTO Paragraph (post_id, content, content_vi, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                [postId, stripLinks(cau.content_target), stripLinks(cau.content_vi), stripLinks(cau.title_target), stripLinks(cau.title_vi), i + 1]
            );
            const paragraphId = paraRes.lastID;

            // Tách ParagraphDetail
            const splitText = (text) => text ? text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean) : [];
            const paraViParts = splitText(stripLinks(cau.content_vi));
            const paraTargetParts = splitText(stripLinks(cau.content_target));
            const paraMaxLen = Math.max(paraViParts.length, paraTargetParts.length);
            for (let k = 0; k < paraMaxLen; k++) {
                await db.run(
                    'INSERT INTO ParagraphDetail (paragraph_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
                    [paragraphId, paraTargetParts[k] || null, paraViParts[k] || null, k + 1]
                );
            }

            for (let j = 0; j < cau.luan_cu.length; j++) {
                const doan = cau.luan_cu[j];
                sentenceOrder++;
                const sentenceRes = await db.run(
                    'INSERT INTO Sentence (paragraph_id, content, content_vi, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                    [paragraphId, stripLinks(doan.content_target), stripLinks(doan.content_vi), stripLinks(doan.title_target), stripLinks(doan.title_vi), sentenceOrder]
                );
                const sentenceId = sentenceRes.lastID;
                doan._sentenceId = sentenceId;
                doan._paragraphId = paragraphId;

                // Tách câu theo dấu chấm/hỏi/chấm than và lưu SentenceDetail
                const splitText = (text) => text ? text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean) : [];
                const viParts = splitText(stripLinks(doan.content_vi));
                const targetParts = splitText(stripLinks(doan.content_target));
                const maxLen = Math.max(viParts.length, targetParts.length);
                for (let k = 0; k < maxLen; k++) {
                    await db.run(
                        'INSERT INTO SentenceDetail (sentence_id, content, content_vi, "order") VALUES (?, ?, ?, ?)',
                        [sentenceId, targetParts[k] || null, viParts[k] || null, k + 1]
                    );
                }
            }
            cau._paragraphId = paragraphId;
        }
        await db.run('COMMIT');
        console.log(`[process_content] ✅ Đã lưu ${result.luan_diem.length} luận điểm vào DB`);
    } catch (e) {
        await db.run('ROLLBACK');
        throw e;
    }

    // Lưu keywords
    for (const cau of result.luan_diem) {
        for (const kw of (cau.keywords_factual || []))
            if (kw) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [cau._paragraphId, kw, 'factual']);
        for (const kw of (cau.keywords_cinematic || []))
            if (kw) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [cau._paragraphId, kw, 'cinematic']);
        for (const doan of cau.luan_cu) {
            for (const kw of (doan.keywords_factual || []))
                if (kw) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [doan._paragraphId, kw, 'factual']);
            for (const kw of (doan.keywords_cinematic || []))
                if (kw) await db.run('INSERT INTO Keyword (paragraph_id, content, type) VALUES (?, ?, ?)', [doan._paragraphId, kw, 'cinematic']);
        }
    }
    const summaryPath = path.join(BASE_DIR, projectId, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
        title: result.title,
        hook_vi: result.hook_vi,
        hook_target: result.hook_target
    }, null, 2));

    await db.run('UPDATE Post SET status = NULL WHERE project_id = ?', [postTitle]);
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
