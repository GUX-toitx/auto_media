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
    form.append('speakers', JSON.stringify([{"no": 1, "reference_speaker_uuid": speakerUuid}]));
    form.append('upload_type', 'sentence');
    form.append('sentence_text', sentences.join('\n'));
    form.append('language', lang || 'en');
    form.append('speed', '1');
    form.append('pitch', '1');
    form.append('volume', '1.0');
    form.append('silence_duration', '1');
    form.append('exaggeration', '0.5');
    form.append('cfg_weight', '0.5');
    form.append('temperature', '0.8');
    form.append('top_p', '1');
    form.append('repetition_penalty', '2');
    form.append('crossfade_ms', '50');
    form.append('split_chars', JSON.stringify([".", "\n"]));
    form.append('source', 'API');

    console.log('[createBatch] Params:', { batchName, lang, speakerUuid, sentenceCount: sentences.length });
    console.log('[createBatch] First 3 sentences:', sentences.slice(0, 3));

    const res = await api('/user/batch', { method: 'POST', body: form });
    return res.json();
}

async function downloadAudio(audioUrl, savePath) {
    // Nếu audioUrl đã là full URL (bắt đầu bằng http) thì dùng trực tiếp
    const fullUrl = audioUrl.startsWith('http') ? audioUrl : `${VOICE_API.slice(0, VOICE_API.lastIndexOf('/api'))}/${audioUrl}`;
    
    console.log('[downloadAudio] Downloading from:', fullUrl);
    const res = await fetch(fullUrl, {
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
    return api('/user/reference-speaker?page=0&limit=-1').then(r => r.json());
}

export async function generateAudios(projectDir, postId, lang, speakerUuid, speakerUuidVi) {
    const projectName = path.basename(projectDir);

    const db = await getDb();
    const sentences = await db.all(
        'SELECT id, content, original_content, "order" FROM Sentence WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?) ORDER BY "order"',
        [postId]
    );
    await db.close();

    const texts = sentences.map(s => s.content.trim()).filter(Boolean);
    const originalTexts = sentences.map(s => (s.original_content || '').trim()).filter(Boolean);
    const folderNames = sentences.map(s => String(s.order));
    const paragraphIds = sentences.map(s => s.id);
    if (!texts.length) throw new Error(`Không có paragraph nào trong post id: ${postId}`);

    const batchName = `${projectName}_${lang}`;
    const batchNameVi = `${projectName}_vi_original`;

    console.log('[generateAudios] Target lang:', lang, '| Sentences:', texts.length, '| Original:', originalTexts.length);

    try {
        // Tạo batch cho target language
        console.log('[generateAudios] Creating target batch:', batchName, 'with speaker:', speakerUuid);
        const createRes = await createBatch(batchName, texts, lang, speakerUuid);
        const batchUuid = createRes.data?.uuid || createRes.uuid;
        console.log('[generateAudios] Target batch created:', batchUuid);
        
        // Tạo batch cho Vietnamese (original_content)
        let batchUuidVi = null;
        if (originalTexts.length > 0 && speakerUuidVi) {
            console.log('[generateAudios] Creating Vietnamese batch:', batchNameVi, 'with speaker:', speakerUuidVi);
            const createResVi = await createBatch(batchNameVi, originalTexts, 'vi', speakerUuidVi);
            batchUuidVi = createResVi.data?.uuid || createResVi.uuid;
            console.log('[generateAudios] Vietnamese batch created:', batchUuidVi);
        }
        
        return { batch_uuid: batchUuid, batch_uuid_vi: batchUuidVi, folderNames, paragraphIds };
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

    // Lấy tất cả sentences từ batch
    const condition = JSON.stringify({ where: { batch_uuid: batchUuid }, orderBy: { index: 'asc' } });
    const sentenceData = await api(`/user/sentence?page=0&limit=-1&condition=${encodeURIComponent(condition)}`).then(r => r.json());
    const sentences = (sentenceData.data || []);
    console.log('[downloadBatchAudios] status:', status, '| sentences count:', sentences.length);
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
