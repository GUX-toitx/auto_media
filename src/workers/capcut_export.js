/**
 * CapCut Draft Export - Template Based
 * Uses real CapCut draft as template, only replaces materials/tracks/duration
 * Compatible with CapCut 8.7.0+ (app_version 171.0.0)
 */

// dotenv loaded by server, only load when run directly
if (process.argv[1]?.includes('capcut_export')) { await (async () => { const m = await import('dotenv/config'); })(); }
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { execSync } from 'child_process';

const MEDIA_DIR = process.env.MEDIA_DIR || '/usr/gux/media-team';
const DB_PATH = path.join(process.env.DB_DIR || path.join(MEDIA_DIR, 'db'), 'media_system.sqlite');
const getDb = () => open({ filename: DB_PATH, driver: sqlite3.Database });

// UUIDv4 với dấu gạch ngang, in hoa — đúng format CapCut
const uuid = () => crypto.randomUUID().toUpperCase();

// Microseconds timestamp
const nowUs = () => Date.now() * 1000;

// Load template — template_draft_*.json + capcut_template_0616/ nằm ở <gốc repo>/config
const TEMPLATE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'config');
const templateContent = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'template_draft_content.json'), 'utf8'));
const templateMeta = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'template_draft_meta_info.json'), 'utf8'));

function getMediaDuration(filePath) {
    try {
        const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, { encoding: 'utf8' });
        return Math.round(parseFloat(out.trim()) * 1_000_000) || 5_000_000;
    } catch { return 5_000_000; }
}

// Độ dài STREAM VIDEO thật (miệng), KHÔNG phải container (mp4 lips còn muxed audio thừa → container dài hơn).
function getVideoStreamDuration(filePath) {
    try {
        const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${filePath}"`, { encoding: 'utf8' });
        const d = parseFloat(out.trim());
        return d > 0 ? Math.round(d * 1_000_000) : 0;
    } catch { return 0; }
}

// Chuẩn hoá clip lips về ĐÚNG độ dài slot của voice:
//   - miệng chạy 1x (model sinh frame @25fps ↔ mốc thời gian audio → khớp tuyệt đối, KHÔNG kéo giãn)
//   - phần đuôi (audio còn lại, thường là im lặng model không sinh frame) → GIỮ KHUNG CUỐI (freeze)
//   - BỎ audio thừa trong mp4 (đằng nào CapCut cũng mute) → container.duration = video.duration = slot
// Nhờ vậy source_timerange == target_timerange == slot, speed thật 1.0 → hết drift, mặt luôn hiện.
// Trả về true nếu chuẩn hoá thành công; false → đã copy nguyên bản (giữ hành vi cũ).
function normalizeLipsClip(srcPath, destPath, slotUs) {
    const vdurUs = getVideoStreamDuration(srcPath) || slotUs;
    // Freeze khung cuối cho phần đuôi + đệm 0.12s để clip LUÔN ≥ slot (CapCut cắt về đúng slot ở source_timerange
    // = target_timerange = slot → speed thật 1.0, hết kéo giãn). Không dùng -t để tránh clip ngắn hơn slot 1 frame.
    const pad = Math.max(0, (slotUs - vdurUs) / 1_000_000) + 0.12;
    const vf = `-vf "tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}"`;
    try {
        execSync(
            `ffmpeg -y -v error -i "${srcPath}" -an ${vf} -r 25 -c:v libx264 -preset veryfast -pix_fmt yuv420p "${destPath}"`,
            { timeout: 60000 }
        );
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 20000) return true;
    } catch (e) { console.warn(`[CapCut] normalize lips lỗi (${path.basename(srcPath)}): ${e.message}`); }
    try { fs.copyFileSync(srcPath, destPath); } catch (_) {}
    return false;
}

// Freeze-pad 1 video b-roll (IN-PLACE) thành clip dài ≥ targetUs:
//   - phát ĐÚNG contentUs giây nội dung thật (= độ dài đã trim, KHÔNG phát trọn file → tránh "video thừa giây")
//   - rồi GIỮ KHUNG CUỐI lấp phần còn lại tới targetUs (tránh CapCut kéo giãn / đen / thiếu hình)
// contentUs đã được caller kẹp = min(trim, độ dài file) nên `-t` chỉ đọc đúng phần cần. Giữ audio (đuôi im lặng).
function freezePadClip(destPath, contentUs, targetUs) {
    if (targetUs <= contentUs + 1000) return false;                    // không cần freeze
    const contentSec = (contentUs / 1_000_000).toFixed(3);
    const pad = ((targetUs - contentUs) / 1_000_000 + 0.12).toFixed(3); // đệm để LUÔN ≥ target
    let hasAudio = false;
    try { hasAudio = execSync(`ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${destPath}"`, { encoding: 'utf8' }).trim().length > 0; } catch (_) {}
    const tmp = destPath.replace(/(\.[^.]+)$/, '_fz$1');
    const cmd = hasAudio
        ? `ffmpeg -y -v error -t ${contentSec} -i "${destPath}" -vf "tpad=stop_mode=clone:stop_duration=${pad}" -af "apad=pad_dur=${pad}" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "${tmp}"`
        : `ffmpeg -y -v error -t ${contentSec} -i "${destPath}" -an -vf "tpad=stop_mode=clone:stop_duration=${pad}" -c:v libx264 -preset veryfast -pix_fmt yuv420p "${tmp}"`;
    try {
        execSync(cmd, { timeout: 120000 });
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 10000) { fs.renameSync(tmp, destPath); return true; }
    } catch (e) { console.warn(`[CapCut] freeze-pad b-roll lỗi (${path.basename(destPath)}): ${e.message}`); }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return false;
}

function getMediaInfo(filePath) {
    try {
        const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`, { encoding: 'utf8' });
        let [w, h] = out.trim().split(',').map(Number);
        w = w || 1920; h = h || 1080;
        // Video quay ngang + cờ XOAY 90/270 (điện thoại quay dọc) → kích thước HIỂN THỊ đảo w/h.
        // Không xử lý thì tỉ lệ tính sai → CapCut ánh xạ khung sai → MÉO. (Video thường: rotation rỗng → bỏ qua.)
        try {
            const r = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation:stream_tags=rotate -of default=nw=1:nk=1 "${filePath}"`, { encoding: 'utf8' }).trim();
            const rot = r.split(/\s+/).map(x => parseInt(x, 10)).find(x => !isNaN(x));
            if (rot !== undefined && (Math.abs(rot) % 180) === 90) { const t = w; w = h; h = t; }
        } catch (_) {}
        return { width: w, height: h };
    } catch { return { width: 1920, height: 1080 }; }
}

const WIN_DRAFT_ROOT = 'C:/Users/trinh/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft';

