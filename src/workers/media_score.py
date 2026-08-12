#!/usr/bin/env python
# ============================================================================
# CHẤM ĐIỂM MEDIA CHO TỪNG CẢNH — chạy bằng .venv-whisperx/bin/python
#
# Nhận job JSON qua stdin, trả kết quả JSON qua stdout (đúng kiểu align_words.py).
#
#   vào : { "model": "...",
#            "assets": [ { "id": 9, "paths": ["/abs/a.jpg"] } ],
#            "scenes": [ { "key": "para:12",
#                          "texts": ["Ronald Araujo", "Liverpool transfer"],
#                          "assetIds": [9, 10, 11] } ] }
#   ra  : { "model": ..., "device": ..., "scenes": [ { "key": ..., "assets": [
#             { "id": 9, "w": 1920, "h": 1080, "dhash": "a1b2...", "score": 0.27, "dup": 0 } ] } ],
#           "failed": [ { "id": 12, "err": "cannot identify image file" } ] }
#
# Điểm = cosine(ảnh, text cảnh) trong không gian CLIP/SigLIP — 0 API, chạy tại chỗ trên GPU.
# Video: Node cắt sẵn vài frame và truyền nhiều "paths"; điểm/vector của clip = trung bình các frame.
#
# Mỗi asset chỉ MÃ HOÁ MỘT LẦN dù nằm trong nhiều cảnh: pool ảnh của 1 luận điểm được cả luận điểm
# lẫn các luận cứ con dùng chung, nếu gửi kèm theo từng cảnh thì cùng một tấm bị encode lại n lần.
#
# "dup" = số hiệu NHÓM TRÙNG trong cùng cảnh. Hai asset chung nhóm khi vân tay dHash gần nhau HOẶC
# vector ảnh gần như trùng — bắt được cả trường hợp cùng một tấm ảnh tải về ở kích thước/độ nén khác
# nhau (md5 khác nên phía crawl không nhận ra). Bên Node chỉ lấy 1 asset mỗi nhóm.
# ============================================================================
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from PIL import Image, ImageFile

# Ảnh cào từ web hay bị cụt đuôi; thà lấy phần đọc được còn hơn vứt cả tấm.
ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = None       # ảnh stock cỡ lớn không phải là "decompression bomb"

# SigLIP 2 hiểu ĐA NGỮ (câu tiếng Việt/Nhật/Hàn chấm được luôn), CLIP chỉ tiếng Anh — nhưng CLIP nhẹ
# hơn và luôn có sẵn, nên để làm phương án dự phòng khi tải model chính hỏng.
PRIMARY_MODEL = os.environ.get("MEDIA_SCORE_MODEL", "google/siglip2-base-patch16-224")
FALLBACK_MODEL = os.environ.get("MEDIA_SCORE_MODEL_FALLBACK", "openai/clip-vit-base-patch32")
BATCH = int(os.environ.get("MEDIA_SCORE_BATCH", "32"))
# GPU của máy này còn phải nuôi server lips-sync (LatentSync giữ ~7GB thường trực). Còn ít hơn ngần này
# thì đi CPU luôn cho lành — chậm hơn nhưng không giật VRAM của thứ đang chạy dở.
MIN_FREE_VRAM_MB = int(os.environ.get("MEDIA_SCORE_MIN_VRAM_MB", "1500"))
# Ngưỡng coi 2 ảnh là MỘT: dHash lệch ≤ 6 bit trên 64, hoặc vector ảnh cosine ≥ 0.94.
DHASH_MAX_DIST = int(os.environ.get("MEDIA_SCORE_DHASH_DIST", "6"))
DUP_COS = float(os.environ.get("MEDIA_SCORE_DUP_COS", "0.94"))

log = lambda m: print(m, file=sys.stderr, flush=True)


def load_model():
    from transformers import AutoModel, AutoProcessor
    last = None
    for name in [PRIMARY_MODEL, FALLBACK_MODEL]:
        if not name:
            continue
        try:
            model = AutoModel.from_pretrained(name)
            proc = AutoProcessor.from_pretrained(name, use_fast=True)
            return model, proc, name
        except Exception as e:                        # noqa: BLE001 - model nào cũng có thể hỏng khi tải
            last = e
            log(f"[media_score] tải model {name} lỗi: {e}")
    raise RuntimeError(f"không tải được model nào: {last}")


