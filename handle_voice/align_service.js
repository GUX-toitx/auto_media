import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PY = path.join(ROOT, '.venv-whisperx', 'bin', 'python');
const SCRIPT = path.join(__dirname, 'align_words.py');

const DB_DIR = process.env.DB_DIR || '/usr/gux/media-team/db';
const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

const BUNNY_ACCESS_KEY = process.env.BUNNYCDN_ACCESS_KEY;
const FETCH_CONCURRENCY = 16;

// Bảng "detail": content/content_vi + _audio + _wt
const DETAIL_TABLES = [
    { table: 'HookDetail', where: 'post_id = ?' },
    { table: 'SummaryDetail', where: 'post_id = ?' },
    { table: 'ConclusionDetail', where: 'post_id = ?' },
    { table: 'ParagraphDetail', where: 'paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?)' },
    { table: 'SentenceDetail', where: 'sentence_id IN (SELECT id FROM Sentence WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?))' },
];
// Bảng có tiêu đề: title/title_vi + _audio + _wt
const TITLE_TABLES = [
    { table: 'Paragraph', where: 'post_id = ?' },
    { table: 'Sentence', where: 'paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?)' },
];

async function fetchToFile(url, dest) {
    const res = await fetch(url, { headers: { AccessKey: BUNNY_ACCESS_KEY } });
    if (!res.ok) throw new Error(`fetch ${res.status} ${url}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// Thu thập các unit (text + audio + cột wt) của 1 post theo contentType
async function collectUnits(db, postId, isVi) {
    const textF = isVi ? 'content_vi' : 'content';
    const audioF = isVi ? 'content_vi_audio' : 'content_audio';
    const wtF = isVi ? 'content_vi_wt' : 'content_wt';
    const titleTextF = isVi ? 'title_vi' : 'title';
    const titleAudioF = isVi ? 'title_vi_audio' : 'title_audio';
    const titleWtF = isVi ? 'title_vi_wt' : 'title_wt';
    const lang = isVi ? 'vi' : null; // target -> Python tự nhận diện

    const units = [];
    for (const t of DETAIL_TABLES) {
        const rows = await db.all(
            `SELECT id, ${textF} AS text, ${audioF} AS audio FROM ${t.table} WHERE ${t.where}`, [postId]);
        for (const r of rows) {
            if ((r.text || '').trim() && r.audio) units.push({ id: `${t.table}:${r.id}`, table: t.table, rowId: r.id, wtCol: wtF, text: r.text.trim(), audio: r.audio, lang });
        }
    }
    for (const t of TITLE_TABLES) {
        const rows = await db.all(
            `SELECT id, ${titleTextF} AS text, ${titleAudioF} AS audio FROM ${t.table} WHERE ${t.where}`, [postId]);
        for (const r of rows) {
            if ((r.text || '').trim() && r.audio) units.push({ id: `${t.table}:${r.id}`, table: t.table, rowId: r.id, wtCol: titleWtF, text: r.text.trim(), audio: r.audio, lang });
        }
    }
    return units;
}

function runPython(payload) {
    return new Promise((resolve, reject) => {
        const proc = spawn(PY, [SCRIPT], { cwd: ROOT });
        let out = '', err = '';
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', d => { err += d; });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) return reject(new Error(`align_words.py exit ${code}: ${err.slice(-800)}`));
            try { resolve(JSON.parse(out)); }
            catch (e) { reject(new Error(`parse output lỗi: ${e.message}\nstderr: ${err.slice(-800)}\nstdout: ${out.slice(0, 400)}`)); }
        });
        proc.stdin.write(JSON.stringify(payload));
        proc.stdin.end();
    });
}

/**
 * Forced-align toàn bộ 1 post cho 1 contentType, lưu mốc từng từ vào cột *_wt.
 * @returns {aligned, failed, total, contentType}
 */
export async function alignPost(postId, contentType = 'content') {
    if (!fs.existsSync(PY)) throw new Error(`Chưa cài WhisperX: không thấy ${PY}. Chạy: python3 -m venv .venv-whisperx && .venv-whisperx/bin/pip install whisperx`);
    const isVi = contentType === 'content_vi';
    const db = await getDb();
    const units = await collectUnits(db, postId, isVi);
    if (!units.length) { await db.close(); return { aligned: 0, failed: 0, total: 0, contentType, message: 'Không có unit nào có audio + text' }; }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `align-${postId}-`));
    try {
        // Tải audio song song; unit nào tải lỗi (404/DNS) thì bỏ qua, không làm hỏng cả post
        const items = [];
        let idx = 0, dlFailed = 0;
        for (let i = 0; i < units.length; i += FETCH_CONCURRENCY) {
            const chunk = units.slice(i, i + FETCH_CONCURRENCY);
            await Promise.all(chunk.map(async u => {
                const dest = path.join(tmpDir, `${idx++}_${u.table}_${u.rowId}.mp3`);
                try {
                    await fetchToFile(u.audio, dest);
                    items.push({ id: u.id, audio_path: dest, text: u.text, lang: u.lang });
                } catch (e) {
                    dlFailed++;
                    console.warn(`[align] tải audio lỗi ${u.id}: ${e.message}`);
                }
            }));
        }
        if (!items.length) { return { aligned: 0, failed: units.length, total: units.length, contentType, message: 'Không tải được audio nào (mạng/URL hết hạn?)' }; }

        const result = await runPython({ device: null, items });
        if (!result.ok) throw new Error(result.error || 'align thất bại');

        const byId = new Map(units.map(u => [u.id, u]));
        let aligned = 0, failed = 0;
        for (const r of result.results || []) {
            const u = byId.get(r.id);
            if (!u) continue;
            if (r.ok && Array.isArray(r.words) && r.words.length) {
                await db.run(`UPDATE ${u.table} SET ${u.wtCol} = ? WHERE id = ?`, [JSON.stringify(r.words), u.rowId]);
                aligned++;
            } else {
                failed++;
                if (r.error) console.warn(`[align] ${r.id} lỗi: ${r.error}`);
            }
        }
        return { aligned, failed, downloadFailed: dlFailed, total: units.length, contentType, device: result.device };
    } finally {
        await db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
