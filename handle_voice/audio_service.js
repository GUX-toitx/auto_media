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

export async function generateAudios(projectDir, postId, lang, speakerUuid, contentType = 'content', dictionaryUuids = [], textsFromDOM = null) {
    const projectName = path.basename(projectDir);
    const db = await getDb();

    // Xây dựng danh sách theo đúng thứ tự DOM:
    // HookDetail -> Paragraph(title, details -> Sentence(title, details)) -> conclusion
    const isVi = contentType === 'content_vi';
    const tf = isVi ? 'content_vi' : 'content'; // text field
    const rows = [];

    const post = await db.get('SELECT id FROM Post WHERE id = ?', [postId]);

    const hookDetails = await db.all('SELECT id, content, content_vi FROM HookDetail WHERE post_id = ? ORDER BY "order"', [postId]);
    for (const d of hookDetails) if ((d[tf] || '').trim()) rows.push({ src: 'hook', id: d.id, text: d[tf] });

    const paragraphs = await db.all('SELECT id, title, title_vi FROM Paragraph WHERE post_id = ? ORDER BY id', [postId]);
    for (const para of paragraphs) {
        const titleText = isVi ? para.title_vi : para.title;
        if ((titleText || '').trim()) rows.push({ src: 'para_title', id: para.id, text: titleText });

        const paraDetails = await db.all('SELECT id, content, content_vi FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"', [para.id]);
        for (const d of paraDetails) if ((d[tf] || '').trim()) rows.push({ src: 'para', id: d.id, text: d[tf] });

        const sentences = await db.all('SELECT id, title, title_vi FROM Sentence WHERE paragraph_id = ? ORDER BY "order"', [para.id]);
        for (const s of sentences) {
            const stitle = isVi ? s.title_vi : s.title;
            if ((stitle || '').trim()) rows.push({ src: 'sent_title', id: s.id, text: stitle });
            const details = await db.all('SELECT id, content, content_vi FROM SentenceDetail WHERE sentence_id = ? ORDER BY "order"', [s.id]);
            for (const d of details) if ((d[tf] || '').trim()) rows.push({ src: 'sent', id: d.id, text: d[tf] });
        }
    }

    const conclusionDetails = await db.all('SELECT id, content, content_vi FROM ConclusionDetail WHERE post_id = ? ORDER BY "order"', [postId]);
    for (const d of conclusionDetails) if ((d[tf] || '').trim()) rows.push({ src: 'conclusion', id: d.id, text: d[tf] });

    await db.close();

    const texts = rows.map(r => r.text.trim());
    const folderNames = rows.map((_, i) => String(i + 1));
    const rowIds = rows.map(r => ({ src: r.src, id: r.id }));

    if (!texts.length) throw new Error(`Không có nội dung nào trong post id: ${postId}`);

    const batchName = `${projectName}_${lang}`;
    try {
        const createRes = await createBatch(batchName, texts, lang, speakerUuid, dictionaryUuids);
        const batchUuid = createRes.data?.uuid || createRes.uuid;
        const batchSentences = createRes.data?.sentences || [];

        const db2 = await getDb();
        await db2.run('UPDATE Post SET silence_duration = ? WHERE id = ?', [createRes.data?.silence_duration ?? 1, postId]);
        for (let i = 0; i < batchSentences.length; i++) {
            const row = rowIds[i];
            if (row && batchSentences[i]?.uuid) {
                const tblMap = { hook: 'HookDetail', conclusion: 'ConclusionDetail', para: 'ParagraphDetail', sent: 'SentenceDetail', para_title: 'Paragraph', sent_title: 'Sentence' };
                const tbl = tblMap[row.src];
                if (tbl) await db2.run(`UPDATE ${tbl} SET sentence_uuid = ? WHERE id = ?`, [batchSentences[i].uuid, row.id]);
            }
        }
        await db2.close();

        return { batch_uuid: batchUuid, folderNames, paragraphIds: rowIds.map(r => r.id) };
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

export async function checkAndSaveVoice(batchUuid, postId, contentType = 'content') {
    const batchData = await api(`/user/batch/${batchUuid}`).then(r => r.json());
    const status = batchData.data?.status || batchData.status;

    if (status === 'OK' && postId) {
        const db = await getDb();

        // Lấy tất cả sentences từ batch theo thứ tự
        const condition = JSON.stringify({ where: { batch_uuid: batchUuid }, orderBy: { index: 'asc' } });
        const sentenceData = await api(`/user/sentence?page=0&limit=-1&condition=${encodeURIComponent(condition)}`).then(r => r.json());
        const batchSentences = sentenceData.data || [];

        // Xây dựng units theo đúng thứ tự DOM:
        // HookDetail -> Paragraph(title, details -> Sentence(title, details)) -> conclusion
        const isVi = contentType === 'content_vi';
        const audioField = isVi ? '_vi_audio' : '_audio';
        const units = [];

        const post = await db.get('SELECT id FROM Post WHERE id = ?', [postId]);

        const hookDetails = await db.all('SELECT id, content, content_vi FROM HookDetail WHERE post_id = ? ORDER BY "order"', [postId]);
        for (const d of hookDetails) {
            if (d.content_vi || d.content) units.push({ table: 'HookDetail', id: d.id, field: `content${audioField}` });
        }

        const paragraphs = await db.all('SELECT id, title, title_vi FROM Paragraph WHERE post_id = ? ORDER BY id', [postId]);
        for (const para of paragraphs) {
            if (para.title_vi || para.title) units.push({ table: 'Paragraph', id: para.id, field: `title${audioField}` });

            const paraDetails = await db.all('SELECT id, content, content_vi FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"', [para.id]);
            for (const d of paraDetails) {
                if (d.content_vi || d.content) units.push({ table: 'ParagraphDetail', id: d.id, field: `content${audioField}` });
            }

            const sentences = await db.all('SELECT id, title, title_vi FROM Sentence WHERE paragraph_id = ? ORDER BY "order"', [para.id]);
            for (const s of sentences) {
                if (s.title_vi || s.title) units.push({ table: 'Sentence', id: s.id, field: `title${audioField}` });
                const details = await db.all('SELECT id, content, content_vi FROM SentenceDetail WHERE sentence_id = ? ORDER BY "order"', [s.id]);
                for (const d of details) {
                    if (d.content_vi || d.content) units.push({ table: 'SentenceDetail', id: d.id, field: `content${audioField}` });
                }
            }
        }

        const conclusionDetails = await db.all('SELECT id, content, content_vi FROM ConclusionDetail WHERE post_id = ? ORDER BY "order"', [postId]);
        for (const d of conclusionDetails) {
            if (d.content_vi || d.content) units.push({ table: 'ConclusionDetail', id: d.id, field: `content${audioField}` });
        }

        // Map từng batch sentence vào đúng unit theo index
        for (let i = 0; i < batchSentences.length; i++) {
            const bs = batchSentences[i];
            const unit = units[i];
            if (!unit || !bs.audio_url) continue;
            await db.run(`UPDATE ${unit.table} SET ${unit.field} = ? WHERE id = ?`, [bs.audio_url, unit.id]);
            console.log(`[Voice] Saved ${unit.table}#${unit.id}.${unit.field} = ${bs.audio_url}`);
        }

        await db.close();
    }

    return { status };
}

export async function getAllAudioUrls(postId, contentType = 'content') {
    const db = await getDb();
    const isVi = contentType === 'content_vi';
    const sf = isVi ? '_vi_audio' : '_audio';
    const urls = [];

    const post = await db.get(`SELECT id FROM Post WHERE id = ?`, [postId]);

    // HookDetail
    const hookDetails = await db.all(`SELECT content${sf} FROM HookDetail WHERE post_id = ? ORDER BY "order"`, [postId]);
    for (const d of hookDetails) if (d[`content${sf}`]) urls.push({ order: urls.length + 1, audio: d[`content${sf}`] });

    // Paragraphs
    const paragraphs = await db.all('SELECT id FROM Paragraph WHERE post_id = ? ORDER BY id', [postId]);
    for (const para of paragraphs) {
        const p = await db.get(`SELECT title${sf} FROM Paragraph WHERE id = ?`, [para.id]);
        if (p[`title${sf}`]) urls.push({ order: urls.length + 1, audio: p[`title${sf}`] });

        const paraDetails = await db.all(`SELECT content${sf} FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"`, [para.id]);
        for (const d of paraDetails) if (d[`content${sf}`]) urls.push({ order: urls.length + 1, audio: d[`content${sf}`] });

        const sentences = await db.all(`SELECT id, title${sf} FROM Sentence WHERE paragraph_id = ? ORDER BY "order"`, [para.id]);
        for (const s of sentences) {
            if (s[`title${sf}`]) urls.push({ order: urls.length + 1, audio: s[`title${sf}`] });
            const details = await db.all(`SELECT content${sf} FROM SentenceDetail WHERE sentence_id = ? ORDER BY "order"`, [s.id]);
            for (const d of details) if (d[`content${sf}`]) urls.push({ order: urls.length + 1, audio: d[`content${sf}`] });
        }
    }

    // ConclusionDetail
    const conclusionDetails = await db.all(`SELECT content${sf} FROM ConclusionDetail WHERE post_id = ? ORDER BY "order"`, [postId]);
    for (const d of conclusionDetails) if (d[`content${sf}`]) urls.push({ order: urls.length + 1, audio: d[`content${sf}`] });

    await db.close();
    return urls;
}

export async function getIndividualAudio(postId, contentType = 'content') {
    const db = await getDb();
    const post = await db.get('SELECT project_id, voice_content_type FROM Post WHERE id = ?', [postId]);
    await db.close();
    const ct = contentType || post.voice_content_type || 'content';
    const audioList = await getAllAudioUrls(postId, ct);
    const buf = await downloadIndividual(audioList);
    const suffix = ct === 'content_vi' ? '_vi' : '_target';
    return { buf, filename: `${post.project_id}${suffix}_individual.zip` };
}

export async function getMergedAudio(postId, silenceDuration, tmpDir, contentType = 'content') {
    const db = await getDb();
    const post = await db.get('SELECT project_id, audio_uuid, silence_duration, voice_content_type FROM Post WHERE id = ?', [postId]);
    await db.close();
    const ct = contentType || post.voice_content_type || 'content';
    const audioList = await getAllAudioUrls(postId, ct);

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

    const outputFile = await downloadMerged(audioList, silence, tmpDir);
    const suffix2 = ct === 'content_vi' ? '_vi' : '_target';
    return { outputFile, filename: `${post.project_id}${suffix2}_merged.mp3` };
}
