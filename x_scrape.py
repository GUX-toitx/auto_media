#!/usr/bin/env python3
"""
Cào X (Twitter) bằng twscrape.
- Đăng ký 1 account từ cookies (auth_token, ct0) lấy từ profile Playwright đã login.
- Hỗ trợ: --search "<query>" (nhiều query cách nhau bởi |) và/hoặc --urls url1,url2
- In ra stdout JSON: [{id, url, user, date, text, media:[{type, url}]}]

Chạy (qua venv):
  .venv/bin/python x_scrape.py --cookies "auth_token=..; ct0=.." --search "tu khoa" --limit 20
"""
import argparse
import asyncio
import json
import sys

from twscrape import API


def extract_media(t):
    media = []
    m = getattr(t, "media", None)
    if not m:
        return media
    for p in (getattr(m, "photos", None) or []):
        if getattr(p, "url", None):
            media.append({"type": "photo", "url": p.url})
    for v in (getattr(m, "videos", None) or []):
        variants = [x for x in (getattr(v, "variants", None) or []) if getattr(x, "url", None)]
        if variants:
            best = max(variants, key=lambda x: getattr(x, "bitrate", 0) or 0)
            media.append({"type": "video", "url": best.url})
    for g in (getattr(m, "animated", None) or []):
        vids = getattr(g, "videos", None) or []
        if vids and getattr(vids[0], "url", None):
            media.append({"type": "video", "url": vids[0].url})
    return media


def tweet_to_dict(t):
    return {
        "id": str(t.id),
        "url": getattr(t, "url", ""),
        "user": getattr(getattr(t, "user", None), "username", ""),
        "date": str(getattr(t, "date", "")),
        "text": getattr(t, "rawContent", "") or "",
        "media": extract_media(t),
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cookies", required=True, help='"auth_token=..; ct0=.."')
    ap.add_argument("--search", default="", help="query, nhiều query cách nhau bởi |")
    ap.add_argument("--urls", default="", help="url1,url2,...")
    ap.add_argument("--limit", type=int, default=20, help="số tweet mỗi query search")
    ap.add_argument("--db", default="accounts.db")
    a = ap.parse_args()

    api = API(a.db)
    # Đăng ký account từ cookies (bỏ qua nếu đã tồn tại)
    try:
        await api.pool.add_account("x_session", "x_session", "x@session.local", "x", cookies=a.cookies)
    except Exception as e:
        print(f"[x_scrape] add_account: {e}", file=sys.stderr)

    out, seen = [], set()

    def push(t):
        if not t or str(t.id) in seen:
            return
        seen.add(str(t.id))
        out.append(tweet_to_dict(t))

    # Search theo keyword
    if a.search.strip():
        for q in [q.strip() for q in a.search.split("|") if q.strip()]:
            try:
                async for t in api.search(q, limit=a.limit):
                    push(t)
            except Exception as e:
                print(f"[x_scrape] search '{q}': {e}", file=sys.stderr)

    # Fetch theo URL cụ thể
    if a.urls.strip():
        for u in [u.strip() for u in a.urls.split(",") if u.strip()]:
            tid = u.rstrip("/").split("/")[-1].split("?")[0]
            if not tid.isdigit():
                print(f"[x_scrape] URL bỏ qua (không tìm thấy id): {u}", file=sys.stderr)
                continue
            try:
                t = await api.tweet_details(int(tid))
                push(t)
            except Exception as e:
                print(f"[x_scrape] tweet {tid}: {e}", file=sys.stderr)

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
