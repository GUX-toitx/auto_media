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

// Load template
const TEMPLATE_DIR = path.dirname(new URL(import.meta.url).pathname);
const templateContent = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'template_draft_content.json'), 'utf8'));
const templateMeta = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'template_draft_meta_info.json'), 'utf8'));

function getMediaDuration(filePath) {
    try {
        const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, { encoding: 'utf8' });
        return Math.round(parseFloat(out.trim()) * 1_000_000) || 5_000_000;
    } catch { return 5_000_000; }
}

function getMediaInfo(filePath) {
    try {
        const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`, { encoding: 'utf8' });
        const [w, h] = out.trim().split(',').map(Number);
        return { width: w || 1920, height: h || 1080 };
    } catch { return { width: 1920, height: 1080 }; }
}

const WIN_DRAFT_ROOT = 'C:/Users/trinh/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft';

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

    // Video: đứng yên (chỉ cover, không Ken Burns). Ảnh tĩnh: áp Ken Burns (zoom/pan nhẹ).
    const p = KB_PRESETS[presetIndex % KB_PRESETS.length];
    const s0 = isVideo ? fillScale : fillScale * p.s0;
    const s1 = isVideo ? fillScale : fillScale * p.s1;
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
    // contentType override: 'content_vi' | 'content' | null (auto dari voice_content_type)
    const resolvedType = contentType || post.voice_content_type || 'content_vi';
    const isVi = resolvedType === 'content_vi';

    console.log(`[CapCut] Export post ${postId} (${post.project_id}) contentType=${resolvedType}`);

    const paragraphs = await db.all(`SELECT * FROM Paragraph WHERE post_id = ? ORDER BY "order"`, [postId]);

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
    const allExtraMaterials = { speeds: [], canvases: [], vocal_separations: [], placeholder_infos: [], beats: [], material_colors: [], sound_channel_mappings: [] };

    for (const para of paragraphs) {
        // Lấy audio — gom tất cả ParagraphDetail audio thành 1 file ghép
        const audioField = isVi ? 'content_vi_audio' : 'content_audio';
        const altField   = isVi ? 'content_audio' : 'content_vi_audio';
        // Ưu tiên field theo contentType, fallback sang field còn lại nếu rỗng
        const paraAudioUrl = para[audioField] || para[altField] || para['audio'];
        // Lấy từ ParagraphDetail nếu para không có audio trực tiếp
        const paraDetails = await db.all(
            `SELECT ${audioField}, ${altField} FROM ParagraphDetail WHERE paragraph_id = ? ORDER BY "order"`,
            [para.id]
        );
        const detailAudioUrls = paraDetails.map(d => d[audioField] || d[altField]).filter(Boolean);
        const audioUrls = paraAudioUrl ? [paraAudioUrl] : detailAudioUrls;

        let audioDuration = 5_000_000;
        let audioMatId = null;

        if (audioUrls.length > 0) {
            try {
                const bunnyBase = process.env.BUNNYCDN_BASE_URL || '';
                const bunnyKey = process.env.BUNNYCDN_ACCESS_KEY || '';
                // Download từng file rồi concat
                const tmpFiles = [];
                for (let ai = 0; ai < audioUrls.length; ai++) {
                    const url = audioUrls[ai].startsWith('http') ? audioUrls[ai] : `${bunnyBase}/${audioUrls[ai]}`;
                    const tmpPath = path.join(assetsDir, `_tmp_audio_${fileIndex}_${ai}.mp3`);
                    execSync(`curl -sL -H "AccessKey: ${bunnyKey}" "${url}" -o "${tmpPath}"`, { timeout: 15000 });
                    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) tmpFiles.push(tmpPath);
                }
                if (tmpFiles.length > 0) {
                    const audioFileName = `audio_${fileIndex++}.mp3`;
                    const audioLocalPath = path.join(assetsDir, audioFileName);
                    if (tmpFiles.length === 1) {
                        fs.renameSync(tmpFiles[0], audioLocalPath);
                    } else {
                        // Concat bằng ffmpeg
                        const listFile = path.join(assetsDir, `_list_${fileIndex}.txt`);
                        fs.writeFileSync(listFile, tmpFiles.map(f => `file '${f}'`).join('\n'));
                        execSync(`ffmpeg -f concat -safe 0 -i "${listFile}" -c copy -y "${audioLocalPath}"`, { timeout: 30000 });
                        tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch(_) {} });
                        fs.unlinkSync(listFile);
                    }
                    if (fs.existsSync(audioLocalPath) && fs.statSync(audioLocalPath).size > 1000) {
                        audioDuration = getMediaDuration(audioLocalPath);
                        audioMatId = uuid();
                        const winAudioPath = `${WIN_DRAFT_ROOT}/${draftId}/assets/${audioFileName}`;
                        const audioMat = buildAudioMaterial(audioMatId, winAudioPath, audioDuration, audioFileName);
                        content.materials.audios.push(audioMat);
                    }
                }
            } catch (e) { console.error(`[CapCut] Audio error para ${para.order}: ${e.message}`); }
        }

        // Lấy assets selected
        const assets = await db.all(
            `SELECT * FROM Asset WHERE paragraph_id = ? AND selected = 1 ORDER BY "order"`,
            [para.id]
        );
        let allAssets = assets;
        if (!allAssets.length) {
            // Chưa chọn gì -> tự chọn video phù hợp: gom video đủ phủ độ dài audio đoạn này
            const vids = await db.all(
                `SELECT * FROM Asset WHERE paragraph_id = ? AND type = 'video' ORDER BY id`,
                [para.id]
            );
            const picked = [];
            let acc = 0;
            for (const v of vids) {
                picked.push(v);
                acc += v.duration ? v.duration * 1_000_000 : 5_000_000;
                if (acc >= audioDuration) break; // đủ phủ audio thì dừng
            }
            allAssets = picked.length ? picked : await db.all(
                // Đoạn không có video -> dùng ảnh
                `SELECT * FROM Asset WHERE paragraph_id = ? ORDER BY id LIMIT 3`,
                [para.id]
            );
            if (allAssets.length) console.log(`[CapCut] Para ${para.order}: tự chọn ${allAssets.length} ${picked.length ? 'video' : 'ảnh'} (chưa có lựa chọn)`);
        }

        const segStart = totalDuration;

        if (allAssets.length === 0) {
            totalDuration += audioDuration;
        } else {
            // Chia đều audioDuration thành N slice; slice cuối gánh phần dư để Σ slice = audioDuration.
            // totalDuration tiến theo slice (không theo độ dài video đã cắt) → audio luôn liền mạch, không dồn.
            const N = allAssets.length;
            let sliceAcc = 0;
            for (let ai = 0; ai < N; ai++) {
                const asset = allAssets[ai];
                const slotDur = (ai === N - 1) ? (audioDuration - sliceAcc) : Math.round(audioDuration / N);
                sliceAcc += slotDur;
                const srcPath = path.join(MEDIA_DIR, asset.file_path);
                if (!fs.existsSync(srcPath)) { totalDuration += slotDur; continue; }
                const ext = path.extname(asset.file_path).toLowerCase();
                const assetFileName = `asset_${fileIndex++}${ext}`;
                const destPath = path.join(assetsDir, assetFileName);
                fs.copyFileSync(srcPath, destPath);
                const isVideo = ['.mp4', '.mov', '.avi'].includes(ext);
                const mediaInfo = isVideo ? getMediaInfo(destPath) : { width: 1920, height: 1080 };
                const realDur = isVideo ? (asset.duration ? Math.round(asset.duration * 1_000_000) : slotDur) : slotDur;
                // Slot timeline luôn = slotDur (phủ đủ audio); nguồn video chỉ lấy tối đa = slotDur (dài hơn → cắt; ngắn hơn → đứng hình phần dư)
                const srcDur = isVideo ? Math.min(realDur, slotDur) : slotDur;
                const matId = uuid();
                const mat = buildVideoMaterial(matId, destPath, isVideo ? realDur : slotDur, assetFileName, isVideo, draftId);
                content.materials.videos.push(mat);
                const { segment, extraMaterials } = buildVideoSegment(matId, totalDuration, slotDur, srcDur, videoIndex++, mediaInfo.width, mediaInfo.height, isVideo);
                videoSegments.push(segment);
                // Extra materials
                const speedMat = { ...JSON.parse(JSON.stringify(templateContent.materials.speeds[0])), id: extraMaterials.speedId };
                const canvasMat = { ...JSON.parse(JSON.stringify(templateContent.materials.canvases[0])), id: extraMaterials.canvasId };
                const colorMat = { ...JSON.parse(JSON.stringify(templateContent.materials.material_colors[0])), id: extraMaterials.colorId };
                const vocalMat = { ...JSON.parse(JSON.stringify(templateContent.materials.vocal_separations[0])), id: extraMaterials.vocalId };
                const phMat = { ...JSON.parse(JSON.stringify(templateContent.materials.placeholder_infos[0])), id: extraMaterials.placeholderId };
                content.materials.speeds.push(speedMat);
                content.materials.canvases.push(canvasMat);
                content.materials.material_colors.push(colorMat);
                content.materials.vocal_separations.push(vocalMat);
                content.materials.placeholder_infos.push(phMat);
                const scVideoMat = { ...JSON.parse(JSON.stringify(templateContent.materials.sound_channel_mappings[0])), id: extraMaterials.soundChannelId };
                content.materials.sound_channel_mappings.push(scVideoMat);
                totalDuration += slotDur;
            }
        }

        // Audio segment
        if (audioMatId) {
            const { segment, extraMaterials } = buildAudioSegment(audioMatId, segStart, audioDuration, []);
            audioSegments.push(segment);
            const speedMat = { ...JSON.parse(JSON.stringify(templateContent.materials.speeds[0])), id: extraMaterials.speedId };
            const phMat = { ...JSON.parse(JSON.stringify(templateContent.materials.placeholder_infos[0])), id: extraMaterials.placeholderId };
            const beatsMat = { ...JSON.parse(JSON.stringify(templateContent.materials.beats[0])), id: extraMaterials.beatsId };
            const vocalMat = { ...JSON.parse(JSON.stringify(templateContent.materials.vocal_separations[0])), id: extraMaterials.vocalId };
            const scMat = { ...JSON.parse(JSON.stringify(templateContent.materials.sound_channel_mappings[0])), id: extraMaterials.soundChannelId };
            content.materials.speeds.push(speedMat);
            content.materials.placeholder_infos.push(phMat);
            content.materials.beats.push(beatsMat);
            content.materials.vocal_separations.push(vocalMat);
            content.materials.sound_channel_mappings.push(scMat);
        }
    }

    await db.close();

    content.duration = totalDuration;

    // Tracks
    if (videoSegments.length) {
        content.tracks.push({
            id: uuid(), type: 'video', segments: videoSegments,
            flag: 0, attribute: 0, name: '', is_default_name: true
        });
    }
    if (audioSegments.length) {
        content.tracks.push({
            id: uuid(), type: 'audio', segments: audioSegments,
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

    console.log(`[CapCut] Draft: ${draftDir} | Videos: ${videoSegments.length} | Audios: ${audioSegments.length} | Duration: ${(totalDuration/1e6).toFixed(1)}s`);

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
