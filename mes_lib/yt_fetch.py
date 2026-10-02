"""YouTube caption fetch orchestration."""
from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from mes_parse import (
    EN_LANG_PRIORITY,
    ZH_LANG_PRIORITY,
    extract_video_id,
    is_youtube_url,
    merge_tracks,
    parse_vtt_or_srt,
    pick_lang,
)
from mes_mt import translate_cues_en_to_zh_hant
from mes_lib.yt_common import (
    _CLIENT_STRATEGIES,
    _download_langs,
    _find_sub_file,
    _disk_langs,
    _is_bot_or_rate_error,
    _probe_info,
    cookies_configured,
    resolve_cookies_path,
)

def _timedtext_fallback(video_id: str, tmpdir: str, langs: list[str]) -> list[str]:
    """Best-effort official timedtext without cookies (often empty under 429)."""
    got: list[str] = []
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    }
    for lang in langs:
        for kind in (None, "asr"):
            qs: dict[str, str] = {"v": video_id, "lang": lang, "fmt": "vtt"}
            if kind:
                qs["kind"] = kind
            url = "https://www.youtube.com/api/timedtext?" + urlencode(qs)
            try:
                req = Request(url, headers=headers)
                with urlopen(req, timeout=20) as resp:
                    data = resp.read()
                if not data or len(data) < 40:
                    continue
                text = data.decode("utf-8", errors="replace")
                if "WEBVTT" not in text and "-->" not in text:
                    continue
                dest = Path(tmpdir) / f"{video_id}.{lang}.vtt"
                dest.write_text(text, encoding="utf-8")
                got.append(lang)
                break
            except Exception:
                continue
        time.sleep(0.4)
    return got


def _bot_error_message() -> str:
    if cookies_configured():
        return (
            "YouTube 要求驗證（疑似機器人／限流）。已偵測到 Cookie 檔仍失敗；"
            "請更新 cookies.txt／YOUTUBE_COOKIES，稍後再試，或改上傳 SRT／VTT。"
        )
    return (
        "YouTube 要求驗證（疑似機器人／限流）。雲端主機 IP 常被擋；"
        "可在伺服器設定環境變數 YOUTUBE_COOKIES 指向 Netscape cookies.txt，"
        "或改上傳／下載 SRT／VTT。請勿在對話中貼上 Cookie 內容。"
    )