def dhash_hex(img):
    """Vân tay 64-bit: xám 9x8, so từng pixel với pixel bên phải."""
    g = img.convert("L").resize((9, 8), Image.LANCZOS)
    px = np.asarray(g, dtype=np.int16)
    bits = px[:, :-1] < px[:, 1:]
    val = 0
    for b in bits.reshape(-1):
        val = (val << 1) | int(b)
    return f"{val:016x}"


def read_image(path, want=448):
    """Mở ảnh -> (RGB đã thu nhỏ, w gốc, h gốc). draft() để giải nén JPEG cỡ lớn nhanh hơn nhiều lần."""
    im = Image.open(path)
    w, h = im.size                                    # kích thước THẬT, phải lấy trước khi draft đổi size
    try:
        im.draft("RGB", (want, want))
    except Exception:                                 # noqa: BLE001 - png/webp không có draft
        pass
    im = im.convert("RGB")
    if max(im.size) > want:
        im.thumbnail((want, want), Image.LANCZOS)
    return im, w, h


def pick_device():
    """Chọn GPU chỉ khi còn đủ VRAM trống, không thì CPU."""
    if not torch.cuda.is_available():
        return "cpu", torch.float32
    try:
        free_mb = torch.cuda.mem_get_info()[0] / 1024 / 1024
    except Exception:                                 # noqa: BLE001 - driver cũ không có mem_get_info
        return "cuda", torch.float16
    if free_mb < MIN_FREE_VRAM_MB:
        log(f"[media_score] GPU chỉ còn {free_mb:.0f}MB trống (< {MIN_FREE_VRAM_MB}MB) → chạy CPU")
        return "cpu", torch.float32
    return "cuda", torch.float16


