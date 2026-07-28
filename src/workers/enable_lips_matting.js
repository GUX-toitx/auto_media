/**
 * Bật "Xoá nền tự động" (智能抠像) cho clip lips trong 1 draft CapCut CÓ SẴN.
 *
 * Dùng khi draft đã export/đã chỉnh tay rồi mà không muốn export lại: script ghi thẳng
 * matting.flag = 3 vào các material lips (giữ nguyên clip đã bật, kể cả cache mask CapCut đã tính).
 * Draft export mới thì không cần script này — capcut_export.js đã bật sẵn (LIPS_BG_REMOVAL).
 *
 * CapCut 9.x giữ NHIỀU BẢN SAO cùng nội dung: draft_content.json ở gốc và
 * Timelines/<id>/draft_content.json (+ .bak, template-2.tmp) → phải vá hết, nếu không
 * CapCut đọc bản chưa vá là mất tác dụng.
 *
 * Dùng:
 *   node src/workers/enable_lips_matting.js <thư_mục_draft>
 *   node src/workers/enable_lips_matting.js <thư_mục_draft> --all   # mọi material video, không chỉ lips
 *   node src/workers/enable_lips_matting.js <thư_mục_draft> --dry   # chỉ xem, không ghi
 *
 * Sau khi chạy: mở lại draft trong CapCut, chờ nó tự tách nền (draft vá tay chưa có cache mask).
 */
import fs from 'fs';
import path from 'path';
import { buildLipsMatting } from './capcut_export.js';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
const ALL = args.includes('--all');
const DRY = args.includes('--dry');

if (!target || !fs.existsSync(target)) {
    console.error('Usage: node enable_lips_matting.js <draft_dir|draft_content.json> [--all] [--dry]');
    process.exit(1);
}

// Gom mọi bản sao draft_content trong draft (gốc + từng Timelines/<id>).
function collectDraftFiles(t) {
    if (fs.statSync(t).isFile()) return [t];
    const files = [];
    for (const name of ['draft_content.json', 'draft_content.json.bak', 'template-2.tmp']) {
        const p = path.join(t, name);
        if (fs.existsSync(p)) files.push(p);
    }
    const tlDir = path.join(t, 'Timelines');
    if (fs.existsSync(tlDir)) {
        for (const sub of fs.readdirSync(tlDir)) {
            const subPath = path.join(tlDir, sub);
            if (!fs.statSync(subPath).isDirectory()) continue;
            for (const name of ['draft_content.json', 'draft_content.json.bak', 'template-2.tmp']) {
                const p = path.join(subPath, name);
                if (fs.existsSync(p)) files.push(p);
            }
        }
    }
    return files;
}

// Clip lips do capcut_export đặt tên <base>_lips.mp4; --all thì lấy mọi material video (bỏ ảnh).
const isLips = v => /_lips\.mp4$/i.test(v.material_name || '');

const files = collectDraftFiles(target);
if (!files.length) {
    console.error(`Không thấy draft_content.json trong: ${target}`);
    process.exit(1);
}
console.log(`[matting] ${files.length} bản sao draft_content cần vá`);

// custom_matting_id phải GIỐNG NHAU giữa các bản sao cho cùng 1 material (chúng là cùng 1 draft).
const mattingByMaterial = new Map();
let totalPatched = 0;

for (const file of files) {
    let draft;
    try { draft = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.warn(`  ! bỏ qua ${path.relative(target, file)}: JSON lỗi (${e.message})`); continue; }

    const videos = draft?.materials?.videos || [];
    const wanted = videos.filter(v => v.type === 'video' && (ALL || isLips(v)));
    const todo = wanted.filter(v => !(v.matting || {}).flag);

    console.log(`  ${path.relative(target, file) || path.basename(file)}: ${wanted.length} clip diện xoá nền, ${wanted.length - todo.length} đã bật, cần bật ${todo.length}`);
    if (!todo.length || DRY) continue;

    const backup = `${file}.before_matting`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);

    for (const v of todo) {
        if (!mattingByMaterial.has(v.id)) mattingByMaterial.set(v.id, buildLipsMatting());
        v.matting = JSON.parse(JSON.stringify(mattingByMaterial.get(v.id)));
        totalPatched++;
    }
    fs.writeFileSync(file, JSON.stringify(draft));
}

if (DRY) console.log('[matting] --dry: không ghi file.');
else console.log(`[matting] Xong: bật xoá nền cho ${mattingByMaterial.size} clip (${totalPatched} lượt ghi trên ${files.length} bản sao). Backup: *.before_matting`);
