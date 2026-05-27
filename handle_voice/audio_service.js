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
    const sentences = await db.all(
        `SELECT id, content, content_vi, "order" FROM Sentence WHERE paragraph_id IN (SELECT id FROM Paragraph WHERE post_id = ?) ORDER BY "order"`,
        [postId]
    );
    await db.close();

    let texts, folderNames, paragraphIds;

    if (textsFromDOM && textsFromDOM.length > 0) {
        // Dùng texts từ DOM (bao gồm Post, Paragraph, Sentence theo đúng thứ tự hiển thị)
        texts = textsFromDOM;
        folderNames = textsFromDOM.map((_, i) => String(i + 1));
        paragraphIds = sentences.map(s => s.id); // giữ để map sau
    } else {
        // Fallback: chỉ lấy từ Sentence
        const field = contentType === 'content_vi' ? 'content_vi' : 'content';
        const valid = sentences.filter(s => (s[field] || s.content).trim());
        texts = valid.map(s => (s[field] || s.content).trim());
        folderNames = valid.map(s => String(s.order));
        paragraphIds = valid.map(s => s.id);
    }

    if (!texts.length) throw new Error(`Không có nội dung nào trong post id: ${postId}`);

    const batchName = `${projectName}_${lang}`;
    try {
        const createRes = await createBatch(batchName, texts, lang, speakerUuid, dictionaryUuids);
        const batchUuid = createRes.data?.uuid || createRes.uuid;
        const batchSentences = createRes.data?.sentences || [];

        const db2 = await getDb();
        await db2.run('UPDATE Post SET silence_duration = ? WHERE id = ?', [createRes.data?.silence_duration ?? 1, postId]);
        for (const bs of batchSentences) {
            const sentenceId = sentences.find(s => s.order === bs.index)?.id;
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

export async function checkAndSaveVoice(batchUuid, postId, contentType = 'content') {
    const batchData = await api(`/user/batch/${batchUuid}`).then(r => r.json());
    const status = batchData.data?.status || batchData.status;

    if (status === 'OK' && postId) {
        const db = await getDb();

        // Lấy tất cả sentences từ batch theo thứ tự
        const condition = JSON.stringify({ where: { batch_uuid: batchUuid }, orderBy: { index: 'asc' } });
        const sentenceData = await api(`/user/sentence?page=0&limit=-1&condition=${encodeURIComponent(condition)}`).then(r => r.json());
        const batchSentences = sentenceData.data || [];

        // Xây dựng danh sách các đơn vị cần lưu audio theo đúng thứ tự DOM
        // Thứ tự: Post(mo_bai, tom_tat) -> Paragraph(title, content) -> Sentence(title, content)
        const isVi = contentType === 'content_vi';
        const audioField = isVi ? '_vi_audio' : '_audio';
        const units = [];

        const post = await db.get('SELECT id, mo_bai, mo_bai_vi, tom_tat, tom_tat_vi, tom_tat_target, ket_bai_vi, ket_bai_target FROM Post WHERE id = ?', [postId]);
        if (post.mo_bai_vi || post.mo_bai) units.push({ table: 'Post', id: post.id, field: `mo_bai${audioField}` });

        const paragraphs = await db.all('SELECT id, title, title_vi, content, content_vi FROM Paragraph WHERE post_id = ? ORDER BY id', [postId]);
        for (const para of paragraphs) {
            if (para.title_vi || para.title) units.push({ table: 'Paragraph', id: para.id, field: `title${audioField}` });
            if (para.content_vi || para.content) units.push({ table: 'Paragraph', id: para.id, field: `content${audioField}` });

            const sentences = await db.all('SELECT id, title, title_vi, content, content_vi FROM Sentence WHERE paragraph_id = ? ORDER BY "order"', [para.id]);
            for (const s of sentences) {
                if (s.title_vi || s.title) units.push({ table: 'Sentence', id: s.id, field: `title${audioField}` });
                if (s.content_vi || s.content) units.push({ table: 'Sentence', id: s.id, field: `content${audioField}` });
            }
        }

        // Tóm tắt và Kết bài sau tất cả paragraphs
        if (isVi ? post.tom_tat_vi : post.tom_tat_target) units.push({ table: 'Post', id: post.id, field: isVi ? 'tom_tat_vi_audio' : 'tom_tat_target_audio' });
        if (isVi ? post.ket_bai_vi : post.ket_bai_target) units.push({ table: 'Post', id: post.id, field: isVi ? 'ket_bai_vi_audio' : 'ket_bai_target_audio' });

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

// Lấy tất cả audio URLs theo thứ tự DOM: Post -> Paragraph(title,content) -> Sentence(title,content)
export async function getAllAudioUrls(postId, contentType = 'content') {
    const db = await getDb();
    const isVi = contentType === 'content_vi';
    const sf = isVi ? '_vi_audio' : '_audio'; // suffix field
    const urls = [];

    const post = await db.get(`SELECT mo_bai${sf}, tom_tat_vi_audio, tom_tat_target_audio, ket_bai_vi_audio, ket_bai_target_audio FROM Post WHERE id = ?`, [postId]);
    if (post[`mo_bai${sf}`]) urls.push({ order: urls.length + 1, audio: post[`mo_bai${sf}`] });

    const paragraphs = await db.all('SELECT id FROM Paragraph WHERE post_id = ? ORDER BY id', [postId]);
    for (const para of paragraphs) {
        const p = await db.get(`SELECT title${sf}, content${sf} FROM Paragraph WHERE id = ?`, [para.id]);
        if (p[`title${sf}`]) urls.push({ order: urls.length + 1, audio: p[`title${sf}`] });
        if (p[`content${sf}`]) urls.push({ order: urls.length + 1, audio: p[`content${sf}`] });

        const sentences = await db.all(`SELECT title${sf}, content${sf} FROM Sentence WHERE paragraph_id = ? ORDER BY "order"`, [para.id]);
        for (const s of sentences) {
            if (s[`title${sf}`]) urls.push({ order: urls.length + 1, audio: s[`title${sf}`] });
            if (s[`content${sf}`]) urls.push({ order: urls.length + 1, audio: s[`content${sf}`] });
        }
    }

    // Tóm tắt và Kết bài sau tất cả paragraphs
    const tomTatAudio = isVi ? post.tom_tat_vi_audio : post.tom_tat_target_audio;
    if (tomTatAudio) urls.push({ order: urls.length + 1, audio: tomTatAudio });
    const ketBaiAudio = isVi ? post.ket_bai_vi_audio : post.ket_bai_target_audio;
    if (ketBaiAudio) urls.push({ order: urls.length + 1, audio: ketBaiAudio });
    await db.close();
    return urls;
}

export async function getIndividualAudio(postId, contentType = 'content') {
    const db = await getDb();
    const post = await db.get('SELECT title, voice_content_type FROM Post WHERE id = ?', [postId]);
    await db.close();
    const ct = contentType || post.voice_content_type || 'content';
    const audioList = await getAllAudioUrls(postId, ct);
    const buf = await downloadIndividual(audioList);
    return { buf, filename: `${post.title}_individual.zip` };
}

export async function getMergedAudio(postId, silenceDuration, tmpDir, contentType = 'content') {
    const db = await getDb();
    const post = await db.get('SELECT title, audio_uuid, silence_duration, voice_content_type FROM Post WHERE id = ?', [postId]);
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
    return { outputFile, filename: `${post.title}_merged.mp3` };
}
