import fs from 'fs';
import path from 'path';

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
    form.append('language', lang);
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

export async function generateAudios(projectDir, lang, speakerUuid) {
    const videosRoot = path.join(projectDir, 'assets', '_raw_videos');
    const outputDir = path.join(projectDir, 'output', lang, 'audios');

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const texts = [];
    const folderNames = [];
    if (fs.existsSync(videosRoot)) {
        const folders = fs.readdirSync(videosRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort((a, b) => parseInt(a) - parseInt(b));

        for (const folder of folders) {
            const ctxFile = path.join(videosRoot, folder, `${lang}.context.txt`);
            if (!fs.existsSync(ctxFile)) continue;
            texts.push(fs.readFileSync(ctxFile, 'utf-8').trim());
            folderNames.push(folder);
        }
    }

    if (!texts.length) {
        throw new Error(`Không tìm thấy file ${lang}.context.txt nào trong ${videosRoot}`);
    }

    const batchName = `${path.basename(projectDir)}_${lang}`;

    try {
        const createRes = await createBatch(batchName, texts, lang, speakerUuid);
        const batchUuid = createRes.data?.uuid || createRes.uuid;
        return { batch_uuid: batchUuid, outputDir, folderNames };
    } catch (err) {
        console.error(`[generateAudios] LỖI createBatch:`, err.message);
        throw err;
    }
}

export async function updateBatchStatus(batchUuid) {
    const res = await api(`/user/batch/${batchUuid}/status`, { method: 'PUT' });
    return res.json();
}

export async function downloadBatchAudios(batchUuid, outputDir, folderNames = []) {
    const batchData = await api(`/user/batch/${batchUuid}`).then(r => r.json());
    const status = batchData.data?.status || batchData.status;

    if (status !== 'OK') return null;

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const sentences = (batchData.data?.sentences || []).sort((a, b) => a.index - b.index);

    await Promise.all(
        sentences.map(async (s, i) => {
            const fileName = folderNames[i] || s.index;
            const savePath = path.join(outputDir, `${fileName}.mp3`);
            await downloadAudio(s.audio_url, savePath);
        })
    );

    return { total: sentences.length, outputDir };
}
