import { fetchFromBingImageBot } from './bingImageCrawler.js';
import { fetchFromGoogleImageBot } from './googleImageCrawler.js';
import { logCrawlError, setLogProjectFromDir } from '../lib/crawlLogger.js';

// Crawl ảnh cho 1 keyword, XOAY VÒNG nguồn theo idx:
//   idx chẵn (0,2,4...) -> Bing trước ; idx lẻ (1,3,5...) -> Google trước.
// Nếu nguồn chính trả 0 ảnh thì thử nốt nguồn còn lại để cảnh không bị trống.
export async function crawlKeywordImageRotate(kw, folder, idx = 0, perSource = 8) {
    setLogProjectFromDir(folder); // log tách theo dự án (suy ra từ đường dẫn thư mục)
    const bing = () => fetchFromBingImageBot(kw, 'image', folder, perSource)
        .catch(e => { console.error(`[crawl][Bing] ${e.message}`); logCrawlError({ source: 'Bing Image (Bot)', keyword: kw, reason: e.message }); return 0; });
    const google = () => fetchFromGoogleImageBot(kw, 'image', folder, perSource)
        .catch(e => { console.error(`[crawl][Google] ${e.message}`); logCrawlError({ source: 'Google Image (Bot)', keyword: kw, reason: e.message }); return 0; });
    const [primary, secondary] = idx % 2 === 0 ? [bing, google] : [google, bing];
    let got = await primary();
    if (!got) got = await secondary();
    return got;
}
