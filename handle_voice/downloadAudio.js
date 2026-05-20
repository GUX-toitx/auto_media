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

export async function downloadMerged(sentences, silenceDuration, tmpDir) {
    const sorted = toSorted(sentences);
    if (!sorted.length) throw new Error('Không có audio nào');

    fs.mkdirSync(tmpDir, { recursive: true });

    const silenceFile = path.join(tmpDir, 'silence.mp3');
    const listFile = path.join(tmpDir, 'list.txt');
    const outputFile = path.join(tmpDir, 'merged.mp3');

    // Tạo silence giống hệt con voice: libmp3lame 128k 24kHz mono
    if (silenceDuration > 0) {
        execSync(`ffmpeg -f lavfi -i anullsrc=r=24000:cl=mono -t ${silenceDuration} -c:a libmp3lame -b:a 128k -y "${silenceFile}"`);
    }

    // Fetch song song 80 luồng
    const limit = pLimit(CONCURRENCY);
    let completed = 0;
    await Promise.all(sorted.map(s => limit(async () => {
        const buf = await fetchAudio(s.audio);
        fs.writeFileSync(path.join(tmpDir, `${s.order}.mp3`), buf);
        completed++;
        console.log(`[merged] fetch ${completed}/${sorted.length}`);
    })));

    // Build list.txt
    const lines = [];
    for (let i = 0; i < sorted.length; i++) {
        const f = path.join(tmpDir, `${sorted[i].order}.mp3`);
        if (!fs.existsSync(f)) continue;
        lines.push(`file '${f}'`);
        if (silenceDuration > 0 && i < sorted.length - 1) lines.push(`file '${silenceFile}'`);
    }
    fs.writeFileSync(listFile, lines.join('\n'));

    // Concat + re-encode libmp3lame giống con voice
    execSync(`ffmpeg -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -b:a 128k -ar 24000 -ac 1 -y "${outputFile}"`);

    return outputFile;
}
