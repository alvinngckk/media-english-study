#!/usr/bin/env python3
"""Media English Study — Flask static + YouTube captions API."""
from __future__ import annotations

import os
import traceback
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from mes_captions import fetch_youtube_captions

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "5173"))
HOST = os.environ.get("HOST", "0.0.0.0")

app = Flask(__name__, static_folder=None)

@app.after_request
def add_cors(resp: Response):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/api/youtube-captions", methods=["GET", "POST", "OPTIONS"])
def youtube_captions():
    if request.method == "OPTIONS":
        return ("", 204)
    url = ""
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        url = (data.get("url") or request.form.get("url") or "").strip()
    if not url:
        url = (request.args.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "請提供 url 參數（YouTube 影片連結）"}), 400

    try:
        result = fetch_youtube_captions(url)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        msg = str(e) or e.__class__.__name__
        # Normalize common yt-dlp errors for 繁中 UI
        low = msg.lower()
        if "sign in" in low or "bot" in low or "429" in low or "rate" in low:
            # Prefer message already localized by mes_youtube
            if "YOUTUBE_COOKIES" in msg or "cookies.txt" in msg or "Cookie" in msg:
                pass
            else:
                try:
                    from mes_youtube import cookies_configured
                    has_ck = cookies_configured()
                except Exception:
                    has_ck = False
                if has_ck:
                    msg = (
                        "YouTube 要求驗證（疑似機器人／限流）。已設定 Cookie 仍失敗；"
                        "請更新 cookies.txt／YOUTUBE_COOKIES，稍後再試，或改上傳 SRT／VTT。"
                    )
                else:
                    msg = (
                        "YouTube 要求驗證（疑似機器人／限流）。雲端 IP 常被擋；"
                        "可選：在伺服器設 YOUTUBE_COOKIES=cookies.txt 路徑（勿把 Cookie 貼到聊天），"
                        "或改下載／上傳 SRT／VTT。"
                    )
        elif "age" in low or "confirm your age" in low:
            msg = "此影片有年齡限制，無法在未登入情況下取得字幕。"
        elif "private" in low or "unavailable" in low:
            msg = "影片無法存取（私人、刪除或地區不可用）。"
        elif "no subtitle" in low or "沒有可用" in msg:
            pass
        else:
            # keep original but ensure readable
            msg = f"擷取字幕失敗：{msg}"
        app.logger.warning("youtube-captions error: %s\n%s", e, traceback.format_exc())
        return jsonify({"ok": False, "error": msg}), 502


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "service": "media-english-study", "youtube": True})


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def static_files(path: str):
    if path.startswith("api/"):
        return jsonify({"ok": False, "error": "Not found"}), 404
    target = ROOT / path if path else ROOT / "index.html"
    if path and target.is_file():
        return send_from_directory(ROOT, path)
    if (ROOT / "index.html").is_file() and (not path or not (ROOT / path).exists()):
        # SPA-ish fallback only for missing paths that look like pages
        if not path or path.endswith(".html"):
            return send_from_directory(ROOT, "index.html")
    if path and not target.exists():
        return jsonify({"ok": False, "error": "Not found"}), 404
    return send_from_directory(ROOT, "index.html")


def main():
    print(f"Media English Study → http://{HOST}:{PORT}/")
    print(f"YouTube captions API → http://{HOST}:{PORT}/api/youtube-captions?url=...")
    app.run(host=HOST, port=PORT, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
