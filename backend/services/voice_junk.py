"""Whisper sessizlik / YouTube altyazı uydurmalarını filtrele."""

from __future__ import annotations

import re
import unicodedata


def is_whisper_junk(text: str) -> bool:
    raw = (text or "").strip()
    if not raw:
        return True
    low = unicodedata.normalize("NFD", raw.lower())
    low = "".join(ch for ch in low if unicodedata.category(ch) != "Mn")
    exact = {
        "", ".", "..", "...", "sessizlik", "altyazi",
        "m.k.", "subtitle", "subtitles",
        "thank you", "thanks for watching",
    }
    if low in exact:
        return True
    if "izlediginiz" in low and "tesekkur" in low:
        return True
    if re.search(r"izlediginiz\s+icin", low):
        return True
    if re.search(r"thanks?\s+for\s+watching|thank\s+you\s+for\s+watching", low):
        return True
    if re.search(r"^(altyaz|subtitle)", low):
        return True
    if re.search(r"\babone\s+ol|\bsubscribe\b|amara\.org|translated\s+by", low):
        return True
    if re.search(r"\bbeğenmeyi\b|\bbegenmeyi\b|\blik[eé]\s+and\s+subscribe", low):
        return True
    return False
