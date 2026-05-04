import 'dotenv/config';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';

const BASE_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || path.join(BASE_DIR, 'db');
const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');

export async function initDB() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS Post (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT UNIQUE,
            audio_uuid TEXT
        );
        CREATE TABLE IF NOT EXISTS Paragraph (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER,
            content TEXT,
            original_content TEXT,
            audio TEXT,
            "order" INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(post_id) REFERENCES Post(id)
        );
        CREATE TABLE IF NOT EXISTS Keyword (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paragraph_id INTEGER,
            content TEXT,
            FOREIGN KEY(paragraph_id) REFERENCES Paragraph(id)
        );
        CREATE TABLE IF NOT EXISTS Sentence (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paragraph_id INTEGER,
            content TEXT,
            original_content TEXT,
            audio TEXT,
            "order" INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(paragraph_id) REFERENCES Paragraph(id)
        );
        CREATE TABLE IF NOT EXISTS Asset (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paragraph_id INTEGER NULL,
            sentence_id INTEGER NULL,
            type TEXT NOT NULL DEFAULT 'video',
            selected INTEGER NOT NULL DEFAULT 0,
            "order" INTEGER NOT NULL DEFAULT 0,
            duration REAL,
            file_path TEXT,
            FOREIGN KEY(paragraph_id) REFERENCES Paragraph(id),
            FOREIGN KEY(sentence_id) REFERENCES Sentence(id)
        );
        CREATE TABLE IF NOT EXISTS ChromeProfile (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_dir TEXT,
            email TEXT,
            password TEXT,
            updated_at INTEGER NOT NULL DEFAULT 0
        );
    `);

    // ALTER migrations (bỏ qua nếu cột đã tồn tại)
    await db.run('ALTER TABLE Post ADD COLUMN status TEXT DEFAULT NULL').catch(() => {});

    return db;
}

// Chạy trực tiếp: node migrate.js
if (process.argv[1].endsWith('migrate.js')) {
    await initDB().then(db => db.close());
    console.log(`✅ Migration done: ${DB_PATH}`);
}
