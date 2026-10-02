from __future__ import annotations
from typing import Any
import time


def _translate_texts_en_to_zh_hant(texts: list[str]) -> list[str]:
    """Translate EN→Traditional Chinese. Prefer offline Argos (en→zt); fallback deep-translator."""
    if not texts:
        return []
    # 1) Offline Argos Translate (en → zt = Traditional Chinese)
    try:
        import argostranslate.translate  # type: ignore

        installed = argostranslate.translate.get_installed_languages()
        en_lang = next((l for l in installed if l.code == "en"), None)
        zt_lang = next((l for l in installed if l.code in ("zt", "zh-tw", "zh_Hant")), None)
        if en_lang and zt_lang:
            tr = en_lang.get_translation(zt_lang)
            out = [(tr.translate(t) or "").strip() if t else "" for t in texts]
            if any(out):
                return out
            # Empty results → try online fallback below
        else:
            out = []
            for t in texts:
                out.append(
                    (argostranslate.translate.translate(t, "en", "zt") or "").strip() if t else ""
                )
            if any(out):
                return out
    except Exception:
        pass

    # 2) Online fallback: deep-translator Google → zh-TW
    # Google free MT ~5 req/s — use tiny batches + delays; keep EN on failure (caller).
    try:
        from deep_translator import GoogleTranslator

        translator = GoogleTranslator(source="en", target="zh-TW")
        out: list[str] = []
        BATCH = 5
        DELAY_S = 0.35
        for start in range(0, len(texts), BATCH):
            if start:
                time.sleep(DELAY_S)
            chunk = texts[start : start + BATCH]
            try:
                if hasattr(translator, "translate_batch") and len(chunk) > 1:
                    batch = translator.translate_batch(chunk)
                    if not isinstance(batch, list):
                        batch = [batch]
                    batch = [str(x or "").strip() for x in batch]
                    while len(batch) < len(chunk):
                        batch.append("")
                    out.extend(batch[: len(chunk)])
                else:
                    for j, t in enumerate(chunk):
                        if j:
                            time.sleep(DELAY_S)
                        out.append((translator.translate(t) or "").strip() if t else "")
            except Exception:
                time.sleep(1.2)
                for j, t in enumerate(chunk):
                    if j:
                        time.sleep(DELAY_S)
                    try:
                        out.append((translator.translate(t) or "").strip() if t else "")
                    except Exception:
                        out.append("")
        return out
    except Exception as e:
        raise RuntimeError(f"online MT failed: {e}") from e


def translate_cues_en_to_zh_hant(cues: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    """Fill empty zh from en (Argos offline en→zt, else deep-translator). Keep EN if MT fails."""
    need = [i for i, c in enumerate(cues) if (c.get("en") or "").strip() and not (c.get("zh") or "").strip()]
    if not need:
        return cues, None
    texts = [(cues[i].get("en") or "").strip() for i in need]
    try:
        translated = _translate_texts_en_to_zh_hant(texts)
    except Exception as e:
        return cues, f"自動英→繁翻譯失敗（{e}）。已保留英文字幕，可於介面逐行補繁中。"

    if len(translated) != len(need):
        while len(translated) < len(need):
            translated.append("")
        translated = translated[: len(need)]

    out_cues = [dict(c) for c in cues]
    filled = 0
    for idx, zh in zip(need, translated):
        zh = (zh or "").strip()
        if zh:
            out_cues[idx]["zh"] = zh
            filled += 1
    if filled == 0:
        return cues, "自動英→繁未產生有效譯文。已保留英文，可於介面逐行補繁中。"
    note = f"無官方／自動中文字幕；已自動英→繁（zh-Hant）翻譯 {filled}/{len(need)} 句。"
    return out_cues, note
