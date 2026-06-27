import fs from 'fs';
import path from 'path';

// Atomically reserve the next available `stock_N.ext` slot in targetDir.
// O_EXCL avoids the race where two providers both compute the same index
// and overwrite each other's downloads.
// Caller writes the payload into the returned path, and must unlink it
// on failure so the slot becomes reusable.
export function claimNextStockPath(targetDir, ext, sourceUrl = '') {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    let i = 1;
    while (i < 100000) {
        const p = path.join(targetDir, `stock_${i}.${ext}`);
        try {
            const fd = fs.openSync(p, 'wx');
            fs.closeSync(fd);
            // Ghi kèm URL nguồn (sidecar .src) để hiển thị tag nguồn giống RSS
            if (sourceUrl) { try { fs.writeFileSync(p + '.src', String(sourceUrl)); } catch (_) {} }
            return p;
        } catch (e) {
            if (e.code === 'EEXIST') { i++; continue; }
            throw e;
        }
    }
    throw new Error(`Too many stock files in ${targetDir}`);
}

// Đọc URL nguồn đã lưu kèm 1 file media (nếu có)
export function readStockSource(filePath) {
    try { const s = fs.readFileSync(filePath + '.src', 'utf8').trim(); return s || null; } catch (_) { return null; }
}
