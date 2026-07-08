#!/usr/bin/env python3
"""
Forced alignment: nhận (audio + text ĐÃ BIẾT) -> mốc thời gian từng từ.
Dùng WhisperX (bỏ qua bước transcribe của Whisper, chỉ chạy align vì đã có text).

I/O qua stdin/stdout (JSON):
  IN : {"device": "cuda"|"cpu"|null, "items": [
          {"id": "...", "audio_path": "/tmp/x.mp3", "text": "...", "lang": "vi"|null}, ...]}
  OUT: {"ok": true, "device": "...", "results": [
          {"id": "...", "ok": true, "lang": "ja", "duration": 5.1,
           "words": [["từ", start, end], ...]}, ...]}

lang=null -> tự nhận diện theo ký tự (ja/zh/ko/th/vi/en).
"""
import sys
import json
import re

SAMPLE_RATE = 16000

# Ký tự riêng của tiếng Việt để phân biệt vi vs en (Latin)
_VI_RE = re.compile(r'[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]', re.I)


def detect_lang(text: str) -> str:
    if re.search(r'[぀-ヿ]', text):      # Hiragana/Katakana
        return 'ja'
    if re.search(r'[가-힯]', text):      # Hangul
        return 'ko'
    if re.search(r'[฀-๿]', text):      # Thai
        return 'th'
    if re.search(r'[一-鿿]', text):      # CJK (sau khi loại ja/ko) -> zh
        return 'zh'
    if _VI_RE.search(text):
        return 'vi'
    return 'en'


# Ngắt khúc CJK (không có khoảng trắng): tách sau dấu câu.
_CJK_SPLIT_RE = re.compile(r'(?<=[。！？、，；：])')
# Độ dài tối đa mỗi khúc (ký tự) với ngôn ngữ có khoảng trắng.
_CHUNK_MAXLEN = 20


def speech_spans(audio, duration, frame_ms=20, rel_db=-30, merge_gap=0.2, pad=0.05):
    """VAD năng lượng đơn giản: trả về các vùng CÓ TIẾNG [[start,end], ...] (giây),
    bỏ qua khoảng lặng đầu/giữa. Dùng để đặt cửa sổ khúc theo thời gian nói THẬT."""
    import numpy as np
    fl = int(SAMPLE_RATE * frame_ms / 1000)
    n = len(audio) // fl if fl else 0
    if n < 2:
        return [[0.0, duration]]
    f = audio[:n * fl].reshape(n, fl).astype(np.float64)
    rms = np.sqrt((f ** 2).mean(axis=1) + 1e-10)
    ref = np.percentile(rms, 95) + 1e-10          # ngưỡng tương đối theo đoạn to nhất
    db = 20 * np.log10(rms / ref + 1e-10)
    voiced = db > rel_db
    spans = []
    i = 0
    while i < n:
        if voiced[i]:
            j = i
            while j < n and voiced[j]:
                j += 1
            spans.append([i * fl / SAMPLE_RATE, j * fl / SAMPLE_RATE])
            i = j
        else:
            i += 1
    if not spans:
        return [[0.0, duration]]
    merged = [spans[0]]
    for s in spans[1:]:
        if s[0] - merged[-1][1] < merge_gap:        # gộp khoảng lặng ngắn
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    for m in merged:                                 # nới nhẹ 2 đầu
        m[0] = max(0.0, m[0] - pad)
        m[1] = min(duration, m[1] + pad)
    return merged


def _mapper(spans):
    """frac∈[0,1] (theo tổng thời gian NÓI) -> thời điểm audio thật (bỏ qua khoảng lặng)."""
    total = sum(e - s for s, e in spans) or 1e-9

    def to_time(frac):
        target = frac * total
        acc = 0.0
        for s, e in spans:
            d = e - s
            if acc + d >= target:
                return s + (target - acc)
            acc += d
        return spans[-1][1]
    return to_time


def _chunks(text):
    """Ngôn ngữ có khoảng trắng: gộp từ tới ~20 ký tự. CJK: tách theo dấu câu."""
    if re.search(r'\s', text):
        out = []
        cur = ''
        for w in text.split():
            if cur and len(cur) + 1 + len(w) > _CHUNK_MAXLEN:
                out.append(cur)
                cur = w
            else:
                cur = (cur + ' ' + w) if cur else w
        if cur:
            out.append(cur)
        return out
    return [p for p in _CJK_SPLIT_RE.split(text) if p.strip()]


