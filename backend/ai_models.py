"""Groq model kimlikleri — tek kaynak (env ile override edilebilir)."""

from __future__ import annotations

import os

# Metin (hala listede): hızlı sohbet / yönlendirme
CHAT_MODEL = os.getenv("GROQ_CHAT_MODEL", "llama-3.1-8b-instant")

# Görsel (llama-3.2 / llama-4-scout kaldırıldı → qwen vision)
VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.6-27b")

# Ses
WHISPER_MODEL = os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3")
