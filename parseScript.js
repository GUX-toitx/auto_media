// parseScript.js — Tách kịch bản podcast tag-sẵn thành segment xác định (không cần GPT).
// Mô hình: 1 GIỌNG cho cả project, đổi "giọng điệu" theo từng segment qua preset (nhân vật + cảm xúc).
//
// Input mỗi block phân tách bởi dòng trống. Tag dạng:
//   [Voice (Nhân vật X, giới tính Nam|Nữ)]
//   [Voice (Nhân vật X - Suy nghĩ nội tâm, giới tính Nam)]
// Block nằm trọn trong ngoặc đơn / có "Âm thanh nền"|"Nhạc"... -> cue SFX.

const TAG = /^\[Voice\s*\(\s*Nhân vật\s+(.+?)\s*,\s*giới tính\s+(Nam|Nữ)\s*\)\]\s*$/i;
const SFX_WRAP = /^\(.*\)\.?$/s;
const SFX_KW = /Âm thanh nền|Soundscape|Nhạc|Outro|Intro|Tiếng (sóng|còi|động cơ|bát|xèo)/i;

// ----- Bảng preset (= tham số batch của TTS, override lên default trong audio_service) -----
// pitch/speed/volume + các knob Chatterbox (exaggeration/cfg_weight). silence_duration: nhịp ngắt.
export const PRESETS = {
  narrate: { pitch: 1.00, speed: 1.00, volume: 1.0,  exaggeration: 0.40, cfg_weight: 0.50 },
  inner:   { pitch: 0.98, speed: 0.95, volume: 0.9,  exaggeration: 0.30, cfg_weight: 0.45, silence_duration: 1.2 },
  tease:   { pitch: 1.05, speed: 1.00, volume: 1.0,  exaggeration: 0.60, cfg_weight: 0.50 },
  gruff:   { pitch: 0.95, speed: 1.05, volume: 1.0,  exaggeration: 0.55, cfg_weight: 0.55 },
  urgent:  { pitch: 1.00, speed: 1.12, volume: 1.1,  exaggeration: 0.70, cfg_weight: 0.60 },
  tense:   { pitch: 1.00, speed: 1.05, volume: 1.0,  exaggeration: 0.65, cfg_weight: 0.55 },
  sad:     { pitch: 0.97, speed: 0.92, volume: 0.95, exaggeration: 0.45, cfg_weight: 0.45, silence_duration: 1.3 },
  happy:   { pitch: 1.03, speed: 1.03, volume: 1.05, exaggeration: 0.60, cfg_weight: 0.50 },
};

// Cảm xúc -> preset (khi không phải nội tâm và không có override mạnh từ nhân vật)
const EMO_PRESET = { angry: 'gruff', tense: 'tense', happy: 'happy', sad: 'sad', tease: 'tease', neutral: 'narrate' };

