import JSZip from 'jszip';
import pLimit from 'p-limit';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const CONCURRENCY = 80;
const BUNNY_ACCESS_KEY = process.env.BUNNYCDN_ACCESS_KEY;

async function fetchAudio(audioUrl) {
    const res = await fetch(audioUrl, { headers: { AccessKey: BUNNY_ACCESS_KEY } });
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${audioUrl}`);
    return Buffer.from(await res.arrayBuffer());
}

// sentences: [{ order, audio }] audio là full URL bunny
function toSorted(sentences) {
    return [...sentences].filter(s => s.audio).sort((a, b) => a.order - b.order);
}

export async function downloadIndividual(sentences) {
    const sorted = toSorted(sentences);
    if (!sorted.length) throw new Error('Không có audio nào');

    const limit = pLimit(CONCURRENCY);
    const zip = new JSZip();
    let completed = 0;

    await Promise.all(sorted.map(s => limit(async () => {
        const buf = await fetchAudio(s.audio);
        zip.file(`${s.order}.mp3`, buf);
        completed++;
        console.log(`[individual] ${completed}/${sorted.length}`);
    })));

    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 } });
}

// Tạo 1 clip lặng dài `sec` (giống định dạng con voice). Trả path (cache theo sec).
function makeSilence(tmpDir, sec, tag) {
    const f = path.join(tmpDir, `silence_${tag}.mp3`);
    if (!fs.existsSync(f)) {
        execSync(`ffmpeg -f lavfi -i anullsrc=r=24000:cl=mono -t ${sec} -c:a libmp3lame -b:a 128k -ar 24000 -ac 1 -y "${f}"`);
    }
    return f;
}

// sentences: [{ order, audio }] cho voice thường, hoặc { order, sfx:true, cue, sfxFile?, silence? } cho podcast.
// opts.sfxSeconds: độ dài lặng mặc định cho 1 cue SFX chưa map file (mặc định 1.5s).
export async function downloadMerged(sentences, silenceDuration, tmpDir, opts = {}) {
    const sfxSeconds = opts.sfxSeconds ?? 1.5;
    // Giữ cả entry có audio LẪN entry sfx, sắp theo order
    const sorted = [...sentences].filter(s => s.audio || s.sfx).sort((a, b) => a.order - b.order);
    if (!sorted.length) throw new Error('Không có audio nào');

    fs.mkdirSync(tmpDir, { recursive: true });

    const silenceFile = path.join(tmpDir, 'silence.mp3');
    const listFile = path.join(tmpDir, 'list.txt');
    const outputFile = path.join(tmpDir, 'merged.mp3');

    // Tạo silence giữa các segment: libmp3lame 128k 24kHz mono
    if (silenceDuration > 0) {
        execSync(`ffmpeg -f lavfi -i anullsrc=r=24000:cl=mono -t ${silenceDuration} -c:a libmp3lame -b:a 128k -y "${silenceFile}"`);
    }

    // Fetch các entry có audio (song song 80 luồng). SFX không cần fetch.
    const limit = pLimit(CONCURRENCY);
    let completed = 0;
    const audioEntries = sorted.filter(s => s.audio);
    await Promise.all(audioEntries.map(s => limit(async () => {
        const buf = await fetchAudio(s.audio);
        fs.writeFileSync(path.join(tmpDir, `seg_${s.order}.mp3`), buf);
        completed++;
        console.log(`[merged] fetch ${completed}/${audioEntries.length}`);
    })));

    // Build list.txt theo đúng order; SFX -> file map sẵn hoặc clip lặng
    const lines = [];
    for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        let f;
        if (s.sfx) {
            f = (s.sfxFile && fs.existsSync(s.sfxFile)) ? s.sfxFile : makeSilence(tmpDir, s.silence ?? sfxSeconds, `sfx${s.silence ?? sfxSeconds}`);
        } else {
            f = path.join(tmpDir, `seg_${s.order}.mp3`);
            if (!fs.existsSync(f)) continue;
        }
        lines.push(`file '${f}'`);
        if (silenceDuration > 0 && i < sorted.length - 1) lines.push(`file '${silenceFile}'`);
    }
    fs.writeFileSync(listFile, lines.join('\n'));

    // Concat + re-encode libmp3lame giống con voice
    execSync(`ffmpeg -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -b:a 128k -ar 24000 -ac 1 -y "${outputFile}"`);

    return outputFile;
}
