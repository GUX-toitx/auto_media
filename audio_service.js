import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_DIR = process.env.DB_DIR || '/usr/gux/media-team/db';
const DB_PATH = path.join(DB_DIR, 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

const VOICE_API = process.env.VOICE_API;
const API_KEY = process.env.API_KEY;
const TENANT = process.env.TENANT;

async function api(endpoint, options = {}) {
    const res = await fetch(`${VOICE_API}${endpoint}`, {
        ...options,
        headers: {
            'x-api-key': API_KEY,
            'x-tenant': TENANT,
            'Accept': 'application/json',
            ...(options.body instanceof FormData || !options.body ? {} : { 'Content-Type': 'application/json' }),
            ...options.headers,
        },
    });

    if (!res.ok) {
        throw new Error(`API ${endpoint} failed: ${res.status} ${await res.text()}`);
    }

    return res;
}

async function createBatch(batchName, sentences, lang, speakerUuid) {
    const form = new FormData();
    form.append('batch_name', batchName);
    form.append('reference_speaker_uuid', speakerUuid);
    form.append('upload_type', 'sentence');
    form.append('language', lang || 'en');
    form.append('source', 'API');
    sentences.forEach((text, i) => form.append(`sentences[${i}][text]`, text));

    const res = await api('/user/batch', { method: 'POST', body: form });
    return res.json();
}

async function downloadAudio(audioUrl, savePath) {
    const baseUrl = VOICE_API.slice(0, VOICE_API.lastIndexOf('/api'));
    const res = await fetch(`${baseUrl}/${audioUrl}`, {
        headers: { 'x-api-key': API_KEY, 'x-tenant': TENANT },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${await res.text()}`);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(savePath, Buffer.from(buffer));
}

// --- EXPORT ---
export async function getLanguages() {
    return api('/user/language?page=0&limit=-1').then(r => r.json());
}

export async function getReferenceSpeakers() {
    const condition = JSON.stringify({
        where: { OR: [{ user_uuid: null }, { user_uuid: '15f22a66-68e7-4367-87c6-02ca4ee76469' }] },
        orderBy: [{ user_uuid: 'asc' }, { speaker_name: 'asc' }],
    });
    return api(`/user/reference-speaker?page=0&limit=-1&condition=${encodeURIComponent(condition)}`).then(r => r.json());
}

export async function generateAudios(projectDir, postId, lang, speakerUuid) {
    const projectName = path.basename(projectDir);

    const db = await getDb();
    const paragraphs = await db.all(
        'SELECT id, content, "order" FROM Paragraph WHERE post_id = ? ORDER BY "order"', [postId]
    );
    await db.close();

    const texts = paragraphs.map(p => p.content.trim()).filter(Boolean);
    const folderNames = paragraphs.map(p => String(p.order));
    const paragraphIds = paragraphs.map(p => p.id);
    if (!texts.length) throw new Error(`Không có paragraph nào trong post id: ${postId}`);

    const batchName = `${projectName}_${lang}`;

    try {
        const createRes = await createBatch(batchName, texts, lang, speakerUuid);
        const batchUuid = createRes.data?.uuid || createRes.uuid;
        return { batch_uuid: batchUuid, folderNames, paragraphIds };
    } catch (err) {
        console.error(`[generateAudios] LỖI createBatch:`, err.message);
        throw err;
    }
}

export async function updateBatchStatus(batchUuid) {
    const res = await api(`/user/batch/${batchUuid}/status`, { method: 'PUT' });
    return res.json();
}

export async function downloadBatchAudios(batchUuid, baseDir, folderNames = [], paragraphIds = []) {
    const batchData = await api(`/user/batch/${batchUuid}`).then(r => r.json());
    const status = batchData.data?.status || batchData.status;

    if (status !== 'OK') return null;

    const sentences = (batchData.data?.sentences || []).sort((a, b) => a.index - b.index);
    const results = [];

    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        const folder = folderNames[i] || String(i + 1);
        const outputDir = path.join(baseDir, folder);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const savePath = path.join(outputDir, `audio.mp3`);
        await downloadAudio(s.audio_url, savePath);

        const relativePath = path.relative(MEDIA_DIR, savePath);
        results.push({ paragraphId: paragraphIds[i], relativePath });
    }

    return { total: sentences.length, results };
}
