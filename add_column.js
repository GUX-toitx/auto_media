import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || path.join(MEDIA_DIR, 'db');
const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');

const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

try {
    await db.run('ALTER TABLE Sentence ADD COLUMN original_audio TEXT');
    console.log('✅ Đã thêm cột original_audio vào bảng Sentence');
} catch (e) {
    if (e.message.includes('duplicate column name')) {
        console.log('⚠️ Cột original_audio đã tồn tại');
    } else {
        console.error('❌ Lỗi:', e.message);
    }
}

try {
    await db.run('ALTER TABLE Post ADD COLUMN audio_uuid_vi TEXT');
    console.log('✅ Đã thêm cột audio_uuid_vi vào bảng Post');
} catch (e) {
    if (e.message.includes('duplicate column name')) {
        console.log('⚠️ Cột audio_uuid_vi đã tồn tại');
    } else {
        console.error('❌ Lỗi:', e.message);
    }
}

await db.close();
console.log('✅ Hoàn tất!');