def fetch_youtube_captions(url: str) -> dict[str, Any]:
    if not is_youtube_url(url):
        raise ValueError("不是有效的 YouTube 網址（支援 youtube.com / youtu.be）")

    last_err: BaseException | None = None
    with tempfile.TemporaryDirectory(prefix="ytcaps-") as tmpdir:
        info: dict[str, Any] | None = None
        used_clients: list[str] | None = None

        for clients in _CLIENT_STRATEGIES:
            try:
                info = _probe_info(url, tmpdir, clients)
                used_clients = clients
                break
            except Exception as e:
                last_err = e
                if _is_bot_or_rate_error(e):
                    time.sleep(1.2)
                    continue
                # Non-bot errors: still try next client once
                time.sleep(0.5)
                continue

        video_id = extract_video_id(url) or ""
        title = ""
        manual: dict[str, Any] = {}
        auto: dict[str, Any] = {}

        if info:
            title = info.get("title") or ""
            video_id = info.get("id") or video_id
            manual = info.get("subtitles") or {}
            auto = info.get("automatic_captions") or {}

        if not video_id:
            if last_err and _is_bot_or_rate_error(last_err):
                raise RuntimeError(_bot_error_message()) from last_err
            raise RuntimeError(
                str(last_err) if last_err else "無法取得影片資訊（可能年齡限制、私人影片或地區封鎖）"
            )

        en_lang = pick_lang(manual, EN_LANG_PRIORITY) or pick_lang(auto, EN_LANG_PRIORITY)
        zh_lang = pick_lang(manual, ZH_LANG_PRIORITY) or pick_lang(auto, ZH_LANG_PRIORITY)

        wanted: list[str] = []
        if en_lang:
            wanted.append(en_lang)
        if zh_lang and zh_lang not in wanted:
            wanted.append(zh_lang)
        if not wanted:
            wanted = ["en"]

        # Download with the successful probe clients first, then fall back.
        client_order: list[list[str]] = []
        if used_clients:
            client_order.append(used_clients)
        for c in _CLIENT_STRATEGIES:
            if c not in client_order:
                client_order.append(c)

        for clients in client_order:
            _download_langs(url, tmpdir, wanted, clients)
            if any(_find_sub_file(tmpdir, video_id, lang) for lang in wanted):
                break
            time.sleep(0.8)

        # timedtext last resort (no cookies)
        if not any(_find_sub_file(tmpdir, video_id, lang) for lang in wanted):
            _timedtext_fallback(video_id, tmpdir, wanted)

        disk_langs = _disk_langs(tmpdir, video_id)
        if not en_lang:
            en_lang = pick_lang({k: True for k in disk_langs}, EN_LANG_PRIORITY)
        if not zh_lang:
            zh_lang = pick_lang({k: True for k in disk_langs}, ZH_LANG_PRIORITY)

        en_cues: list[dict[str, Any]] = []
        zh_cues: list[dict[str, Any]] = []
        used_en = None
        used_zh = None

        if en_lang:
            fp = _find_sub_file(tmpdir, video_id, en_lang)
            if fp:
                en_cues = parse_vtt_or_srt(fp.read_text(encoding="utf-8", errors="replace"))
                used_en = en_lang
        if zh_lang:
            fp = _find_sub_file(tmpdir, video_id, zh_lang)
            if fp:
                zh_cues = parse_vtt_or_srt(fp.read_text(encoding="utf-8", errors="replace"))
                used_zh = zh_lang

        if not en_cues and not zh_cues:
            # One more aggressive pass: try downloading "en" with android only
            _download_langs(url, tmpdir, ["en", "en-US", "en-GB"], ["android"])
            for lang in ("en", "en-US", "en-GB", *disk_langs):
                fp = _find_sub_file(tmpdir, video_id, lang)
                if fp:
                    en_cues = parse_vtt_or_srt(fp.read_text(encoding="utf-8", errors="replace"))
                    used_en = lang
                    break
            if not en_cues and not zh_cues:
                if last_err and _is_bot_or_rate_error(last_err):
                    raise RuntimeError(_bot_error_message()) from last_err
                raise RuntimeError(
                    "已偵測到字幕語言，但下載失敗（YouTube 可能限流／需登入／年齡限制）。"
                    + (
                        " 可設定 YOUTUBE_COOKIES 指向 cookies.txt（勿貼到聊天）。"
                        if not cookies_configured()
                        else " 請更新 Cookie 檔後再試。"
                    )
                    + " 或改上傳 SRT／VTT。"
                )

        cues = merge_tracks(en_cues, zh_cues)
        warnings: list[str] = []
        translated = False
        if cues and any((c.get("en") or "").strip() and not (c.get("zh") or "").strip() for c in cues):
            cues, mt_note = translate_cues_en_to_zh_hant(cues)
            if mt_note:
                warnings.append(mt_note)
            if any((c.get("zh") or "").strip() for c in cues) and not used_zh:
                used_zh = "zh-Hant (MT)"
                translated = True
        if zh_cues and not en_cues:
            warnings.append("找不到英文字幕，僅載入中文。")

        return {
            "ok": True,
            "videoId": video_id,
            "title": title,
            "url": url,
            "langs": {"en": used_en, "zh": used_zh},
            "translated": translated,
            "available": {
                "manual": sorted(manual.keys()),
                "auto": sorted(auto.keys())[:80],
            },
            "warnings": warnings,
            "cues": cues,
            "count": len(cues),
            "cookiesUsed": cookies_configured(),
            "playerClients": used_clients,
        }
