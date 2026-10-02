from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

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

def ydl_base_opts(tmpdir: str) -> dict[str, Any]:
    return {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "vtt",
        "outtmpl": os.path.join(tmpdir, "%(id)s"),
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": False,
        # android client often works when web is rate-limited / bot-checked
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
        "retries": 2,
        "fragment_retries": 2,
    }


def fetch_youtube_captions(url: str) -> dict[str, Any]:
    import yt_dlp

    if not is_youtube_url(url):
        raise ValueError("不是有效的 YouTube 網址（支援 youtube.com / youtu.be）")

    with tempfile.TemporaryDirectory(prefix="ytcaps-") as tmpdir:
        # 1) Probe available langs
        info_opts = {
            **ydl_base_opts(tmpdir),
            "writesubtitles": False,
            "writeautomaticsub": False,
        }
        with yt_dlp.YoutubeDL(info_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        if not info:
            raise RuntimeError("無法取得影片資訊（可能年齡限制、私人影片或地區封鎖）")

        title = info.get("title") or ""
        video_id = info.get("id") or extract_video_id(url) or ""
        manual = info.get("subtitles") or {}
        auto = info.get("automatic_captions") or {}

        # Prefer manual over auto for each family
        en_lang = pick_lang(manual, EN_LANG_PRIORITY) or pick_lang(auto, EN_LANG_PRIORITY)
        zh_lang = pick_lang(manual, ZH_LANG_PRIORITY) or pick_lang(auto, ZH_LANG_PRIORITY)

        wanted: list[str] = []
        if en_lang:
            wanted.append(en_lang)
        if zh_lang and zh_lang not in wanted:
            wanted.append(zh_lang)
        # Probe sometimes omits auto list — try English only; MT fills zh later if needed
        if not wanted:
            wanted = ["en"]

        if not manual and not auto and not en_lang and not zh_lang:
            # Still attempt en download; if that fails we error below
            pass

        # 2) Download selected subtitle files (one lang at a time to survive 429 on a single track)
        for lang in wanted:
            dl_opts = {
                **ydl_base_opts(tmpdir),
                "subtitleslangs": [lang],
                "writesubtitles": True,
                "writeautomaticsub": True,
                "ignoreerrors": True,
            }
            try:
                with yt_dlp.YoutubeDL(dl_opts) as ydl:
                    ydl.download([url])
            except Exception:
                continue

        def find_sub_file(lang: str) -> Path | None:
            # yt-dlp names: {id}.{lang}.vtt  or {id}.{lang}.srt
            for ext in ("vtt", "srt"):
                p = Path(tmpdir) / f"{video_id}.{lang}.{ext}"
                if p.is_file() and p.stat().st_size > 0:
                    return p
            # Fuzzy: id.*.lang.*
            for p in Path(tmpdir).glob(f"{video_id}*.{lang}.*"):
                if p.suffix.lower() in (".vtt", ".srt") and p.stat().st_size > 0:
                    return p
            for p in Path(tmpdir).glob(f"{video_id}*.*"):
                name = p.name
                if f".{lang}." in name and p.suffix.lower() in (".vtt", ".srt"):
                    return p
            return None

        en_cues: list[dict[str, Any]] = []
        zh_cues: list[dict[str, Any]] = []
        used_en = None
        used_zh = None

        # Discover what actually landed on disk
        disk_langs = []
        for pth in Path(tmpdir).iterdir():
            if pth.suffix.lower() not in (".vtt", ".srt"):
                continue
            # id.LANG.ext  — lang may contain hyphens
            name = pth.name
            if not name.startswith(video_id + "."):
                continue
            mid = name[len(video_id) + 1 : -len(pth.suffix)]
            if mid:
                disk_langs.append(mid)

        if not en_lang:
            en_lang = pick_lang({k: True for k in disk_langs}, EN_LANG_PRIORITY)
        if not zh_lang:
            zh_lang = pick_lang({k: True for k in disk_langs}, ZH_LANG_PRIORITY)

        if en_lang:
            fp = find_sub_file(en_lang)
            if fp:
                en_cues = parse_vtt_or_srt(fp.read_text(encoding="utf-8", errors="replace"))
                used_en = en_lang
        if zh_lang:
            fp = find_sub_file(zh_lang)
            if fp:
                zh_cues = parse_vtt_or_srt(fp.read_text(encoding="utf-8", errors="replace"))
                used_zh = zh_lang

        if not en_cues and not zh_cues:
            raise RuntimeError(
                "已偵測到字幕語言，但下載失敗（YouTube 可能限流／需登入／年齡限制）。"
                "請稍後再試，或改上傳 SRT／VTT。"
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
                "auto": sorted(auto.keys())[:80],  # cap size
            },
            "warnings": warnings,
            "cues": cues,
            "count": len(cues),
        }