def build_segments(text, audio, duration):
    """Tách text thành khúc ngắn + cấp cửa sổ thời gian rồi align từng khúc
    (khúc ngắn tránh 'sập sync' khi forced-align cả clip dài, đặc biệt tiếng Việt).

    Cửa sổ đặt theo ngôn ngữ:
    - Có khoảng trắng (Việt/Anh): khúc ~20 ký tự (nhỏ) -> cửa sổ theo VÙNG CÓ TIẾNG (VAD),
      bỏ qua khoảng lặng đầu/ngắt nghỉ. Nếu không sẽ bị 'chạy trước' vì cửa sổ tỉ lệ ký tự
      giả định giọng lấp đầy đều [0,dur].
    - CJK (Nhật/Trung): tách theo dấu câu (cửa sổ lớn) -> tỉ lệ ký tự [0,dur]. KHÔNG dùng VAD
      (audio hay có nhạc nền làm VAD năng lượng nhiễu; cửa sổ lớn đủ để WhisperX tự căn đúng).
    """
    chunks = [c for c in _chunks(text) if c.strip()]
    if len(chunks) <= 1:
        return [{"start": 0.0, "end": duration, "text": text}]
    spaced = bool(re.search(r'\s', text))
    to_time = _mapper(speech_spans(audio, duration)) if spaced else (lambda frac: duration * frac)
    total = sum(len(c) for c in chunks) or 1
    cum = 0
    segs = []
    for c in chunks:
        fs = cum / total
        cum += len(c)
        fe = cum / total
        segs.append({"start": round(to_time(fs), 3), "end": round(to_time(fe), 3), "text": c})
    return segs


def fill_gaps(words, duration):
    """Điền start/end cho từ WhisperX không align được (None) bằng nội suy, đảm bảo tăng dần."""
    n = len(words)
    # forward-fill start
    for i in range(n):
        if words[i][1] is None:
            prev_end = words[i - 1][2] if i > 0 else None
            words[i][1] = prev_end if prev_end is not None else (words[i - 1][1] if i > 0 and words[i - 1][1] is not None else 0.0)
    # backward-fill end
    for i in range(n - 1, -1, -1):
        if words[i][2] is None:
            nxt = words[i + 1][1] if i < n - 1 else None
            words[i][2] = nxt if nxt is not None else (words[i][1] if words[i][1] is not None else duration)
    # kẹp về [prev, duration], không giảm
    prev = 0.0
    for w in words:
        s = w[1] if w[1] is not None else prev
        if s < prev:
            s = prev
        e = w[2] if w[2] is not None else s
        if e < s:
            e = s
        if duration and e > duration:
            e = duration
        w[1], w[2] = round(s, 3), round(e, 3)
        prev = s
    return words


def main():
    payload = json.load(sys.stdin)
    items = payload.get('items', [])

    try:
        import torch
        import whisperx
    except Exception as ex:  # noqa: BLE001
        json.dump({"ok": False, "error": f"import failed: {ex}"}, sys.stdout, ensure_ascii=False)
        return

    want = payload.get('device')
    device = want or ('cuda' if torch.cuda.is_available() else 'cpu')

    model_cache = {}

    def get_model(lang):
        if lang not in model_cache:
            model_cache[lang] = whisperx.load_align_model(language_code=lang, device=device)
        return model_cache[lang]

    results = []
    for it in items:
        rid = it.get('id')
        text = (it.get('text') or '').strip()
        audio_path = it.get('audio_path')
        lang = it.get('lang') or (detect_lang(text) if text else 'en')
        try:
            if not text or not audio_path:
                raise ValueError('thiếu text hoặc audio_path')
            model_a, metadata = get_model(lang)
            audio = whisperx.load_audio(audio_path)
            duration = len(audio) / float(SAMPLE_RATE)
            segments = build_segments(text, audio, duration)
            aligned = whisperx.align(segments, model_a, metadata, audio, device, return_char_alignments=False)
            words = [[w.get('word', ''), w.get('start'), w.get('end')] for w in aligned.get('word_segments', [])]
            words = fill_gaps(words, duration)
            results.append({"id": rid, "ok": True, "lang": lang, "duration": round(duration, 3), "words": words})
        except Exception as ex:  # noqa: BLE001
            results.append({"id": rid, "ok": False, "lang": lang, "error": str(ex)})

    json.dump({"ok": True, "device": device, "results": results}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
