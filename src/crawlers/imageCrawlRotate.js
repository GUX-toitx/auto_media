import { fetchFromBingImageBot } from './bingImageCrawler.js';
import { fetchFromGoogleImageBot } from './googleImageCrawler.js';
import { logCrawlError, setLogProjectFromDir } from '../lib/crawlLogger.js';

// Crawl ảnh cho 1 keyword, XOAY VÒNG nguồn theo idx:
//   idx chẵn (0,2,4...) -> Bing trước ; idx lẻ (1,3,5...) -> Google trước.
// Nguồn chính lấy THIẾU (kể cả 0 ảnh) thì gọi nốt nguồn còn lại để BÙ cho đủ, không để cảnh trống.
// Google trả 0 ảnh liên tiếp bao nhiêu lần thì coi như CHẾT và ngừng gọi trong phiên này.
// Đã kiểm chứng: google-img-scrap parse theo HTML cũ của Google, giờ trả result:[] cho MỌI keyword
// mà KHÔNG ném lỗi — log chỉ thấy "Tìm được 0 ảnh". Mỗi keyword lẻ phí ~4 giây rồi mới rơi sang Bing.
const GOOGLE_DEAD_AFTER = 5;
let googleZeroStreak = 0;
let googleDeadWarned = false;

// Hạn giờ RIÊNG cho từng nguồn. Trước đây chỉ có 1 hạn giờ 60s bọc cả keyword ở phía worker:
// Google treo (google-img-scrap không có timeout) là ăn hết 60s -> Bing không bao giờ được gọi
// -> keyword trắng ảnh. Có hạn giờ riêng thì nguồn nào treo cũng chỉ mất phần của nó.
const GOOGLE_TIMEOUT_MS = Number(process.env.IMG_GOOGLE_TIMEOUT_MS || 20000);
const BING_TIMEOUT_MS = Number(process.env.IMG_BING_TIMEOUT_MS || 45000);
const BING_RETRY_DELAY_MS = Number(process.env.IMG_BING_RETRY_DELAY_MS || 3000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Chạy 1 nguồn với hạn giờ; quá giờ thì coi như 0 ảnh và đi tiếp (phần đang tải dở vẫn rơi vào thư mục,
// worker sync ảnh sau mỗi keyword nên không mất). clearTimeout để timer không giữ tiến trình sống.
async function withTimeout(run, ms, source, kw) {
    let timer;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            const reason = `quá ${Math.round(ms / 1000)}s chưa xong → bỏ dở, chuyển sang nguồn còn lại`;
            console.error(`[crawl][${source}] ⏱ "${kw}": ${reason}`);
            logCrawlError({ source, keyword: kw, reason });
            resolve(0);
        }, ms);
    });
    try { return await Promise.race([run(), timeout]); }
    finally { clearTimeout(timer); }
}

export async function crawlKeywordImageRotate(kw, folder, idx = 0, perSource = 8) {
    setLogProjectFromDir(folder); // log tách theo dự án (suy ra từ đường dẫn thư mục)

    const bing = (need = perSource) => withTimeout(
        () => fetchFromBingImageBot(kw, 'image', folder, need)
            .catch(e => { console.error(`[crawl][Bing] ${e.message}`); logCrawlError({ source: 'Bing Image (Bot)', keyword: kw, reason: e.message }); return 0; }),
        BING_TIMEOUT_MS, 'Bing Image (Bot)', kw
    );

    const google = (need = perSource) => withTimeout(
        async () => {
            if (googleZeroStreak >= GOOGLE_DEAD_AFTER) return 0;   // đã chết -> bỏ qua, khỏi phí thời gian
            const n = await fetchFromGoogleImageBot(kw, 'image', folder, need)
                .catch(e => { console.error(`[crawl][Google] ${e.message}`); logCrawlError({ source: 'Google Image (Bot)', keyword: kw, reason: e.message }); return 0; });
            if (n > 0) { googleZeroStreak = 0; return n; }
            googleZeroStreak++;
            if (googleZeroStreak >= GOOGLE_DEAD_AFTER && !googleDeadWarned) {
                googleDeadWarned = true;
                const msg = `Google Images trả 0 ảnh ${GOOGLE_DEAD_AFTER} lần liên tiếp → COI NHƯ HỎNG, ngừng gọi trong phiên này (thư viện google-img-scrap nhiều khả năng đã lỗi thời). Từ giờ chỉ còn Bing.`;
                console.error(`[crawl][Google] ⛔ ${msg}`);
                logCrawlError({ source: 'Google Image (Bot)', keyword: kw, reason: msg });
            }
            return 0;
        },
        GOOGLE_TIMEOUT_MS, 'Google Image (Bot)', kw
    );

    const [primary, secondary] = idx % 2 === 0 ? [bing, google] : [google, bing];
    let got = await primary();

    // BÙ NGUỒN: trước đây chỉ fallback khi nguồn chính trả ĐÚNG 0 ảnh, nên Google lấy được 1-2 ảnh
    // rồi hụt là cảnh cứ thiếu ảnh mãi. Giờ thiếu bao nhiêu thì gọi nguồn kia lấy đúng bấy nhiêu.
    if (got < perSource) {
        const need = perSource - got;
        console.log(`      ["${kw}"] nguồn chính mới được ${got}/${perSource} ảnh → bù ${need} ảnh từ nguồn còn lại`);
        got += await secondary(need);
    }

    // Cả 2 nguồn cùng trắng tay: Google coi như đã chết hẳn nên chỉ còn Bing để cứu. Lỗi Bing hay gặp
    // là HTTP 429 / timeout lúc cào liên tục nhiều keyword — nghỉ vài giây rồi thử lại thường ăn.
    if (got === 0) {
        console.warn(`      ["${kw}"] cả Google lẫn Bing đều 0 ảnh → nghỉ ${BING_RETRY_DELAY_MS / 1000}s rồi thử lại Bing`);
        await sleep(BING_RETRY_DELAY_MS);
        got = await bing();
    }

    if (got === 0) {
        logCrawlError({ source: 'imageCrawlRotate', keyword: kw, reason: 'KHÔNG lấy được ảnh nào từ cả Google lẫn Bing (đã thử lại Bing 1 lần)' });
        console.error(`      ["${kw}"] ❌ vẫn 0 ảnh sau khi thử hết nguồn`);
    }
    return got;
}