// ===== Vị trí clip Lips Sync trên khung hình (khớp panel "Biến đổi" của CapCut) =====
// Tỷ lệ = %, tọa độ CapCut theo NỬA canvas: X dương = sang phải, Y dương = lên trên → x = X/960, y = Y/540.
// LUÔN NEO GÓC DƯỚI-PHẢI: tính tâm clip theo kích thước hiển thị THỰC của từng clip (phụ thuộc tỉ lệ),
// nên mọi video lips đều nằm đúng góc dưới-phải như nhau (không còn lệch mỗi video mỗi khác).
const LIPS_SCALE = Number(process.env.LIPS_CLIP_SCALE ?? 0.65);       // 65%
const LIPS_MARGIN_X = Number(process.env.LIPS_CLIP_MARGIN_X ?? 0);    // px cách MÉP PHẢI (0 = sát mép)
const LIPS_MARGIN_Y = Number(process.env.LIPS_CLIP_MARGIN_Y ?? 0);    // px cách MÉP DƯỚI (0 = sát mép)

// Tính transform (tâm clip, chuẩn CapCut nửa-canvas) để neo góc DƯỚI-PHẢI cho clip lips.
// CapCut scale=1.0 = fit CONTAIN vào canvas → kích thước hiển thị phụ thuộc tỉ lệ clip.
function lipsBottomRightTransform(w, h, scale) {
    const CANVAS_W = 1920, CANVAS_H = 1080;
    const arCanvas = CANVAS_W / CANVAS_H;
    const arMat = (w > 0 && h > 0) ? w / h : arCanvas;
    let dispW, dispH;
    if (arMat >= arCanvas) { dispW = CANVAS_W; dispH = CANVAS_W / arMat; }   // clip rộng → chạm bề ngang
    else { dispH = CANVAS_H; dispW = CANVAS_H * arMat; }                     // clip cao → chạm bề dọc
    dispW *= scale; dispH *= scale;
    const centerX = (CANVAS_W / 2 - LIPS_MARGIN_X) - dispW / 2;   // cạnh phải sát mép phải
    const centerY = (-CANVAS_H / 2 + LIPS_MARGIN_Y) + dispH / 2;  // cạnh dưới sát mép dưới (Y dương = lên)
    return { x: centerX / (CANVAS_W / 2), y: centerY / (CANVAS_H / 2) };
}

// Build video material dựa trên template thật
function buildVideoMaterial(matId, assetLocalPath, duration, name, isVideo, draftId) {
    const info = isVideo ? getMediaInfo(assetLocalPath) : { width: 1920, height: 1080 };
    const base = JSON.parse(JSON.stringify(templateContent.materials.videos[0]));
    const winPath = `${WIN_DRAFT_ROOT}/${draftId}/assets/${name}`;
    return {
        ...base,
        id: matId,
        type: isVideo ? 'video' : 'photo',
        duration: isVideo ? duration : 10_800_000_000,
        path: winPath,
        material_name: name,
        width: info.width,
        height: info.height,
        has_audio: isVideo,
        unique_id: '',
        material_id: '',
        material_url: '',
        local_id: '',
        local_material_id: '',
    };
}

// Build audio material dựa trên template thật
function buildAudioMaterial(matId, assetLocalPath, duration, name) {
    const base = JSON.parse(JSON.stringify(templateContent.materials.audios[0]));
    return {
        ...base,
        id: matId,
        type: 'music',
        name: name,
        duration: duration,
        path: assetLocalPath,
        category_name: 'local',
        music_id: '',
        app_id: 0,
        request_id: '',
    };
}

// 6 preset Ken Burns xen kẽ
const KB_PRESETS = [
    { s0: 1.0,  s1: 1.08, x0: 0.0,   x1: 0.0   },
    { s0: 1.08, s1: 1.0,  x0: 0.0,   x1: 0.0   },
    { s0: 1.05, s1: 1.05, x0: 0.04,  x1: -0.04 },
    { s0: 1.05, s1: 1.05, x0: -0.04, x1: 0.04  },
    { s0: 1.0,  s1: 1.08, x0: -0.03, x1: 0.03  },
    { s0: 1.08, s1: 1.0,  x0: 0.03,  x1: -0.03 },
];

function buildKenBurnsKeyframes(duration, presetIndex, s0, s1) {
    const p = KB_PRESETS[presetIndex % KB_PRESETS.length];
    const makeKF = (property, values) => ({
        id: uuid(),
        property_type: property,
        keyframe_list: values.map(({ time, v }) => ({
            id: uuid(),
            time_offset: time,
            values: [v],
            left_control: { x: 0.0, y: 0.0 },
            right_control: { x: 0.0, y: 0.0 },
            curveType: 'Line',
        }))
    });
    // Nhích keyframe vào trong 1 chút (không đặt sát đầu/cuối) cho dễ click khi edit.
    // Margin ~8% mỗi bên, tối đa 0.3s; guard cho slot quá ngắn.
    const margin = Math.min(Math.round(duration * 0.08), 300_000);
    const t0 = duration > margin * 2 + 1 ? margin : 0;
    const t1 = duration > margin * 2 + 1 ? duration - margin : duration;
    return [
        makeKF('KFTypeScaleX',    [{ time: t0, v: s0 }, { time: t1, v: s1 }]),
        makeKF('KFTypeScaleY',    [{ time: t0, v: s0 }, { time: t1, v: s1 }]),
        makeKF('KFTypePositionX', [{ time: t0, v: p.x0 }, { time: t1, v: p.x1 }]),
    ];
}

// Build video segment dựa trên template thật
// slotDur = độ dài chiếm trên timeline (= slice audio). srcDur = độ dài nguồn thực sự phát (<= slotDur).
function buildVideoSegment(matId, startTime, slotDur, srcDur, presetIndex, matWidth, matHeight, isVideo = false) {
    const base = JSON.parse(JSON.stringify(templateContent.tracks[0].segments[0]));
    const segId = uuid();
    const speedId = uuid();
    const placeholderId = uuid();
    const canvasId = uuid();
    const soundChannelId = uuid();
    const colorId = uuid();
    const vocalId = uuid();

    // Tính scale để media fill (cover) canvas 1920x1080.
    // CapCut: scale 1.0 = fit vừa khung -> cover dựa trên TỈ LỆ khung hình, không phải số pixel.
    // (vd 16:9 dù 640x360 hay 1920x1080 đều chỉ cần fillScale = 1.0)
    const CANVAS_W = 1920, CANVAS_H = 1080;
    const w = matWidth || CANVAS_W;
    const h = matHeight || CANVAS_H;
    const arCanvas = CANVAS_W / CANVAS_H;
    const arMat = w / h;
    const fillScale = Math.max(arCanvas / arMat, arMat / arCanvas);

    // Video DỌC (9:16, 3:4... chiều cao > chiều rộng) → CONTAIN (scale 1.0): GIỮ NGUYÊN khung, hiện trọn khung,
    // không cover-crop/méo. Video NGANG/ảnh → COVER (fillScale) phủ đầy như cũ.
    const isPortraitVideo = isVideo && h > w;
    const baseScale = isPortraitVideo ? 1.0 : fillScale;

    // Video: đứng yên (chỉ cover, không Ken Burns). Ảnh tĩnh: áp Ken Burns (zoom/pan nhẹ).
    const p = KB_PRESETS[presetIndex % KB_PRESETS.length];
    const s0 = isVideo ? baseScale : baseScale * p.s0;
    const s1 = isVideo ? baseScale : baseScale * p.s1;
    const tx0 = isVideo ? 0.0 : p.x0;

    const kbPresets = isVideo ? [] : buildKenBurnsKeyframes(slotDur, presetIndex, s0, s1);

    return {
        segment: {
            ...base,
            id: segId,
            material_id: matId,
            source_timerange: { start: 0, duration: srcDur },
            target_timerange: { start: startTime, duration: slotDur },
            render_timerange: { start: 0, duration: 0 },
            extra_material_refs: [speedId, placeholderId, canvasId, soundChannelId, colorId, vocalId],
            render_index: 0,
            track_render_index: 0,
            common_keyframes: kbPresets,
            keyframe_refs: [],
            // clip.scale = fillScale để media fill full màn hình
            clip: {
                scale: { x: s0, y: s0 },
                rotation: 0.0,
                transform: { x: tx0, y: 0.0 },
                flip: { vertical: false, horizontal: false },
                alpha: 1.0
            },
            uniform_scale: { on: true, value: s0 },
        },
        extraMaterials: { speedId, placeholderId, canvasId, soundChannelId, colorId, vocalId }
    };
}

