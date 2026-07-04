import sqlite3 from 'sqlite3'; import { open } from 'sqlite';
const db = await open({ filename: 'database/media_system.sqlite', driver: sqlite3.Database });
const p = await db.get('SELECT id, project_id, status FROM Post ORDER BY id DESC LIMIT 1');
console.log('post mới nhất:', p.id, p.project_id, '| status:', p.status);
const a = await db.all(`SELECT type, COUNT(*) c, SUM(CASE WHEN file_path LIKE '%/news\\_%' ESCAPE '\\' THEN 1 ELSE 0 END) news FROM Asset WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id=?) GROUP BY type`, [p.id]);
console.log('assets:', JSON.stringify(a));
const sample = await db.all(`SELECT file_path FROM Asset WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id=?) ORDER BY id DESC LIMIT 8`,[p.id]);
console.log('file gần nhất:'); sample.forEach(s=>console.log('  ', s.file_path));
await db.close();
