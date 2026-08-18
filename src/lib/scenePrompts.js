// ============================================================================
// TÁCH FILE PROMPT ẢNH AI (nhân vật + cảnh) THÀNH TỪNG MỤC
//
// Định dạng người dùng tự viết, mẫu ở prompts/contents/prompt.txt:
//
//     NHÂN VẬT
//
//     01. 김성호 · KIM SUNG-HO — 61 tuổi
//     Full-body character portrait of Kim Sung-ho, a 61-year-old...
//
//     02. 이정숙 · LEE JUNG-SOOK — 59 tuổi
//     ...
//
//     CẢNH
//
//     01. S001
//     Extreme close-up of an old smartphone screen...
//
// Luật đọc:
//   • Dòng tiêu đề khối: NHÂN VẬT / NHAN VAT / CHARACTERS  và  CẢNH / CANH / SCENES / SCENE.
//     Không có tiêu đề nào -> coi TẤT CẢ là cảnh.
//   • Dòng mở mục: bắt đầu bằng số thứ tự "01." / "1)" — phần còn lại của dòng là NHÃN.
//   • Các dòng sau tới mục kế tiếp là PROMPT (nối bằng dấu cách).
//   • Nhãn dài mà không có dòng nội dung nào theo sau -> chính nhãn đó là prompt (người dùng
//     viết liền một dòng), lúc đó nhãn rút gọn còn mấy chữ đầu để hiển thị.
//
// Nhân vật chạy TRƯỚC trong cùng một project Flow để Flow "biết mặt" rồi mới tới các cảnh —
// đó là lý do phải tách hai khối chứ không gom một danh sách.
// ============================================================================

const SECTION_RE = [
    { kind: 'character', re: /^(nhân vật|nhan vat|nhân-vật|characters?|cast)\s*:?\s*$/i },
    { kind: 'scene', re: /^(cảnh|canh|scenes?|shots?)\s*:?\s*$/i },
];
const ITEM_RE = /^\s*(\d{1,3})\s*[.)]\s*(.*)$/;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * @returns {{ characters: Array<{n:number,label:string,prompt:string}>,
 *             scenes: Array<{n:number,label:string,prompt:string}> }}
 */
export function parseScenePrompts(text) {
    const out = { characters: [], scenes: [] };
    if (!String(text || '').trim()) return out;

    // Không có tiêu đề "NHÂN VẬT" thì cả file là cảnh — người dùng chỉ dán phần cảnh cũng chạy được.
    let kind = /^(nhân vật|nhan vat|characters?|cast)\s*:?\s*$/im.test(text) ? null : 'scene';
    let cur = null;
    const push = () => {
        if (!cur) return;
        const body = clean(cur.body.join(' '));
        const label = clean(cur.label);
        // Viết liền một dòng: nhãn chính là prompt, nhãn hiển thị rút còn 60 ký tự.
        const prompt = body || label;
        if (prompt) {
            (cur.kind === 'character' ? out.characters : out.scenes).push({
                n: cur.n,
                label: body ? label : (label.length > 60 ? label.slice(0, 60) + '…' : label),
                prompt,
            });
        }
        cur = null;
    };

    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;

        const head = SECTION_RE.find(s => s.re.test(line));
        if (head) { push(); kind = head.kind; continue; }

        const m = line.match(ITEM_RE);
        if (m) {
            push();
            cur = { kind: kind || 'character', n: parseInt(m[1], 10), label: m[2], body: [] };
            continue;
        }
        // Chữ nằm ngoài mọi mục (lời dẫn đầu file) thì bỏ qua.
        if (cur) cur.body.push(line);
    }
    push();

    // Đánh lại số thứ tự theo VỊ TRÍ trong file: cảnh thứ k luôn gán vào cảnh thứ k của dự án,
    // kể cả khi người dùng đánh số nhảy cóc hoặc trùng.
    out.characters.forEach((c, i) => { c.n = i + 1; });
    out.scenes.forEach((s, i) => { s.n = i + 1; });
    return out;
}