// Build audio segment dựa trên template thật
function buildAudioSegment(matId, startTime, duration, extraRefs) {
    const base = JSON.parse(JSON.stringify(templateContent.tracks[2].segments[0]));
    const segId = uuid();
    const speedId = uuid();
    const placeholderId = uuid();
    const beatsId = uuid();
    const vocalId = uuid();
    const soundChannelId = uuid();
    return {
        segment: {
            ...base,
            id: segId,
            material_id: matId,
            source_timerange: { start: 0, duration },
            target_timerange: { start: startTime, duration },
            render_timerange: { start: 0, duration: 0 },
            extra_material_refs: [speedId, placeholderId, beatsId, vocalId, soundChannelId],
            render_index: 0,
            track_render_index: 0,
        },
        extraMaterials: {
            speedId, placeholderId, beatsId, vocalId, soundChannelId
        }
    };
}

export async function exportCapcut(postId, outputDir, contentType = null) {
    const db = await getDb();
    const post = await db.get('SELECT * FROM Post WHERE id = ?', [postId]);
    if (!post) throw new Error(`Post ${postId} not found`);

    const projectId = post.project_id.replace(/_[a-z]{2}$/, '');
    // contentType override: 'content_vi' | 'content' | 'both' | null (auto dari voice_content_type)
    const resolvedType = contentType || post.voice_content_type || 'content_vi';
    const bothLangs = resolvedType === 'both';
    const isVi = resolvedType === 'content_vi';
    // Khi xuất cả 2: track chính (có tiếng, định độ dài timeline) = ngôn ngữ đích; track phụ (mute) = tiếng Việt.
    const primaryUseVi = bothLangs ? false : isVi;

    console.log(`[CapCut] Export post ${postId} (${post.project_id}) contentType=${resolvedType}`);

    const paragraphs = await db.all(`SELECT * FROM Paragraph WHERE post_id = ? ORDER BY "order"`, [postId]);

    // Thumbnail đã chọn -> dùng làm ảnh bìa (draft_cover.jpg). Query khi db còn mở.
    const coverAsset = await db.get(
        `SELECT file_path FROM Asset WHERE post_id = ? AND COALESCE(section,'') = 'thumbnail' AND selected = 1 ORDER BY "order", id LIMIT 1`,
        [postId]
    );

    // Tạo thư mục draft
    const draftId = uuid();
    const draftDir = path.join(outputDir, draftId);
    const assetsDir = path.join(draftDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });

    // Clone template
    const content = JSON.parse(JSON.stringify(templateContent));
    const meta = JSON.parse(JSON.stringify(templateMeta));

    // Reset
    content.id = draftId;
    content.materials.videos = [];
    content.materials.audios = [];
    content.materials.texts = [];
    content.materials.speeds = [];
    content.materials.canvases = [];
    content.materials.vocal_separations = [];
    content.materials.placeholder_infos = [];
    content.materials.beats = [];
    content.materials.material_colors = [];
    content.materials.sound_channel_mappings = [];
    content.tracks = [];
    content.canvas_config = { ratio: '16:9', width: 1920, height: 1080, background: null };

    let fileIndex = 0;
    let videoIndex = 0;
    let totalDuration = 0;
    const videoSegments = [];
    const audioSegments = [];
    const audioSegments2 = []; // track audio thứ 2 (ngôn ngữ còn lại, mute) khi xuất cả 2
    const allExtraMaterials = { speeds: [], canvases: [], vocal_separations: [], placeholder_infos: [], beats: [], material_colors: [], sound_channel_mappings: [] };

    // Tải + ghép audio của 1 paragraph theo ngôn ngữ (useVi). allowFallback: dùng field còn lại nếu rỗng.
    // Trả về { audioMatId, audioDuration } và đẩy audio material vào content.materials.audios.
    async function buildParaAudio(para, useVi, allowFallback) {
        const audioField = useVi ? 'content_vi_audio' : 'content_audio';
        const altField   = useVi ? 'content_audio' : 'content_vi_audio';
        const paraAudioUrl = para[audioField] || (allowFallback ? para[altField] : null) || para['audio'];
        const paraDetails = await db.all(
            `SELECT ${audioField}, ${altField} FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"`,
            [para.id]
        );
        const detailAudioUrls = paraDetails.map(d => d[audioField] || (allowFallback ? d[altField] : null)).filter(Boolean);
        const audioUrls = paraAudioUrl ? [paraAudioUrl] : detailAudioUrls;
        if (!audioUrls.length) return { audioMatId: null, audioDuration: 0 };
        try {
            const bunnyBase = process.env.BUNNYCDN_BASE_URL || '';
            const bunnyKey = process.env.BUNNYCDN_ACCESS_KEY || '';
            const tmpFiles = [];
            for (let ai = 0; ai < audioUrls.length; ai++) {
                const url = audioUrls[ai].startsWith('http') ? audioUrls[ai] : `${bunnyBase}/${audioUrls[ai]}`;
                const tmpPath = path.join(assetsDir, `_tmp_audio_${fileIndex}_${ai}.mp3`);
                execSync(`curl -sL -H "AccessKey: ${bunnyKey}" "${url}" -o "${tmpPath}"`, { timeout: 15000 });
                if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) tmpFiles.push(tmpPath);
            }
            if (!tmpFiles.length) return { audioMatId: null, audioDuration: 0 };
            const audioFileName = `audio_${fileIndex++}.mp3`;
            const audioLocalPath = path.join(assetsDir, audioFileName);
            if (tmpFiles.length === 1) {
                fs.renameSync(tmpFiles[0], audioLocalPath);
            } else {
                const listFile = path.join(assetsDir, `_list_${fileIndex}.txt`);
                fs.writeFileSync(listFile, tmpFiles.map(f => `file '${f}'`).join('\n'));
                execSync(`ffmpeg -f concat -safe 0 -i "${listFile}" -c copy -y "${audioLocalPath}"`, { timeout: 30000 });
                tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(_) {} });
                fs.unlinkSync(listFile);
            }
            if (!(fs.existsSync(audioLocalPath) && fs.statSync(audioLocalPath).size > 1000)) return { audioMatId: null, audioDuration: 0 };
            const audioDuration = getMediaDuration(audioLocalPath);
            const audioMatId = uuid();
            const winAudioPath = `${WIN_DRAFT_ROOT}/${draftId}/assets/${audioFileName}`;
            content.materials.audios.push(buildAudioMaterial(audioMatId, winAudioPath, audioDuration, audioFileName));
            return { audioMatId, audioDuration };
        } catch (e) {
            console.error(`[CapCut] Audio error para ${para.order}: ${e.message}`);
            return { audioMatId: null, audioDuration: 0 };
        }
    }

    // Tạo audio segment + extra materials, đẩy vào track chỉ định. mute=true -> volume 0 (track tham chiếu).
    function pushAudioSegment(audioMatId, segStart, audioDuration, targetArr, mute) {
        const { segment, extraMaterials } = buildAudioSegment(audioMatId, segStart, audioDuration, []);
        if (mute) { segment.volume = 0.0; segment.last_nonzero_volume = 0.0; }
        targetArr.push(segment);
        content.materials.speeds.push({ ...JSON.parse(JSON.stringify(templateContent.materials.speeds[0])), id: extraMaterials.speedId });
        content.materials.placeholder_infos.push({ ...JSON.parse(JSON.stringify(templateContent.materials.placeholder_infos[0])), id: extraMaterials.placeholderId });
        content.materials.beats.push({ ...JSON.parse(JSON.stringify(templateContent.materials.beats[0])), id: extraMaterials.beatsId });
        content.materials.vocal_separations.push({ ...JSON.parse(JSON.stringify(templateContent.materials.vocal_separations[0])), id: extraMaterials.vocalId });
        content.materials.sound_channel_mappings.push({ ...JSON.parse(JSON.stringify(templateContent.materials.sound_channel_mappings[0])), id: extraMaterials.soundChannelId });
    }

    // Thêm 1 video nguyên vẹn (intro/outro) vào track video tại startTime, phát đúng độ dài thực + giữ audio gốc.
    // Không sinh audio narration, không đụng đến các đoạn -> chỉ chèn ở đầu/cuối.
    function addBoundaryVideo(absPath, startTime, label) {
        if (!absPath || !fs.existsSync(absPath)) {
            if (absPath) console.error(`[CapCut] ${label} không tồn tại: ${absPath}`);
            return 0;
        }
        const ext = path.extname(absPath).toLowerCase();
        const isVideo = ['.mp4', '.mov', '.avi'].includes(ext);
        const fileName = `${label}_${fileIndex++}${ext}`;
        const destPath = path.join(assetsDir, fileName);
        fs.copyFileSync(absPath, destPath);
        const mediaInfo = isVideo ? getMediaInfo(destPath) : { width: 1920, height: 1080 };
        const dur = isVideo ? getMediaDuration(destPath) : 5_000_000;
        const matId = uuid();
        content.materials.videos.push(buildVideoMaterial(matId, destPath, dur, fileName, isVideo, draftId));
        const { segment, extraMaterials } = buildVideoSegment(matId, startTime, dur, dur, videoIndex++, mediaInfo.width, mediaInfo.height, isVideo);
        videoSegments.push(segment);
        content.materials.speeds.push({ ...JSON.parse(JSON.stringify(templateContent.materials.speeds[0])), id: extraMaterials.speedId });
        content.materials.canvases.push({ ...JSON.parse(JSON.stringify(templateContent.materials.canvases[0])), id: extraMaterials.canvasId });
        content.materials.material_colors.push({ ...JSON.parse(JSON.stringify(templateContent.materials.material_colors[0])), id: extraMaterials.colorId });
        content.materials.vocal_separations.push({ ...JSON.parse(JSON.stringify(templateContent.materials.vocal_separations[0])), id: extraMaterials.vocalId });
        content.materials.placeholder_infos.push({ ...JSON.parse(JSON.stringify(templateContent.materials.placeholder_infos[0])), id: extraMaterials.placeholderId });
        content.materials.sound_channel_mappings.push({ ...JSON.parse(JSON.stringify(templateContent.materials.sound_channel_mappings[0])), id: extraMaterials.soundChannelId });
        console.log(`[CapCut] ${label}: ${fileName} (${(dur/1e6).toFixed(1)}s) @ ${(startTime/1e6).toFixed(1)}s`);
        return dur;
    }

    // INTRO: chèn ở đầu (start = 0), đẩy toàn bộ đoạn ra sau.
    if (post.intro_path) totalDuration += addBoundaryVideo(path.join(MEDIA_DIR, post.intro_path), totalDuration, 'intro');

    // ===== DỰNG TIMELINE THEO TỪNG CÂU (audio + lips + b-roll khớp nhau) =====
    // Mỗi câu (unit trong getAllAudioUrls) = 1 audio segment + 1 clip lips, đặt CÙNG mốc thời gian,
    // giữa 2 câu chèn khoảng nghỉ = silence_duration (giống mp3 gốc) → lips khớp tiếng.
    const lipsType = (resolvedType === 'content_vi') ? 'content_vi' : 'content';
    const lipsByIdx = {};   // idx (thứ tự câu) → file lips .mp4 (file thật trên đĩa)
    try {
        const lipsRows = await db.all('SELECT idx, output_path, content_type FROM LipsSyncJob WHERE post_id = ? ORDER BY idx', [postId]);
        for (const r of lipsRows) {
            if ((r.content_type || 'content') !== lipsType) continue;
            if (!r.output_path) continue;
            // Ưu tiên bản ĐÃ XOÁ NỀN (N_green.mp4 — người trên nền xanh, CapCut chroma key là mất nền).
            const greenPath = r.output_path.replace(/\.mp4$/i, '_green.mp4');
            const use = (fs.existsSync(greenPath) && (() => { try { return fs.statSync(greenPath).size > 20000; } catch (_) { return false; } })()) ? greenPath : r.output_path;
            try { if (fs.existsSync(use) && fs.statSync(use).size > 20000) lipsByIdx[r.idx] = use; } catch (_) {}
        }
    } catch (_) {}
    // KHÔNG chèn khoảng nghỉ giữa câu trong timeline CapCut: mỗi mp3 voice đã có sẵn đuôi im lặng riêng,
    // và độ dài "narration" hiển thị trên giao diện = TỔNG audio thuần (không cộng silence). Cộng thêm silence
    // ở đây làm timeline CapCut dài hơn số trên UI → video user trim theo UI bị THIẾU. Đặt 0 để CapCut == UI.
    const silenceUs = 0;
    const lipsSegments = [];

    const af = primaryUseVi ? 'content_vi_audio' : 'content_audio';
    const afAlt = primaryUseVi ? 'content_audio' : 'content_vi_audio';
    const tf = primaryUseVi ? 'title_vi_audio' : 'title_audio';
    const tfAlt = primaryUseVi ? 'title_audio' : 'title_vi_audio';

    // Tải 1 audio unit về assets, trả { matId, durUs }. nameBase → tên file (khớp tên với clip lips cùng câu).
    const fetchUnitAudio = (url, nameBase) => {
        if (!url) return null;
        try {
            const base = process.env.BUNNYCDN_BASE_URL || '', key = process.env.BUNNYCDN_ACCESS_KEY || '';
            const full = url.startsWith('http') ? url : `${base}/${url}`;
            const fn = `${nameBase || ('audio_' + (fileIndex++))}.mp3`;
            const dest = path.join(assetsDir, fn);
            // Retry: mạng chập chờn tới CDN mà tải hụt 1 câu → slot rơi về mặc định → timeline bị nén → lips LỆCH DẦN.
            execSync(`curl -sL --retry 4 --retry-delay 1 --retry-all-errors --max-time 45 -H "AccessKey: ${key}" "${full}" -o "${dest}"`, { timeout: 60000 });
            if (!(fs.existsSync(dest) && fs.statSync(dest).size > 1000)) return null;
            const durUs = getMediaDuration(dest);
            const matId = uuid();
            content.materials.audios.push(buildAudioMaterial(matId, `${WIN_DRAFT_ROOT}/${draftId}/assets/${fn}`, durUs, fn));
            return { matId, durUs };
        } catch (e) { console.error('[CapCut] audio unit lỗi:', e.message); return null; }
    };
    // Đặt clip lips tại start, slot = slotDur (khớp audio; lips ngắn hơn → đứng hình, dài hơn → cắt). Mute.
    const placeLips = (lipsPath, start, slotDur, nameBase) => {
        if (!lipsPath || !fs.existsSync(lipsPath)) return;
        const fn = `${nameBase || ('lips_' + (fileIndex++))}.mp4`;
        const dest = path.join(assetsDir, fn);
        // Chuẩn hoá về đúng slot voice (1x + freeze đuôi + bỏ audio thừa) → hết lệch dần.
        if (!fs.existsSync(dest)) { try { normalizeLipsClip(lipsPath, dest, slotDur); } catch (_) { return; } }
        if (!fs.existsSync(dest)) return;
        const info = getMediaInfo(dest); const lipsDur = getMediaDuration(dest);
        const matId = uuid();
        const lipsMat = buildVideoMaterial(matId, dest, lipsDur, fn, true, draftId);
        // Xoá nền: dùng bản N_green.mp4 (người trên nền xanh) + Chroma key trong CapCut. KHÔNG dùng matting flag
        // (智能抠像 qua draft không đáng tin cậy giữa các bản CapCut).
        // KHOÁ tỉ lệ crop về đúng tỉ lệ gốc của clip (thay vì "free") → khi user KÉO TAY thu nhỏ trong CapCut,
        // clip GIỮ NGUYÊN tỉ lệ, không nhảy 3:4/16:9 (clip lips là overlay nên "free" bị snap theo preset).
        { const g = (a, b) => (b ? g(b, a % b) : a) , k = g(info.width, info.height) || 1;
          lipsMat.crop_ratio = `${Math.round(info.width / k)}:${Math.round(info.height / k)}`; lipsMat.crop_scale = 1; }
        content.materials.videos.push(lipsMat);
        const srcDur = Math.min(lipsDur, slotDur);
        const { segment, extraMaterials } = buildVideoSegment(matId, start, slotDur, srcDur, videoIndex++, info.width, info.height, true);
        segment.volume = 0.0;
        // Thu nhỏ + LUÔN neo góc DƯỚI-PHẢI (tính theo kích thước hiển thị của chính clip → mọi video như nhau).
        segment.clip.scale = { x: LIPS_SCALE, y: LIPS_SCALE };
        segment.clip.transform = lipsBottomRightTransform(info.width, info.height, LIPS_SCALE);
        segment.uniform_scale = { on: true, value: LIPS_SCALE };
        lipsSegments.push(segment);
        content.materials.speeds.push({ ...JSON.parse(JSON.stringify(templateContent.materials.speeds[0])), id: extraMaterials.speedId });
        content.materials.canvases.push({ ...JSON.parse(JSON.stringify(templateContent.materials.canvases[0])), id: extraMaterials.canvasId });
        content.materials.material_colors.push({ ...JSON.parse(JSON.stringify(templateContent.materials.material_colors[0])), id: extraMaterials.colorId });
        content.materials.vocal_separations.push({ ...JSON.parse(JSON.stringify(templateContent.materials.vocal_separations[0])), id: extraMaterials.vocalId });
        content.materials.placeholder_infos.push({ ...JSON.parse(JSON.stringify(templateContent.materials.placeholder_infos[0])), id: extraMaterials.placeholderId });
        content.materials.sound_channel_mappings.push({ ...JSON.parse(JSON.stringify(templateContent.materials.sound_channel_mappings[0])), id: extraMaterials.soundChannelId });
    };
    // Rải b-roll phủ [sceneStart, sceneStart+sceneDur]: mỗi asset chạy ĐÚNG duration đã đặt (nối tiếp),
    // asset CUỐI kéo dài lấp hết khoảng còn lại → tổng luôn khớp lời của sub-scene. Trả về segment cuối
    // (để sub-scene không có media kéo dài clip trước phủ vào, tránh nền đen).
    let lastBrollSeg = null;
    const brollVideoClips = [];   // {segment, material, destPath} — video b-roll, để hậu xử lý freeze-pad nếu bị kéo giãn
    const SNAP_US = 400_000;   // ngưỡng snap b-roll vào mốc kết thúc câu (0.4s): sửa lệch nhỏ, không gộp cả câu
    const layBroll = (assets, sceneStart, sceneDur, unitEnds = []) => {
        if (sceneDur <= 0) return;
        if (!assets.length) {                               // sub-scene không có media → nối dài clip trước
            if (lastBrollSeg) lastBrollSeg.target_timerange.duration += Math.round(sceneDur);
            return;
        }
        let cur = sceneStart;
        const end = sceneStart + sceneDur;
        for (let ai = 0; ai < assets.length; ai++) {
            if (cur >= end - 1000) break;                   // hết chỗ (đã lấp đủ lời)
            const asset = assets[ai];
            const isLast = ai === assets.length - 1;
            const want = asset.duration > 0 ? Math.round(asset.duration * 1_000_000) : 3_000_000;
            // asset cuối (hoặc asset tràn qua end) → lấp trọn phần còn lại; còn lại chạy đúng duration đặt
            let slotDur = (isLast || cur + want > end) ? (end - cur) : want;
            // SNAP điểm kết thúc clip vào MỐC KẾT THÚC CÂU gần nhất (audio/lips) trong ngưỡng → video khớp từng câu,
            // lấp nốt phần hụt nhỏ (freeze-pad đứng hình) thay vì để lệch dần / câu sau bắt đầu sớm.
            if (!isLast && unitEnds.length) {
                const clipEnd = cur + slotDur;
                let best = null, bestD = SNAP_US;
                for (const b of unitEnds) { const d = Math.abs(b - clipEnd); if (d <= bestD && b > cur + 1_000_000 && b <= end + 1) { best = b; bestD = d; } }
                if (best != null) slotDur = best - cur;
            }
            const srcPath = path.join(MEDIA_DIR, asset.file_path);
            if (!fs.existsSync(srcPath)) { cur += slotDur; continue; }
            const ext = path.extname(asset.file_path).toLowerCase();
            const assetFileName = `asset_${fileIndex++}${ext}`;
            const destPath = path.join(assetsDir, assetFileName);
            fs.copyFileSync(srcPath, destPath);
            const isVideo = ['.mp4', '.mov', '.avi'].includes(ext);
            const mediaInfo = isVideo ? getMediaInfo(destPath) : { width: 1920, height: 1080 };
            const realDur = isVideo ? (asset.duration ? Math.round(asset.duration * 1_000_000) : slotDur) : slotDur;
            const srcDur = isVideo ? Math.min(realDur, slotDur) : slotDur;
            const matId = uuid();
            const brollMat = buildVideoMaterial(matId, destPath, isVideo ? realDur : slotDur, assetFileName, isVideo, draftId);
            content.materials.videos.push(brollMat);
            const { segment, extraMaterials } = buildVideoSegment(matId, cur, slotDur, srcDur, videoIndex++, mediaInfo.width, mediaInfo.height, isVideo);
            videoSegments.push(segment);
            lastBrollSeg = segment;
            if (isVideo) brollVideoClips.push({ segment, material: brollMat, destPath });
            content.materials.speeds.push({ ...JSON.parse(JSON.stringify(templateContent.materials.speeds[0])), id: extraMaterials.speedId });
            content.materials.canvases.push({ ...JSON.parse(JSON.stringify(templateContent.materials.canvases[0])), id: extraMaterials.canvasId });
            content.materials.material_colors.push({ ...JSON.parse(JSON.stringify(templateContent.materials.material_colors[0])), id: extraMaterials.colorId });
            content.materials.vocal_separations.push({ ...JSON.parse(JSON.stringify(templateContent.materials.vocal_separations[0])), id: extraMaterials.vocalId });
            content.materials.placeholder_infos.push({ ...JSON.parse(JSON.stringify(templateContent.materials.placeholder_infos[0])), id: extraMaterials.placeholderId });
            content.materials.sound_channel_mappings.push({ ...JSON.parse(JSON.stringify(templateContent.materials.sound_channel_mappings[0])), id: extraMaterials.soundChannelId });
            cur += slotDur;
        }
    };

    // Xây danh sách SCENE theo ĐÚNG thứ tự getAllAudioUrls (để idx lips khớp).
    const sectionScene = async (table, sectionKey) => {
        const rows = await db.all(`SELECT ${af} AS au, ${afAlt} AS al FROM ${table} WHERE post_id = ? ORDER BY "order"`, [postId]);
        const units = rows.map(r => ({ au: r.au, al: r.al })).filter(u => u.au || u.al);
        const assets = await db.all(`SELECT * FROM Asset WHERE selected = 1 AND post_id = ? AND section = ? ORDER BY "order", id`, [postId, sectionKey]);
        return { units, assets };
    };
    const scenes = [];
    scenes.push(await sectionScene('HookDetail', 'hook'));
    scenes.push(await sectionScene('SummaryDetail', 'summary'));
    const parasSeq = await db.all('SELECT id FROM Paragraph WHERE post_id = ? ORDER BY id', [postId]);   // khớp getAllAudioUrls (ORDER BY id)
    for (const para of parasSeq) {
        // Sub-scene 1: RIÊNG luận điểm = title + chi tiết luận điểm → media chọn ở cấp luận điểm (sentence_id NULL)
        const ownUnits = [];
        const p = await db.get(`SELECT ${tf} AS tu, ${tfAlt} AS ta FROM Paragraph WHERE id = ?`, [para.id]);
        if (p.tu || p.ta) ownUnits.push({ au: p.tu, al: p.ta });
        const pd = await db.all(`SELECT ${af} AS au, ${afAlt} AS al FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"`, [para.id]);
        for (const d of pd) if (d.au || d.al) ownUnits.push({ au: d.au, al: d.al });
        const ownAssets = await db.all(`SELECT * FROM Asset WHERE paragraph_id = ? AND sentence_id IS NULL AND selected = 1 ORDER BY "order", id`, [para.id]);
        if (ownUnits.length) scenes.push({ units: ownUnits, assets: ownAssets });
        // Sub-scene mỗi luận cứ (#x.y): chi tiết câu → media chọn RIÊNG cho câu đó (sentence_id = s.id)
        const sents = await db.all(`SELECT id, ${tf} AS tu, ${tfAlt} AS ta FROM Sentence WHERE paragraph_id = ? ORDER BY "order"`, [para.id]);
        for (const s of sents) {
            const sUnits = [];
            if (s.tu || s.ta) sUnits.push({ au: s.tu, al: s.ta });
            const sd = await db.all(`SELECT ${af} AS au, ${afAlt} AS al FROM SentenceDetail WHERE sentence_id = ? ORDER BY "order"`, [s.id]);
            for (const d of sd) if (d.au || d.al) sUnits.push({ au: d.au, al: d.al });
            if (!sUnits.length) continue;
            const sAssets = await db.all(`SELECT * FROM Asset WHERE sentence_id = ? AND selected = 1 ORDER BY "order", id`, [s.id]);
            scenes.push({ units: sUnits, assets: sAssets });
        }
    }
    scenes.push(await sectionScene('ConclusionDetail', 'conclusion'));

    // Duyệt scene: mỗi câu → audio segment + lips (cùng mốc), giữa các câu chèn silence.
    // B-ROLL: kết thúc ĐÚNG lúc audio câu cuối (bỏ 1s nghỉ dư cuối cảnh, không giữ hình thừa);
    // khoảng nghỉ giữa 2 cảnh do ẢNH/VIDEO cảnh sau bắt đầu SỚM (từ mốc audio-end cảnh trước) lấp vào.
    let lipsIdx = 0, placedLips = 0, prevBrollEnd = null, audioFail = 0;
    for (const scene of scenes) {
        const sceneStart = totalDuration;
        const unitEnds = [];   // mốc kết thúc (tuyệt đối) của TỪNG câu audio/lips → để snap b-roll cho khớp
        for (const unit of scene.units) {
            const primaryUrl = unit.au || (!bothLangs ? unit.al : null);
            if (unit.au) lipsIdx++;                          // idx khớp getAllAudioUrls (đếm theo audio ngôn ngữ chính)
            // Tên file theo SỐ CÂU (cauN_*) để track audio & track lips song song hiển thị CÙNG tên/câu trong CapCut.
            // Câu chỉ có audio phụ (không phải ngôn ngữ chính, không có lips) → tên riêng để không đè lên câu chính.
            const nb = unit.au ? `cau${lipsIdx}` : `phu${fileIndex++}`;
            const a = fetchUnitAudio(primaryUrl, `${nb}_voice`);
            // Tải audio lỗi: KHÔNG dùng slot cứng 2s (làm timeline nén → lips lệch dần). Ưu tiên lấy độ dài
            // clip LIPS của câu (≈ audio thật) làm slot để mốc thời gian giữ đúng; không có lips thì mới 2s.
            let slot;
            if (a) slot = a.durUs;
            else {
                audioFail++;
                const lp = (unit.au && lipsByIdx[lipsIdx]) ? lipsByIdx[lipsIdx] : null;
                const ld = lp ? getMediaDuration(lp) : 0;
                slot = ld > 0 ? ld : 2_000_000;
                console.warn(`[CapCut] ⚠ tải audio hụt (câu ${lipsIdx}) → slot theo lips ${(slot/1e6).toFixed(2)}s (tránh lệch dần)`);
            }
            if (a) pushAudioSegment(a.matId, totalDuration, a.durUs, audioSegments, false);
            if (bothLangs && unit.al) { const a2 = fetchUnitAudio(unit.al, `${nb}_voice2`); if (a2) pushAudioSegment(a2.matId, totalDuration, a2.durUs, audioSegments2, false); }
            if (unit.au && lipsByIdx[lipsIdx]) { placeLips(lipsByIdx[lipsIdx], totalDuration, slot, `${nb}_lips`); placedLips++; }
            totalDuration += slot + silenceUs;               // silenceUs=0: câu nối tiếp sát nhau (khớp narration UI)
            unitEnds.push(totalDuration);                    // mốc kết thúc câu này (audio/lips kết thúc tại đây)
        }
        const sceneAudioEnd = totalDuration - silenceUs;     // hết audio câu cuối (silenceUs=0 → = totalDuration)
        const brollStart = (prevBrollEnd != null) ? prevBrollEnd : sceneStart;   // phủ cả khoảng nghỉ trước cảnh
        layBroll(scene.assets, brollStart, Math.max(0, sceneAudioEnd - brollStart), unitEnds);
        prevBrollEnd = sceneAudioEnd;
    }
    // Lấp nốt khoảng nghỉ sau câu cuối cùng (trước outro/kết) bằng clip cuối, tránh nền đen.
    if (lastBrollSeg != null && prevBrollEnd != null && totalDuration > prevBrollEnd)
        lastBrollSeg.target_timerange.duration += Math.round(totalDuration - prevBrollEnd);

    // ===== HẬU XỬ LÝ b-roll: đảm bảo clip phát ĐÚNG nội dung thật rồi ĐỨNG HÌNH lấp phần dư của slot =====
    // Nội dung thật = min(trim đã đặt, độ dài FILE). Nếu slot dài hơn nội dung thật → freeze-pad (chạy 1x + đứng hình):
    //   • video trim NGẮN hơn slot        → không kéo giãn/tua chậm nữa
    //   • FILE ngắn hơn trim (DB.duration) → không còn đen/thiếu hình ở đuôi
    // Đồng thời cắt ĐÚNG độ dài trim (không phát trọn file → hết "video thừa giây"). Chạy SAU mọi mở rộng target.
    let brollFrozen = 0;
    for (const bc of brollVideoClips) {
        const src = bc.segment.source_timerange, tgt = bc.segment.target_timerange;
        const fileUs = getVideoStreamDuration(bc.destPath) || src.duration;
        const contentUs = Math.min(src.duration, fileUs);   // nội dung thật sẽ phát (tôn trọng trim + giới hạn file)
        if (tgt.duration > contentUs + 2000) {              // slot dài hơn nội dung thật → cần đứng hình lấp
            if (freezePadClip(bc.destPath, contentUs, tgt.duration)) {
                bc.material.duration = getMediaDuration(bc.destPath);   // ≥ target (đã cắt tới content + pad khung cuối)
                src.duration = tgt.duration;                            // source==target → speed thật 1.0
                brollFrozen++;
            }
        }
    }
    if (brollFrozen) console.log(`[CapCut] b-roll freeze-pad ${brollFrozen} clip (video ngắn hơn slot → chạy 1x + đứng hình)`);

    await db.close();

    // OUTRO: chèn ở cuối (sau toàn bộ câu).
    if (post.outro_path) totalDuration += addBoundaryVideo(path.join(MEDIA_DIR, post.outro_path), totalDuration, 'outro');
    console.log(`[CapCut] Timeline theo câu: ${lipsIdx} câu, lips đặt ${placedLips} clip, silence ${(silenceUs/1e6).toFixed(2)}s/câu, tổng ${(totalDuration/1e6).toFixed(1)}s${audioFail ? `, ⚠ ${audioFail} câu TẢI AUDIO HỤT (đã bù slot theo lips)` : ''}`);

    content.duration = totalDuration;

    // Tracks
    if (videoSegments.length) {
        content.tracks.push({
            id: uuid(), type: 'video', segments: videoSegments,
            flag: 0, attribute: 0, name: '', is_default_name: true
        });
    }
    // Track lips sync — đẩy SAU track video chính → nằm TRÊN (overlay). B-roll giữ track dưới.
    if (lipsSegments.length) {
        content.tracks.push({
            id: uuid(), type: 'video', segments: lipsSegments,
            flag: 0, attribute: 0, name: 'Lips Sync', is_default_name: false
        });
    }
    if (audioSegments.length) {
        content.tracks.push({
            id: uuid(), type: 'audio', segments: audioSegments,
            flag: 0, attribute: 0, name: '', is_default_name: true
        });
    }
    // Track audio thứ 2 (tiếng Việt) khi xuất cả 2 ngôn ngữ
    if (audioSegments2.length) {
        content.tracks.push({
            id: uuid(), type: 'audio', segments: audioSegments2,
            flag: 0, attribute: 0, name: '', is_default_name: true
        });
    }

    // Update platform version từ template thật
    // (giữ nguyên platform từ template — app_version 8.7.0, version 171.0.0)

    // Cac file phu can thiet (copy tu template)
    const templateBase = path.join(TEMPLATE_DIR, 'capcut_template_0616');
    const extraFiles = [
        'draft_agency_config.json', 'draft_biz_config.json', 'draft_virtual_store.json',
        'attachment_pc_common.json', 'draft_settings', 'key_value.json',
        'performance_opt_info.json', 'timeline_layout.json'
    ];
    for (const f of extraFiles) {
        const src = path.join(templateBase, f);
        const dest = path.join(draftDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, dest);
        else fs.writeFileSync(dest, '{}');
    }
    // Copy thu muc common_attachment
    const caDir = path.join(templateBase, 'common_attachment');
    if (fs.existsSync(caDir)) {
        fs.mkdirSync(path.join(draftDir, 'common_attachment'), { recursive: true });
        for (const f of fs.readdirSync(caDir)) fs.copyFileSync(path.join(caDir, f), path.join(draftDir, 'common_attachment', f));
    }

    // Tao cau truc Timelines voi ID moi
    const timelineId = uuid();
    const timelinesDir = path.join(draftDir, 'Timelines');
    const timelineSubDir = path.join(timelinesDir, timelineId);
    fs.mkdirSync(timelineSubDir, { recursive: true });

    // Ghi content chinh (tracks, materials) vao Timelines/{timelineId}/draft_content.json
    content.id = timelineId;  // ID cua timeline = UUID cua subfolder
    const tlDcPath = path.join(timelineSubDir, 'draft_content.json');
    fs.writeFileSync(tlDcPath, JSON.stringify(content));
    fs.writeFileSync(path.join(timelineSubDir, 'draft_content.json.bak'), JSON.stringify(content));
    fs.writeFileSync(path.join(timelineSubDir, 'template-2.tmp'), JSON.stringify(content));

    // Copy cac file phu khac tu template Timelines subfolder (attachment, draft.extra, template.tmp...)
    const tmplSubDir = fs.readdirSync(path.join(templateBase, 'Timelines')).find(f => f !== 'project.json' && f !== 'project.json.bak');
    if (tmplSubDir) {
        const tmplSubPath = path.join(templateBase, 'Timelines', tmplSubDir);
        const skipFiles = new Set(['draft_content.json', 'draft_content.json.bak', 'template-2.tmp']);
        const copyRecursive = (src, dest) => {
            fs.mkdirSync(dest, { recursive: true });
            for (const f of fs.readdirSync(src)) {
                if (skipFiles.has(f)) continue; // da ghi o tren
                const s = path.join(src, f), d = path.join(dest, f);
                fs.statSync(s).isDirectory() ? copyRecursive(s, d) : fs.copyFileSync(s, d);
            }
        };
        copyRecursive(tmplSubPath, timelineSubDir);
    }

    // Root draft_content.json = template goc (nhu 0616, 25681 bytes)
    fs.copyFileSync(path.join(templateBase, 'draft_content.json'), path.join(draftDir, 'draft_content.json'));
    fs.copyFileSync(path.join(templateBase, 'draft_content.json'), path.join(draftDir, 'draft_content.json.bak'));
    fs.copyFileSync(path.join(templateBase, 'draft_content.json'), path.join(draftDir, 'template-2.tmp'));

    // draft_meta_info.json
    const nowMicro = nowUs();
    meta.draft_id = draftId;
    meta.draft_name = post.project_id;
    meta.draft_fold_path = `${WIN_DRAFT_ROOT}/${draftId}`;
    meta.draft_root_path = WIN_DRAFT_ROOT;
    meta.tm_draft_create = nowMicro;
    meta.tm_draft_modified = nowMicro;
    meta.tm_draft_removed = 0;
    meta.tm_duration = totalDuration;
    meta.draft_is_invisible = false;
    meta.draft_materials = [{ type: 0, value: [] }, { type: 1, value: [] }, { type: 2, value: [] }, { type: 3, value: [] }, { type: 6, value: [] }, { type: 7, value: [] }, { type: 8, value: [] }];

    // Gắn thumbnail đã chọn làm ảnh bìa CapCut
    if (coverAsset) {
        const coverSrc = path.join(MEDIA_DIR, coverAsset.file_path);
        if (fs.existsSync(coverSrc)) {
            try {
                fs.copyFileSync(coverSrc, path.join(draftDir, 'draft_cover.jpg'));
                meta.draft_cover = 'draft_cover.jpg';
                console.log('[CapCut] Đã gắn thumbnail bìa:', coverAsset.file_path);
            } catch (e) { console.warn('[CapCut] Copy cover lỗi:', e.message); }
        } else {
            console.warn('[CapCut] File thumbnail bìa không tồn tại:', coverSrc);
        }
    }
    fs.writeFileSync(path.join(draftDir, 'draft_meta_info.json'), JSON.stringify(meta));

    // Tao project.json trong Timelines voi IDs moi
    const projectJsonId = uuid();
    const projectJson = {
        config: { color_space: -1, render_index_track_mode_on: false, use_float_render: false },
        create_time: nowUs(),
        id: projectJsonId,
        main_timeline_id: timelineId,
        timelines: [{ create_time: nowUs(), id: timelineId, is_marked_delete: false, name: 'Timeline 01', update_time: nowUs() }],
        update_time: nowUs(),
        version: 0
    };
    fs.writeFileSync(path.join(timelinesDir, 'project.json'), JSON.stringify(projectJson));
    fs.writeFileSync(path.join(timelinesDir, 'project.json.bak'), JSON.stringify(projectJson));

    // Cac folder rong
    for (const d of ['adjust_mask', 'matting', 'qr_upload', 'smart_crop', 'subdraft', 'Resources']) {
        fs.mkdirSync(path.join(draftDir, d), { recursive: true });
    }

    console.log(`[CapCut] Draft: ${draftDir} | Videos: ${videoSegments.length} | Audios: ${audioSegments.length}${audioSegments2.length ? `+${audioSegments2.length}(vi)` : ''} | Duration: ${(totalDuration/1e6).toFixed(1)}s`);

    // Zip
    const zipPath = path.join(outputDir, `${post.project_id}_${Date.now()}_capcut.zip`);
    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', reject);
        output.on('close', resolve);
        archive.pipe(output);
        archive.directory(draftDir, draftId);
        archive.finalize();
    });

    fs.rmSync(draftDir, { recursive: true, force: true });
    console.log(`[CapCut] Zip: ${zipPath} (${(fs.statSync(zipPath).size/1024/1024).toFixed(1)}MB)`);

    // Tạo .bat cùng thư mục với zip
    const zipFileName = path.basename(zipPath);
    const batPath = zipPath.replace(/\.zip$/, '.bat');
    fs.writeFileSync(batPath, generateBat(zipFileName, post.project_id));
    console.log(`[CapCut] Bat: ${batPath}`);

    process.stdout.write(JSON.stringify({ zipPath, batPath, draftId, projectName: post.project_id }) + '\n');
    return { zipPath, batPath, draftDir, draftId, projectName: post.project_id };
}

const INSTALL_SCRIPT = 'C:\\Users\\trinh\\workspace\\install_capcut.py';

export function generateBat(zipFileName, projectName) {
    return [
        '@echo off',
        `echo Installing: ${projectName}`,
        `set ZIP=%~dp0${zipFileName}`,
        `python "${INSTALL_SCRIPT}" "%ZIP%"`,
        'if %ERRORLEVEL% NEQ 0 ( echo FAILED & pause & exit /b 1 )',
        'echo Done!',
    ].join('\r\n');
}

if (process.argv[1]?.endsWith('capcut_export.js')) {
    const [,, postId, outputDir, contentType] = process.argv;
    if (!postId) { console.error('Usage: node capcut_export.js <postId> [outputDir] [contentType]'); process.exit(1); }
    const outDir = outputDir || path.join(MEDIA_DIR, '_capcut_exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    exportCapcut(parseInt(postId), outDir, contentType || null)
        .then(r => console.log(`[CapCut] Done: ${r.zipPath}`))
        .catch(e => { console.error('[CapCut] Error:', e.message); process.exit(1); });
}
