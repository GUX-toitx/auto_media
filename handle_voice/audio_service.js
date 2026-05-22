import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { downloadIndividual, downloadMerged } from './downloadAudio.js';

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
    if (!res.ok) throw new Error(`API ${endpoint} failed: ${res.status} ${await res.text()}`);
    return res;
}

async function createBatch(batchName, sentences, lang, speakerUuid, dictionaryUuids = []) {
    const form = new FormData();
    form.append('batch_name', batchName);
    form.append('language', lang || 'en');
    form.append('pitch', 1);
    form.append('speed', 1);
    form.append('volume', 1);
    form.append('silence_duration', 1);
    form.append('exaggeration', 0.5);
    form.append('cfg_weight', 0.5);
    form.append('temperature', 0.8);
    form.append('top_p', 1);
    form.append('repetition_penalty', 2);
    form.append('crossfade_ms', 50);
    form.append('upload_type', 'sentence');
    form.append('source', 'API');
    form.append('split_chars', JSON.stringify(["\n", ".", "?", "!"]));
    form.append('speakers', JSON.stringify([{ no: 1, reference_speaker_uuid: speakerUuid }]));
    dictionaryUuids.forEach(uuid => form.append('dictionary_uuids[]', uuid));
    sentences.forEach((text, i) => form.append(`sentences[${i}][text]`, text));
    const res = await api('/user/batch', { method: 'POST', body: form });
    return res.json();
}

let cachedUserUuid = null;

export async function getMe() {
    const res = await api('/user/auth/me').then(r => r.json());
    cachedUserUuid = res.data?.uuid || null;
    return res;
}

async function getUserUuid() {
    if (!cachedUserUuid) await getMe();
    return cachedUserUuid;
}

export async function sendToQueue(uuids) {
    const res = await api('/user/sentence/send-to-queue', {
        method: 'POST',
        body: JSON.stringify({ uuids }),
    });
    return res.json();
}

export async function getSentenceStatus(sentenceUuid) {
    const res = await api(`/user/sentence/${sentenceUuid}`);
    return res.json();
}

