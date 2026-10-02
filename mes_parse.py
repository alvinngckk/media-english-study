#!/usr/bin/env python3
"""
Media English Study — local static + YouTube captions API.
Serves the SPA and /api/youtube-captions via yt-dlp (no browser cookies).
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

# Prefer Traditional Chinese, then generic zh / Hans as last resort.
ZH_LANG_PRIORITY = [
    "zh-Hant",
    "zh-TW",
    "zh-HK",
    "zh-Hant-en",
    "zh-Hant-de",
    "zh",
    "zh-CN",
    "zh-Hans",
    "zh-Hans-en",
    "zh-Hans-de",
]
EN_LANG_PRIORITY = [
    "en",
    "en-US",
    "en-GB",
    "en-en",
    "a.en",
]

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
}


def is_youtube_url(url: str) -> bool:
    try:
        u = urlparse(url.strip())
    except Exception:
        return False
    if u.scheme not in ("http", "https"):
        return False
    host = (u.hostname or "").lower()
    if host in YOUTUBE_HOSTS:
        return True
    if host.endswith(".youtube.com"):
        return True
    return False


def extract_video_id(url: str) -> str | None:
    try:
        u = urlparse(url.strip())
    except Exception:
        return None
    host = (u.hostname or "").lower()
    if host in ("youtu.be", "www.youtu.be"):
        vid = u.path.strip("/").split("/")[0]
        return vid or None
    if "youtube.com" in host:
        qs = parse_qs(u.query)
        if "v" in qs and qs["v"]:
            return qs["v"][0]
        parts = [p for p in u.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in ("embed", "shorts", "live", "v"):
            return parts[1]
    return None


def strip_tags(html: str) -> str:
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    html = re.sub(r"</?[^>]+>", "", html)
    return (
        html.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .strip()
    )


def parse_timestamp(s: str) -> float:
    s = s.strip().replace(",", ".")
    parts = s.split(":")
    try:
        if len(parts) == 3:
            h, m, sec = float(parts[0]), float(parts[1]), float(parts[2])
        elif len(parts) == 2:
            h, m, sec = 0.0, float(parts[0]), float(parts[1])
        else:
            h, m, sec = 0.0, 0.0, float(parts[0])
        return h * 3600 + m * 60 + sec
    except ValueError:
        return 0.0


def parse_vtt_or_srt(text: str) -> list[dict[str, Any]]:
    if not text or not text.strip():
        return []
    raw = text.replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n")
    if re.match(r"^WEBVTT", raw.strip(), re.I):
        raw = re.sub(r"^WEBVTT[^\n]*\n", "", raw.strip() + "\n", count=1, flags=re.I)
        raw = re.sub(
            r"^(STYLE|REGION|NOTE)[^\n]*\n(?:.*\n)*?(?=\n\n|\n(?=\d|\w))",
            "\n",
            raw,
            flags=re.I | re.M,
        )
    blocks = [b.strip() for b in re.split(r"\n\s*\n", raw) if b.strip()]
    result: list[dict[str, Any]] = []
    for block in blocks:
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        time_idx = next((i for i, l in enumerate(lines) if "-->" in l), -1)
        if time_idx < 0:
            continue
        m = re.search(r"([\d:.,]+)\s*-->\s*([\d:.,]+)", lines[time_idx])
        if not m:
            continue
        start, end = parse_timestamp(m.group(1)), parse_timestamp(m.group(2))
        if not (end > start):
            continue
        text_lines = [strip_tags(l) for l in lines[time_idx + 1 :] if strip_tags(l)]
        # Drop duplicate consecutive lines (common in auto-captions / karaoke VTT)
        deduped: list[str] = []
        for tl in text_lines:
            if not deduped or deduped[-1] != tl:
                deduped.append(tl)
        body = " ".join(deduped).strip()
        if not body:
            continue
        # Skip if identical to previous cue (rolling auto-captions)
        if result and abs(result[-1]["start"] - start) < 0.05 and result[-1]["text"] == body:
            result[-1]["end"] = max(result[-1]["end"], end)
            continue
        result.append({"start": start, "end": end, "text": body})
    return result


def pick_lang(available: dict[str, Any], priority: list[str]) -> str | None:
    if not available:
        return None
    # Exact priority match
    for code in priority:
        if code in available:
            return code
    # Prefix match e.g. en-US for "en"
    keys = list(available.keys())
    for code in priority:
        base = code.split("-")[0]
        for k in keys:
            if k == code or k.startswith(code + "-") or k.startswith(base + "-"):
                # Prefer Traditional over Hans when looking for zh-Hant family
                if code.startswith("zh-Hant") and "Hans" in k:
                    continue
                return k
    # Fallback: any key starting with en / zh
    family = priority[0].split("-")[0]
    for k in keys:
        if k == family or k.startswith(family + "-") or k.startswith(family + "."):
            if family == "zh" and "Hans" in k and any("Hant" in x or x in ("zh-TW", "zh-HK") for x in keys):
                continue
            return k
    return None


def merge_tracks(
    en_cues: list[dict[str, Any]], zh_cues: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if en_cues and not zh_cues:
        return [{"start": c["start"], "end": c["end"], "en": c["text"], "zh": ""} for c in en_cues]
    if zh_cues and not en_cues:
        return [{"start": c["start"], "end": c["end"], "en": "", "zh": c["text"]} for c in zh_cues]
    if not en_cues and not zh_cues:
        return []

    merged: list[dict[str, Any]] = []
    for i, ec in enumerate(en_cues):
        best = None
        best_overlap = 0.0
        for zc in zh_cues:
            overlap = min(ec["end"], zc["end"]) - max(ec["start"], zc["start"])
            if overlap > best_overlap:
                best_overlap = overlap
                best = zc
        zh = ""
        if best and best_overlap > 0.15:
            zh = best["text"]
        elif i < len(zh_cues):
            zh = zh_cues[i]["text"]
        merged.append(
            {"start": ec["start"], "end": ec["end"], "en": ec["text"], "zh": zh}
        )
    return merged
