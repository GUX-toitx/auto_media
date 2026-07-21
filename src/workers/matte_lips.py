#!/usr/bin/env python3
"""
Xoá nền video lips bằng Robust Video Matting (RVM) → composite người lên NỀN XANH (chroma green),
xuất mp4 nhỏ gọn (libx264). CapCut chỉ cần Chroma key màu xanh 1 lần là nền biến mất.

Dùng:
  python matte_lips.py <lips_dir>            # matte mọi N.mp4 → N_green.mp4 (bỏ qua cái đã có)
  python matte_lips.py <lips_dir> --force    # làm lại tất cả

Chạy bằng venv có torch+CUDA của LatentSync:
  /home/gux/workspace/lips_sync/lips_sync/.venv/bin/python
"""
import sys, os, glob, subprocess, re
import numpy as np
import torch

GREEN = np.array([0, 255, 0], dtype=np.float32)   # màu nền chroma
DOWNSAMPLE = 0.25                                   # RVM downsample cho nhanh (đủ nét cho talking head)


def probe(inp):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", inp],
        capture_output=True, text=True).stdout.strip().split(",")
    return int(out[0]), int(out[1]), out[2]


def matte_one(model, inp, outp):
    W, H, fr = probe(inp)
    rd = subprocess.Popen(["ffmpeg", "-v", "error", "-i", inp, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                          stdout=subprocess.PIPE)
    tmp = outp + ".part.mp4"
    # Ghép audio gốc lại (map từ input) để clip xanh vẫn có tiếng (dù CapCut sẽ mute lips)
    wr = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", fr, "-i", "-",
         "-i", inp, "-map", "0:v:0", "-map", "1:a:0?",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast",
         "-c:a", "aac", "-shortest", tmp],
        stdin=subprocess.PIPE)
    rec = [None] * 4
    n = 0
    with torch.no_grad():
        while True:
            raw = rd.stdout.read(W * H * 3)
            if len(raw) < W * H * 3:
                break
            f = np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(np.float32) / 255.0
            t = torch.from_numpy(f).permute(2, 0, 1).unsqueeze(0).cuda()
            fgr, pha, *rec = model(t, *rec, downsample_ratio=DOWNSAMPLE)
            fgr = fgr[0].permute(1, 2, 0).cpu().numpy() * 255.0
            pha = pha[0, 0].cpu().numpy()[..., None]
            comp = (fgr * pha + GREEN * (1.0 - pha)).clip(0, 255).astype(np.uint8)
            wr.stdin.write(comp.tobytes())
            n += 1
    wr.stdin.close(); rd.wait(); wr.wait()
    if os.path.exists(tmp) and os.path.getsize(tmp) > 10000:
        os.replace(tmp, outp)
        return n
    try:
        os.remove(tmp)
    except OSError:
        pass
    return 0


def main():
    if len(sys.argv) < 2:
        print("Usage: matte_lips.py <lips_dir> [--force]", file=sys.stderr)
        sys.exit(1)
    lips_dir = sys.argv[1]
    force = "--force" in sys.argv[2:]
    clips = sorted(
        [f for f in glob.glob(os.path.join(lips_dir, "*.mp4"))
         if re.match(r"^\d+\.mp4$", os.path.basename(f))],
        key=lambda p: int(os.path.splitext(os.path.basename(p))[0]))
    if not clips:
        print("[matte_lips] không có clip N.mp4 nào", file=sys.stderr)
        sys.exit(0)
    todo = [c for c in clips if force or not os.path.exists(c[:-4] + "_green.mp4")]
    print(f"[matte_lips] {len(clips)} clip, cần xử lý {len(todo)} (còn lại đã cache)", flush=True)
    if not todo:
        sys.exit(0)
    model = torch.hub.load("PeterL1n/RobustVideoMatting", "mobilenetv3").cuda().eval()
    for i, c in enumerate(todo, 1):
        outp = c[:-4] + "_green.mp4"
        try:
            n = matte_one(model, c, outp)
            print(f"[matte_lips] ({i}/{len(todo)}) {os.path.basename(c)} → {os.path.basename(outp)} ({n} frame)", flush=True)
        except Exception as e:
            print(f"[matte_lips] LỖI {os.path.basename(c)}: {e}", file=sys.stderr, flush=True)
    print("[matte_lips] xong", flush=True)


if __name__ == "__main__":
    main()