class Encoder:
    """Mã hoá ảnh, tự hạ batch rồi tụt hẳn về CPU khi GPU hết chỗ (server lips-sync có thể chiếm bất cứ lúc nào)."""

    def __init__(self, model, proc, device, dtype):
        self.model, self.proc, self.device, self.dtype = model, proc, device, dtype

    def _to_cpu(self):
        log("[media_score] GPU hết chỗ → chuyển sang CPU, chậm hơn nhưng chạy xong")
        self.model = self.model.to(device="cpu", dtype=torch.float32)
        self.device, self.dtype = "cpu", torch.float32
        torch.cuda.empty_cache()

    def _run(self, chunk):
        inputs = self.proc(images=chunk, return_tensors="pt").to(self.device)
        if self.dtype == torch.float16:
            inputs = {k: (v.half() if v.is_floating_point() else v) for k, v in inputs.items()}
        with torch.no_grad():
            feats = self.model.get_image_features(**inputs)
        return torch.nn.functional.normalize(feats.float(), dim=-1).cpu()

    def images(self, imgs):
        out, i, batch = [], 0, BATCH
        while i < len(imgs):
            try:
                out.append(self._run(imgs[i:i + batch]))
                i += batch
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                if batch > 1:
                    batch = max(1, batch // 2)
                    log(f"[media_score] thiếu VRAM → hạ batch xuống {batch}")
                else:
                    self._to_cpu()
        return torch.cat(out) if out else torch.zeros((0, 1))


def encode_texts(enc, texts, is_siglip):
    # SigLIP bắt buộc padding='max_length' (64 token), CLIP thì padding động là đủ.
    kw = dict(padding="max_length", max_length=64) if is_siglip else dict(padding=True)
    inputs = enc.proc(text=texts, return_tensors="pt", truncation=True, **kw).to(enc.device)
    with torch.no_grad():
        feats = enc.model.get_text_features(**inputs)
    return torch.nn.functional.normalize(feats.float(), dim=-1).cpu()


def group_duplicates(hashes, vecs):
    """Gộp asset trùng nhau trong 1 cảnh -> trả list số hiệu nhóm (union-find đơn giản)."""
    n = len(hashes)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    sim = (vecs @ vecs.T).numpy() if n else np.zeros((0, 0))
    ints = [int(h, 16) if h else None for h in hashes]
    for i in range(n):
        for j in range(i + 1, n):
            same = sim[i][j] >= DUP_COS
            if not same and ints[i] is not None and ints[j] is not None:
                same = bin(ints[i] ^ ints[j]).count("1") <= DHASH_MAX_DIST
            if same:
                union(i, j)
    roots, groups = {}, []
    for i in range(n):
        r = find(i)
        groups.append(roots.setdefault(r, len(roots)))
    return groups


def main():
    job = json.load(sys.stdin)
    assets = job.get("assets") or []
    scenes = job.get("scenes") or []

    device, dtype = pick_device()
    model, proc, model_name = load_model()
    model = model.to(device=device, dtype=dtype).eval()
    enc = Encoder(model, proc, device, dtype)
    is_siglip = "siglip" in model_name.lower()
    log(f"[media_score] {model_name} trên {device} ({dtype}) — {len(assets)} asset / {len(scenes)} cảnh")

    # --- Đọc mọi frame của mọi asset rồi mã hoá 1 lượt: nạp model 1 lần, batch GPU đầy ---
    tasks = [(ai, fi, p)
             for ai, a in enumerate(assets)
             for fi, p in enumerate(a.get("paths") or [])]

    failed, loaded = [], []
    with ThreadPoolExecutor(max_workers=min(8, (os.cpu_count() or 4))) as pool:
        for (ai, fi, _path), (img, w, h, err) in zip(tasks, pool.map(lambda t: _safe_read(t[2]), tasks)):
            if err:
                # Chỉ báo hỏng theo ASSET (frame 0 hỏng là coi như hỏng), frame phụ lỗi thì bỏ qua.
                if fi == 0:
                    failed.append({"id": assets[ai]["id"], "err": err})
                continue
            loaded.append({"ai": ai, "fi": fi, "img": img, "w": w, "h": h})
    log(f"[media_score] đọc được {len(loaded)}/{len(tasks)} file ({len(failed)} asset hỏng)")

    vecs = enc.images([x["img"] for x in loaded]) if loaded else torch.zeros((0, 1))

    # --- Gộp frame về từng asset: vector = trung bình các frame, w/h/dhash lấy ở frame ĐẦU ---
    per_asset = {}
    for idx, item in enumerate(loaded):
        rec = per_asset.setdefault(item["ai"], {"vecs": [], "w": None, "h": None, "dhash": None})
        rec["vecs"].append(vecs[idx])
        if item["fi"] == 0 or rec["w"] is None:
            rec["w"], rec["h"] = item["w"], item["h"]
            rec["dhash"] = dhash_hex(item["img"])
    for rec in per_asset.values():
        rec["vec"] = torch.nn.functional.normalize(torch.stack(rec["vecs"]).mean(0), dim=-1)

    by_id = {}
    for ai, a in enumerate(assets):
        if ai in per_asset:
            by_id[a["id"]] = per_asset[ai]

    # --- Chấm điểm từng cảnh (asset dùng chung giữa các cảnh chỉ mã hoá 1 lần ở trên) ---
    out_scenes = []
    for sc in scenes:
        ids = [i for i in (sc.get("assetIds") or []) if i in by_id]
        if not ids:
            out_scenes.append({"key": sc.get("key"), "assets": []})
            continue
        av = torch.stack([by_id[i]["vec"] for i in ids])
        texts = [str(t).strip() for t in (sc.get("texts") or []) if str(t).strip()][:16]
        if texts:
            tv = encode_texts(enc, texts, is_siglip)
            sims = av @ tv.T                                    # (asset, text)
            # Ăn theo keyword khớp nhất (max) là chính, nhưng vẫn thưởng ảnh hợp với TOÀN cảnh (mean)
            # -> tránh ảnh chỉ dính đúng 1 từ khoá lạc lõng leo lên đầu.
            score = 0.7 * sims.max(dim=1).values + 0.3 * sims.mean(dim=1)
        else:
            score = torch.zeros(len(ids))
        groups = group_duplicates([by_id[i]["dhash"] for i in ids], av)
        out_scenes.append({"key": sc.get("key"), "assets": [
            {
                "id": aid,
                "w": by_id[aid]["w"],
                "h": by_id[aid]["h"],
                "dhash": by_id[aid]["dhash"],
                "score": round(float(score[k]), 4),
                "dup": int(groups[k]),
            }
            for k, aid in enumerate(ids)
        ]})

    json.dump({"model": model_name, "device": enc.device, "scenes": out_scenes, "failed": failed},
              sys.stdout, ensure_ascii=False)


def _safe_read(path):
    try:
        img, w, h = read_image(path)
        return img, w, h, None
    except Exception as e:                            # noqa: BLE001 - file hỏng/không đọc được là chuyện thường
        return None, 0, 0, str(e)[:200]


if __name__ == "__main__":
    main()