// ----- Nhận diện cảm xúc bằng luật (free, deterministic) -----
export function detectEmotion(text) {
  const t = text.toLowerCase();
  if (/rưng rưng|nghẹn|khóc|buồn|nước mắt|thẫn thờ|hụt hẫng/.test(t)) return 'sad';
  if (/quát|hét|gắt|cáu|giận|tức|đm|mày |cốc!|bụp/.test(t)) return 'angry';
  if (/tái mặt|hồi hộp|tim đập|run|sợ|ám ảnh|chới với|luống cuống|rón rén|lấm lét/.test(t)) return 'tense';
  if (/cười|vui|hehe|haha|mừng|hào hứng|tủm tỉm|tỏa nắng|sướng/.test(t)) return 'happy';
  if (/(^|["“'])\s*xì[\s.,!]|trêu|nhõng nhẽo|bánh bèo/.test(t)) return 'tease';
  // nhiều dấu "!" liên tiếp -> nhấn mạnh/gấp
  if ((text.match(/!/g) || []).length >= 2) return 'angry';
  return 'neutral';
}

// Chọn preset = f(nhân vật/nội tâm, cảm xúc). castOverrides: { '<tên nhân vật>': '<preset>' }
export function pickPreset(seg, castOverrides = {}) {
  if (seg.inner) return 'inner';
  const emo = detectEmotion(seg.text);
  if (emo !== 'neutral') return EMO_PRESET[emo];        // cảm xúc rõ -> ưu tiên
  if (castOverrides[seg.character]) return castOverrides[seg.character]; // màu nền nhân vật
  return 'narrate';
}

function splitName(raw) {
  const [name, ...rest] = raw.split(' - ');
  const role = rest.join(' - ').trim();
  return { character: name.trim(), role: role || null, inner: /nội tâm|suy nghĩ/i.test(role) };
}

/**
 * parseScript(raw, opts) -> segments[]
 *   speech: { order, type:'speech', character, gender, inner, role, emotion, preset, text }
 *   sfx:    { order, type:'sfx', cue }
 * opts.castOverrides: map tên nhân vật -> preset (vd { 'Huy':'gruff', 'Phụ xe':'urgent' })
 */
export function parseScript(raw, opts = {}) {
  const castOverrides = opts.castOverrides || {};
  const blocks = raw.replace(/\r/g, '').split(/\n\s*\n/);
  const out = [];
  let cur = null;

  const pushSpeech = (meta, text) => {
    const t = text.trim();
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.type === 'speech' && last.character === meta.character && last.inner === meta.inner) {
      last.text += ' ' + t; // gộp dòng liên tiếp cùng người + cùng vai
    } else {
      out.push({ type: 'speech', character: meta.character, gender: meta.gender, inner: meta.inner, role: meta.role, text: t });
    }
  };

  for (const block of blocks) {
    const lines = block.split('\n');
    const first = (lines[0] || '').trim();
    if (!first) continue;
    const m = first.match(TAG);

    if (m) {
      const info = splitName(m[1]);
      cur = { ...info, gender: m[2] };
      const body = lines.slice(1).join('\n').trim();
      if (body) (SFX_WRAP.test(body) ? out.push({ type: 'sfx', cue: body }) : pushSpeech(cur, body));
    } else if (SFX_WRAP.test(first) || SFX_KW.test(first)) {
      out.push({ type: 'sfx', cue: block.trim() });
    } else if (cur) {
      pushSpeech(cur, block);
    }
    // (block trước khi có tag đầu tiên mà không phải SFX -> bỏ qua)
  }

  // gắn order + emotion + preset
  return out.map((s, i) => {
    if (s.type === 'sfx') return { order: i + 1, ...s };
    const emotion = s.inner ? 'inner' : detectEmotion(s.text);
    return { order: i + 1, ...s, emotion, preset: pickPreset(s, castOverrides) };
  });
}

// Tổng hợp danh sách preset thực sự dùng -> để gom batch
export function presetsUsed(segments) {
  return [...new Set(segments.filter(s => s.type === 'speech').map(s => s.preset))];
}

// ----- CLI: node parseScript.js <file> [--json] -----
const isCli = process.argv[1] && process.argv[1].endsWith('parseScript.js');
if (isCli) {
  const fs = await import('fs');
  const file = process.argv[2];
  if (!file) { console.error('Usage: node parseScript.js <scriptFile> [--json]'); process.exit(1); }
  const segs = parseScript(fs.readFileSync(file, 'utf8'));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(segs, null, 2)); process.exit(0); }
  console.log(`Presets dùng: ${presetsUsed(segs).join(', ')}`);
  for (const s of segs) {
    if (s.type === 'sfx') console.log(`#${String(s.order).padStart(2)} 🔊 SFX   | ${s.cue.slice(0, 64)}...`);
    else console.log(`#${String(s.order).padStart(2)} 🎙️  ${(s.character + (s.inner ? '·nội tâm' : '')).padEnd(16)} [${s.preset}] ${s.text.slice(0, 48)}...`);
  }
  const sp = segs.filter(s => s.type === 'speech').length, fx = segs.length - sp;
  console.log(`\nTổng: ${sp} thoại + ${fx} SFX = ${segs.length} segment`);
}