export async function updateSentence({ uuid, reference_speaker_uuid, text }) {
    const payload = { uuid, text };
    if (reference_speaker_uuid) payload.reference_speaker_uuid = reference_speaker_uuid;
    const res = await api(`/user/sentence/${uuid}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
    return res.json();
}

export async function getLanguages() {
    return api('/user/language?page=0&limit=-1').then(r => r.json());
}

export async function getDictionary() {
    const uuid = await getUserUuid();
    const condition = JSON.stringify({ where: { OR: [{ user_uuid: null }, { user_uuid: uuid }] } });
    return api(`/user/dictionary?page=0&limit=-1&condition=${encodeURIComponent(condition)}`).then(r => r.json());
}

export async function getReferenceSpeakers(lang) {
    const uuid = await getUserUuid();
    const where = { OR: [{ user_uuid: null }, { user_uuid: uuid }] };
    if (lang) where.language = lang;
    const condition = JSON.stringify({
        where,
        orderBy: [{ user_uuid: 'asc' }, { speaker_name: 'asc' }],
    });
    return api(`/user/reference-speaker?page=0&limit=-1&condition=${encodeURIComponent(condition)}`).then(r => r.json());
}

export async function generateAudios(projectDir, postId, lang, speakerUuid, contentType = 'content', dictionaryUuids = []) {
    const projectName = path.basename(projectDir);
    const db = await getDb();
    const sentences = await db.all(
        `SELECT id, content, original_content, "order" FROM Sentence WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?) ORDER BY "order"`,
        [postId]
    );
    await db.close();

    const valid = sentences.filter(s => (s[contentType] || s.content).trim());
    const texts = valid.map(s => (s[contentType] || s.content).trim());
    const folderNames = valid.map(s => String(s.order));
    const paragraphIds = valid.map(s => s.id);
    if (!texts.length) throw new Error(`Không có paragraph nào trong post id: ${postId}`);

    const batchName = `${projectName}_${lang}`;
    try {
        const createRes = await createBatch(batchName, texts, lang, speakerUuid, dictionaryUuids);
        const batchUuid = createRes.data?.uuid || createRes.uuid;
        const batchSentences = createRes.data?.sentences || [];

        const db2 = await getDb();
        await db2.run('UPDATE Post SET silence_duration = ? WHERE id = ?', [createRes.data?.silence_duration ?? 1, postId]);
        for (const bs of batchSentences) {
            const sentenceId = valid.find(s => s.order === bs.index)?.id;
            if (sentenceId) {
                await db2.run('UPDATE Sentence SET sentence_uuid = ? WHERE id = ?', [bs.uuid, sentenceId]);
            }
        }
        await db2.close();

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

export async function getBatchAudios(batchUuid, paragraphIds = []) {
    const batchData = await api(`/user/batch/${batchUuid}`).then(r => r.json());
    const status = batchData.data?.status || batchData.status;
    if (status !== 'OK') return null;

    const condition = JSON.stringify({ where: { batch_uuid: batchUuid }, orderBy: { index: 'asc' } });
    const sentenceData = await api(`/user/sentence?page=0&limit=-1&condition=${encodeURIComponent(condition)}`).then(r => r.json());
    const sentences = sentenceData.data || [];

    const results = sentences.map((s, i) => ({
        paragraphId: paragraphIds[i],
        audioUrl: s.audio_url,
        sentenceUuid: s.uuid,
    }));

    return { total: sentences.length, results };
}

export async function checkAndSaveVoice(batchUuid, postId) {
    const batchData = await api(`/user/batch/${batchUuid}`).then(r => r.json());
    const status = batchData.data?.status || batchData.status;

    if (status === 'OK' && postId) {
        const db = await getDb();
        const sentences = await db.all(
            'SELECT id FROM Sentence WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?) ORDER BY "order"',
            [postId]
        );
        const result = await getBatchAudios(batchUuid, sentences.map(s => s.id));
        console.log('[Voice] getBatchAudios result:', result ? result.total : 'null');
        if (result) {
            for (const r of result.results) {
                if (r.paragraphId) {
                    await db.run('UPDATE Sentence SET audio = ?, sentence_uuid = ? WHERE id = ?', [r.audioUrl, r.sentenceUuid || null, r.paragraphId]);
                    console.log(`[Voice] Saved audio for sentence ${r.paragraphId}: ${r.audioUrl}`);
                }
            }
        }
        await db.close();
    }

    return { status };
}

export async function getIndividualAudio(postId) {
    const db = await getDb();
    const sentences = await db.all(
        `SELECT s."order", s.audio FROM Sentence s
         JOIN Paragraph p ON s.paragraph_id = p.id
         WHERE p.post_id = ? AND s.audio IS NOT NULL ORDER BY s."order"`,
        [postId]
    );
    const post = await db.get('SELECT title FROM Post WHERE id = ?', [postId]);
    await db.close();
    const buf = await downloadIndividual(sentences);
    return { buf, filename: `${post.title}_individual.zip` };
}

export async function getMergedAudio(postId, silenceDuration, tmpDir) {
    const db = await getDb();
    const sentences = await db.all(
        `SELECT s."order", s.audio FROM Sentence s
         JOIN Paragraph p ON s.paragraph_id = p.id
         WHERE p.post_id = ? AND s.audio IS NOT NULL ORDER BY s."order"`,
        [postId]
    );
    const post = await db.get('SELECT title, audio_uuid, silence_duration FROM Post WHERE id = ?', [postId]);
    await db.close();

    const silence = silenceDuration ?? post.silence_duration ?? 1;

    if (post.audio_uuid) {
        await api(`/user/batch/${post.audio_uuid}`, {
            method: 'PUT',
            body: JSON.stringify({ uuid: post.audio_uuid, silence_duration: silence }),
        }).catch(e => console.error('[getMergedAudio] update silence_duration failed:', e.message));
        const db2 = await getDb();
        await db2.run('UPDATE Post SET silence_duration = ? WHERE id = ?', [silence, postId]);
        await db2.close();
    }

    const outputFile = await downloadMerged(sentences, silence, tmpDir);
    return { outputFile, filename: `${post.title}_merged.mp3` };
}
