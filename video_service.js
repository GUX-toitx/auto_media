import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm']);
const isVideo = (file) => VIDEO_EXTS.has(path.extname(file).toLowerCase());

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { encoding: 'utf-8' }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
}

async function getDuration(filePath) {
    const out = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
    return parseFloat(JSON.parse(out).format.duration);
}

// Xử lý 1 câu: cắt video theo duration audio, xóa audio, lưu vào outputDir
async function processSentence(sentenceIndex, videoDir, audioPath, outputDir, maxClipDuration = 8) {
    const audioDuration = await getDuration(audioPath);

    const allVideos = fs.readdirSync(videoDir).filter(isVideo);
    const selected = allVideos.filter(f => f.startsWith('selected_')).sort((a, b) => parseInt(a.replace(/\D/g, '') || '0') - parseInt(b.replace(/\D/g, '') || '0'));
    const rest = allVideos.filter(f => !f.startsWith('selected_')).sort((a, b) => parseInt(a.replace(/\D/g, '') || '0') - parseInt(b.replace(/\D/g, '') || '0'));
    const videos = [...selected, ...rest];

    if (!videos.length) throw new Error(`No video files found in: ${videoDir}`);

    // Probe duration đồng thời
    const durations = await Promise.all(videos.map(f => getDuration(path.join(videoDir, f))));

    let remaining = audioDuration;
    const tasks = [];

    for (let i = 0; i < videos.length && remaining > 0; i++) {
        const take = Math.min(durations[i], maxClipDuration, remaining);
        const outputPath = path.join(outputDir, `${sentenceIndex}_${i + 1}.mp4`);
        tasks.push({ input: path.join(videoDir, videos[i]), outputPath, take });
        remaining -= take;
    }

    // Chạy ffmpeg đồng thời
    const results = await Promise.allSettled(
        tasks.map(async ({ input, outputPath, take }) => {
            try {
                await run('ffmpeg', ['-i', input, '-t', String(take), '-an', '-c:v', 'copy', '-y', outputPath]);
                return { file: path.basename(outputPath), duration: Math.round(take * 1000) / 1000 };
            } catch (e) {
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                throw e;
            }
        })
    );

    const processed = [];
    for (const r of results) {
        if (r.status === 'fulfilled') processed.push(r.value);
        else throw r.reason;
    }

    return {
        sentence: sentenceIndex,
        audio_duration: audioDuration,
        total_video_duration: Math.round((audioDuration - remaining) * 1000) / 1000,
        processed
    };
}

// Xử lý toàn bộ project
// projectDir: vd "1xNmGK_MN1Q"
// lang: vd "en"
export async function processAll(projectDir, lang = 'en', maxClipDuration = 8) {
    const videosRoot = path.join(projectDir, 'assets', '_raw_videos');
    const audiosDir = path.join(projectDir, 'output', lang, 'audios');
    const outputDir = path.join(projectDir, 'output', lang, 'videos');

    if (fs.existsSync(outputDir)) fs.readdirSync(outputDir).filter(f => f.endsWith('.mp4')).forEach(f => fs.unlinkSync(path.join(outputDir, f)));
    else fs.mkdirSync(outputDir, { recursive: true });

    // Tìm các câu có cả video folder + audio file
    const sentences = fs.readdirSync(videosRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .filter(name => fs.existsSync(path.join(audiosDir, `${name}.mp3`)))
        .sort((a, b) => parseInt(a) - parseInt(b));

    // Xử lý tất cả câu đồng thời
    const results = await Promise.allSettled(
        sentences.map(s => processSentence(
            s,
            path.join(videosRoot, s),
            path.join(audiosDir, `${s}.mp3`),
            outputDir,
            maxClipDuration
        ))
    );

    return results.map((r, i) => ({
        sentence: sentences[i],
        ...(r.status === 'fulfilled' ? r.value : { error: r.reason.message })
    }));
}
