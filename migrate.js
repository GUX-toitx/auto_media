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
            project_id TEXT UNIQUE,
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
            type TEXT DEFAULT NULL,
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
    await db.run('ALTER TABLE Post ADD COLUMN silence_duration REAL DEFAULT 1').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN title TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN mo_bai TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN mo_bai_vi TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN mo_bai_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN mo_bai_vi_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN voice_content_type TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN summary TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN summary_vi TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN summary_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN summary_vi_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN summary_target TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN summary_target_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN conclusion_vi TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN conclusion_vi_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN conclusion_target TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN conclusion_target_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN hook TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN hook_vi TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN hook_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post ADD COLUMN hook_vi_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Sentence ADD COLUMN sentence_uuid TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Sentence ADD COLUMN title TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Sentence ADD COLUMN title_vi TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Sentence ADD COLUMN content_vi TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Sentence ADD COLUMN content_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Sentence ADD COLUMN content_vi_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Sentence ADD COLUMN title_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Sentence ADD COLUMN title_vi_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Paragraph ADD COLUMN title TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Paragraph ADD COLUMN title_vi TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Paragraph ADD COLUMN content_vi TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Paragraph ADD COLUMN content_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Paragraph ADD COLUMN content_vi_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Paragraph ADD COLUMN title_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Paragraph ADD COLUMN title_vi_audio TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Keyword ADD COLUMN type TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Keyword ADD COLUMN post_id INTEGER DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Keyword ADD COLUMN section TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Asset ADD COLUMN post_id INTEGER DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Asset ADD COLUMN section TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Asset ADD COLUMN source_id INTEGER DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Asset ADD COLUMN hook_detail_id INTEGER DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Asset ADD COLUMN summary_detail_id INTEGER DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Asset ADD COLUMN paragraph_detail_id INTEGER DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Asset ADD COLUMN sentence_detail_id INTEGER DEFAULT NULL').catch(() => {});
    await db.run(`CREATE TABLE IF NOT EXISTS SentenceDetail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sentence_id INTEGER NOT NULL,
        content TEXT,
        content_vi TEXT,
        content_audio TEXT,
        content_vi_audio TEXT,
        sentence_uuid TEXT,
        "order" INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(sentence_id) REFERENCES Sentence(id)
    )`).catch(() => {});
    await db.run('ALTER TABLE SentenceDetail ADD COLUMN sentence_uuid TEXT DEFAULT NULL').catch(() => {});
    await db.run(`CREATE TABLE IF NOT EXISTS ParagraphDetail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paragraph_id INTEGER NOT NULL,
        content TEXT,
        content_vi TEXT,
        content_audio TEXT,
        content_vi_audio TEXT,
        sentence_uuid TEXT,
        "order" INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(paragraph_id) REFERENCES Paragraph(id)
    )`).catch(() => {});
    await db.run('ALTER TABLE ParagraphDetail ADD COLUMN sentence_uuid TEXT DEFAULT NULL').catch(() => {});
    await db.run(`CREATE TABLE IF NOT EXISTS HookDetail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        content TEXT,
        content_vi TEXT,
        content_audio TEXT,
        content_vi_audio TEXT,
        sentence_uuid TEXT,
        "order" INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(post_id) REFERENCES Post(id)
    )`).catch(() => {});
    await db.run('ALTER TABLE Paragraph ADD COLUMN sentence_uuid TEXT DEFAULT NULL').catch(() => {});
    await db.run(`CREATE TABLE IF NOT EXISTS ConclusionDetail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        content TEXT,
        content_vi TEXT,
        content_audio TEXT,
        content_vi_audio TEXT,
        sentence_uuid TEXT,
        "order" INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(post_id) REFERENCES Post(id)
    )`).catch(() => {});
    await db.run('ALTER TABLE Asset ADD COLUMN conclusion_detail_id INTEGER DEFAULT NULL').catch(() => {});
    await db.run(`CREATE TABLE IF NOT EXISTS SummaryDetail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        content TEXT,
        content_vi TEXT,
        content_audio TEXT,
        content_vi_audio TEXT,
        sentence_uuid TEXT,
        "order" INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(post_id) REFERENCES Post(id)
    )`).catch(() => {});
    // Rename migrations
    await db.run('ALTER TABLE Post ADD COLUMN target_lang TEXT DEFAULT NULL').catch(() => {});
    await db.run('ALTER TABLE Post RENAME COLUMN title TO project_id').catch(() => {});
    await db.run('ALTER TABLE Post RENAME COLUMN tieu_de TO title').catch(() => {});
    return db;
}

// Chạy trực tiếp: node migrate.js
if (process.argv[1].endsWith('migrate.js')) {
    await initDB().then(db => db.close());
    console.log(`✅ Migration done: ${DB_PATH}`);
}
