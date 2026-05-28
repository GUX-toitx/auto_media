/**
 * sync_assets_db.js
 * Quét thư mục assets trên disk và đăng ký vào bảng Asset trong DB
 * Chạy: node sync_assets_db.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

const MEDIA_DIR = process.env.MEDIA_DIR;
const DB_PATH = path.join(process.env.DB_DIR, 'media_system.sqlite');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

async function main() {
    const db = await getDb();
    const posts = await db.all('SELECT id, project_id FROM Post');

    let inserted = 0, skipped = 0;

    for (const post of posts) {
        const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
        const paragraphs = await db.all(
            'SELECT id FROM Paragraph WHERE post_id = ? ORDER BY id',
            [post.id]
        );

        for (let i = 0; i < paragraphs.length; i++) {
            const para = paragraphs[i];
            const gid = String(i + 1);

            for (const subDir of ['_raw_images', '_raw_videos', '_raw_images_ai_gen', '_raw_videos_ai_gen']) {
                const type = subDir.includes('video') ? 'video' : 'image';
                const dir = path.join(MEDIA_DIR, projectId, 'assets', subDir, gid);
                if (!fs.existsSync(dir)) continue;

                for (const file of fs.readdirSync(dir)) {
                    const ext = path.extname(file).toLowerCase();
                    const validExts = type === 'image' ? IMAGE_EXTS : VIDEO_EXTS;
                    if (!validExts.has(ext)) continue;

                    const relativePath = path.join(projectId, 'assets', subDir, gid, file);
                    const exists = await db.get('SELECT id FROM Asset WHERE file_path = ?', [relativePath]);
                    if (exists) { skipped++; continue; }

                    await db.run(
                        'INSERT INTO Asset (paragraph_id, sentence_id, type, selected, "order", file_path) VALUES (?, NULL, ?, 0, 0, ?)',
                        [para.id, type, relativePath]
                    );
                    inserted++;
                    console.log(`[+] ${relativePath}`);
                }
            }
        }
    }

    await db.close();
    console.log(`\nDone: ${inserted} inserted, ${skipped} skipped`);
}

main().catch(e => { console.error(e); process.exit(1); });
