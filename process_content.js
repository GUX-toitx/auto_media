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
            tieu_de: { type: 'string' },
            mo_bai_vi: { type: 'string' },
            mo_bai_target: { type: 'string' },
            luan_diem: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        tieu_de_vi: { type: 'string' },
                        tieu_de_target: { type: 'string' },
                        noi_dung_vi: { type: 'string' },
                        noi_dung_target: { type: 'string' },
                        luan_cu: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    tieu_de_vi: { type: 'string' },
                                    tieu_de_target: { type: 'string' },
                                    noi_dung_vi: { type: 'string' },
                                    noi_dung_target: { type: 'string' },
                                    anh: { type: 'array', items: { type: 'string' } },
                                    video: { type: 'array', items: { type: 'string' } },
                                    nguon: { type: 'array', items: { type: 'string' } }
                                },
                                required: ['tieu_de_vi', 'tieu_de_target', 'noi_dung_vi', 'noi_dung_target', 'anh', 'video', 'nguon'],
                                additionalProperties: false
                            }
                        }
                    },
                    required: ['tieu_de_vi', 'tieu_de_target', 'noi_dung_vi', 'noi_dung_target', 'luan_cu'],
                    additionalProperties: false
                }
            },
            ket_bai_vi: { type: 'string' },
            ket_bai_target: { type: 'string' },
            tom_tat_vi: { type: 'string' },
            tom_tat_target: { type: 'string' },
        },
        required: [
            'tieu_de',
            'mo_bai_vi',
            'mo_bai_target',
            'luan_diem',
            'ket_bai_vi',
            'ket_bai_target',
            'tom_tat_vi',
            'tom_tat_target',
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
        'MO BAI:',
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
        '- Moi noi_dung_vi va noi_dung_target phai du chi tiet de dung thanh mot doan voice-over cinematic.',
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
        'MEDIA:',
        '- Trong moi luan_cu, voi MOI nguon duoc su dung phai lay:',
        '  + 2 URL anh',
        '  + 2 URL video footage',
        '- Nghia la moi nguon rieng le deu phai co du 2 anh va 2 video.',
        '- Footage va hinh anh phai sat voi noi dung dang duoc nhac toi.',
        '- Media phai co cam giac dang ho tro ke chuyen, khong chi minh hoa thong tin.',
        '- Uu tien footage co tinh cinematic va mang cam giac geopolitical documentary.',
        '- Uu tien footage satellite, ban do, drone, trade route, military movement, summit, port, skyline va global logistics.',
        '- Uu tien shutterstock, storyblock, Reuters, AP, AFP, BBC, DW, CNA, Bloomberg, Al Jazeera, CNBC, VnExpress, Bao VietNamNet, Bao Thanh Nien, Bao Tuoi Tre, Bao Nhan Dan va official YouTube.',
        '',
        'KET BAI:',
        '- BAT BUOC phai co phan ket_bai_vi va ket_bai_target rieng.',
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

    await db.run('INSERT OR IGNORE INTO Post (title) VALUES (?)', [postTitle]);
    await db.run('UPDATE Post SET status = ? WHERE title = ?', ['crawling', postTitle]);

    // Notify dashboard
    http.request({ hostname: 'localhost', port: PORT, path: '/api/crawl-status/notify', method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {})
        .end(JSON.stringify({ postTitle, status: 'crawling' }));

    const post = await db.get('SELECT id FROM Post WHERE title = ?', [postTitle]);
    const postId = post.id;

    // Lưu tieu_de, mo_bai, tom_tat, ket_bai - GPT đã sinh song ngữ sẵn
    await db.run(
        'UPDATE Post SET tieu_de = ?, mo_bai = ?, mo_bai_vi = ?, tom_tat_vi = ?, tom_tat_target = ?, ket_bai_vi = ?, ket_bai_target = ? WHERE id = ?',
        [stripLinks(result.tieu_de), stripLinks(result.mo_bai_target), stripLinks(result.mo_bai_vi),
         stripLinks(result.tom_tat_vi), stripLinks(result.tom_tat_target),
         stripLinks(result.ket_bai_vi), stripLinks(result.ket_bai_target), postId]
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
            const paraRes = await db.run(
                'INSERT INTO Paragraph (post_id, content, content_vi, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                [postId, stripLinks(cau.noi_dung_target), stripLinks(cau.noi_dung_vi), stripLinks(cau.tieu_de_target), stripLinks(cau.tieu_de_vi), i + 1]
            );
            const paragraphId = paraRes.lastID;

            // Tạo folder assets
            const gid = String(i + 1);
            const vFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_videos', gid);
            const iFolder = path.join(BASE_DIR, projectId, 'assets', '_raw_images', gid);
            [vFolder, iFolder].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

            // Keyword = tieu_de_luan_diem (hiển thị trên UI như tag)
            await db.run('INSERT INTO Keyword (paragraph_id, content) VALUES (?, ?)', [paragraphId, cau.tieu_de_vi]);

            // Mỗi luan_cu = 1 Sentence (không split câu)
            for (let j = 0; j < cau.luan_cu.length; j++) {
                const doan = cau.luan_cu[j];

                // Lưu metadata anh/video/nguon
                const metaPath = path.join(BASE_DIR, projectId, 'assets', `meta_${gid}_${j + 1}.json`);
                fs.writeFileSync(metaPath, JSON.stringify({ anh: doan.anh || [], video: doan.video || [], nguon: doan.nguon || [] }, null, 2));

                sentenceOrder++;
                const sentenceRes = await db.run(
                    'INSERT INTO Sentence (paragraph_id, content, content_vi, title, title_vi, "order") VALUES (?, ?, ?, ?, ?, ?)',
                    [paragraphId, stripLinks(doan.noi_dung_target), stripLinks(doan.noi_dung_vi), stripLinks(doan.tieu_de_target), stripLinks(doan.tieu_de_vi), sentenceOrder]
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
        mo_bai_vi: result.mo_bai_vi,
        mo_bai_target: result.mo_bai_target
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
