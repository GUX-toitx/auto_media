import fs from 'fs';
import path from 'path';

// Atomically reserve the next available `stock_N.ext` slot in targetDir.
// O_EXCL avoids the race where two providers both compute the same index
// and overwrite each other's downloads.
// Caller writes the payload into the returned path, and must unlink it
// on failure so the slot becomes reusable.
export function claimNextStockPath(targetDir, ext) {
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    let i = 1;
    while (i < 100000) {
        const p = path.join(targetDir, `stock_${i}.${ext}`);
        try {
            const fd = fs.openSync(p, 'wx');
            fs.closeSync(fd);
            return p;
        } catch (e) {
            if (e.code === 'EEXIST') { i++; continue; }
            throw e;
        }
    }
    throw new Error(`Too many stock files in ${targetDir}`);
}
