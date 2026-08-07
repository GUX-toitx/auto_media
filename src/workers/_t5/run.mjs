import { translateSrtTexts, buildSrtFile, parseSrt, tcToSec } from './t.mjs';
import fs from 'fs';
const SRT = `1
00:00:01,000 --> 00:00:04,500
PSG khởi đầu mùa giải bằng trận Siêu cúp.

2
00:00:04,800 --> 00:00:09,200
Luis Enrique giữ nguyên sơ đồ 4-3-3
đã thành công mùa trước.

3
00:00:09,500 --> 00:00:12,000
Đây là phép thử đầu tiên.
`;
fs.writeFileSync('/tmp/t5.srt', SRT);
const cues = parseSrt('/tmp/t5.srt');
console.log('đọc được', cues.length, 'cue | timecode giữ nguyên:', cues.map(c=>c.timecode).join(' | '));

for (const mode of ['ok','lech','hong']) {
  globalThis.__mode = mode; globalThis.__calls = [];
  const out = await translateSrtTexts(cues.map(c=>c.text), 'ja', 'p');
  const srt = buildSrtFile(cues, out);
  const back = parseSrt.constructor === Function ? null : null;
  fs.writeFileSync('/tmp/t5_out.srt', srt);
  const re = parseSrt('/tmp/t5_out.srt');
  console.log(`\n--- mode=${mode} (${globalThis.__calls.length} lượt gọi) ---`);
  console.log('  số dòng ra:', out.length, '| khớp gốc:', out.length===cues.length?'✅':'❌');
  console.log('  file .srt đọc lại được:', re.length, 'cue | timecode khớp:', re.every((c,i)=>c.timecode===cues[i].timecode)?'✅':'❌');
  console.log('  nội dung:', out.map(t=>t.slice(0,28)).join(' // '));
}
