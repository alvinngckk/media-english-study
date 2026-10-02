"""YouTube yt-dlp helpers (cookies, clients, probe/download)."""
from __future__ import annotations

import os
import shutil
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

# Client strategies: android/ios often survive when web is 429 / bot-checked.
_CLIENT_STRATEGIES: list[list[str]] = [
    ["android"],
    ["ios"],
    ["android", "web"],
    ["mweb"],
    ["web"],
]

_COOKIE_CANDIDATES = (
    "YOUTUBE_COOKIES",
    "MES_YOUTUBE_COOKIES",
    "YTDLP_COOKIES",
)

_COOKIE_PATHS = (
    Path("cookies.txt"),
    Path("/data/cookies.txt"),
    Path("/app/cookies.txt"),
    Path("/workspace/media-english-study/cookies.txt"),
)


def resolve_cookies_path() -> str | None:
    """Optional Netscape cookies.txt — never required; never read from chat."""
    for key in _COOKIE_CANDIDATES:
        raw = (os.environ.get(key) or "").strip()
        if not raw:
            continue
        p = Path(raw).expanduser()
        if p.is_file() and p.stat().st_size > 0:
            return str(p.resolve())
    for p in _COOKIE_PATHS:
        try:
            if p.is_file() and p.stat().st_size > 0:
                return str(p.resolve())
        except OSError:
            continue
    return None


def cookies_configured() -> bool:
    return resolve_cookies_path() is not None


def _js_runtimes() -> dict[str, dict[str, Any]] | None:
    """Prefer node when present (yt-dlp EJS / n-challenge)."""
    node = shutil.which("node") or shutil.which("nodejs")
    if node:
        return {"node": {"path": node}}
    deno = shutil.which("deno")
    if deno:
        return {"deno": {"path": deno}}
    return None


def ydl_base_opts(tmpdir: str, *, clients: list[str] | None = None) -> dict[str, Any]:
    clients = clients or ["android", "web"]
    opts: dict[str, Any] = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "vtt/best",
        "outtmpl": os.path.join(tmpdir, "%(id)s"),
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": False,
        "extractor_args": {"youtube": {"player_client": list(clients)}},
        "retries": 3,
        "fragment_retries": 3,
        "sleep_interval": 1,
        "max_sleep_interval": 3,
        "sleep_interval_subtitles": 1,
        "socket_timeout": 30,
    }
    try:
        from yt_dlp.networking.impersonate import ImpersonateTarget

        opts["impersonate"] = ImpersonateTarget()
    except Exception:
        pass
    js = _js_runtimes()
    if js:
        opts["js_runtimes"] = js
    cookie = resolve_cookies_path()
    if cookie:
        opts["cookiefile"] = cookie
    return opts


def _is_bot_or_rate_error(exc: BaseException | str) -> bool:
    msg = str(exc).lower()
    needles = (
        "sign in to confirm",
        "not a bot",
        "http error 429",
        "too many requests",
        "rate-limit",
        "rate limit",
        "bot",
        "cookies",
    )
    return any(n in msg for n in needles)


def _find_sub_file(tmpdir: str, video_id: str, lang: str) -> Path | None:
    for ext in ("vtt", "srt"):
        p = Path(tmpdir) / f"{video_id}.{lang}.{ext}"
        if p.is_file() and p.stat().st_size > 0:
            return p
    for p in Path(tmpdir).glob(f"{video_id}*.{lang}.*"):
        if p.suffix.lower() in (".vtt", ".srt") and p.stat().st_size > 0:
            return p
    for p in Path(tmpdir).glob(f"{video_id}*.*"):
        name = p.name
        if f".{lang}." in name and p.suffix.lower() in (".vtt", ".srt"):
            return p
    return None


def _disk_langs(tmpdir: str, video_id: str) -> list[str]:
    out: list[str] = []
    root = Path(tmpdir)
    if not root.is_dir():
        return out
    for pth in root.iterdir():
        if pth.suffix.lower() not in (".vtt", ".srt"):
            continue
        name = pth.name
        if not name.startswith(video_id + "."):
            continue
        mid = name[len(video_id) + 1 : -len(pth.suffix)]
        if mid:
            out.append(mid)
    return out


def _probe_info(url: str, tmpdir: str, clients: list[str]) -> dict[str, Any]:
    import yt_dlp

    info_opts = {
        **ydl_base_opts(tmpdir, clients=clients),
        "writesubtitles": False,
        "writeautomaticsub": False,
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(info_opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise RuntimeError("無法取得影片資訊（可能年齡限制、私人影片或地區封鎖）")
    return info


def _download_langs(url: str, tmpdir: str, langs: list[str], clients: list[str]) -> None:
    import yt_dlp

    # Expand to yt-dlp wildcards so keys like en-nP7-2PuUl7o still download.
    expanded: list[str] = []
    for lang in langs:
        if lang and lang not in expanded:
            expanded.append(lang)
        if lang.startswith("en") and "en.*" not in expanded:
            expanded.append("en.*")
        if lang.startswith("zh") and "zh.*" not in expanded:
            expanded.append("zh.*")
    if not expanded:
        expanded = ["en", "en.*"]

    for lang in expanded:
        dl_opts = {
            **ydl_base_opts(tmpdir, clients=clients),
            "subtitleslangs": [lang],
            "writesubtitles": True,
            "writeautomaticsub": True,
            "ignoreerrors": True,
            "skip_download": True,
        }
        try:
            with yt_dlp.YoutubeDL(dl_opts) as ydl:
                ydl.download([url])
        except Exception:
            continue
        time.sleep(0.45)
