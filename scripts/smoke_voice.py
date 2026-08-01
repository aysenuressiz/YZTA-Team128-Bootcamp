"""Sesli sohbet duman testi + manuel doğrulama listesi.

Kullanım (backend ayaktayken):
  python scripts/smoke_voice.py

Manuel checklist (kiosk'ta Chrome ile 1 kez):
  1) Merhaba
  2) Nasılsın
  3) İlacımı aldım
  4) Başım ağrıyor
  5) Biraz yorgunum
  6) Bugün hava güzel
  7) Teşekkür ederim
  8) Acil yardım (risk → aile paneli)
  9) Düştüm kalkamıyorum (eskalasyon)
 10) Sessiz kayıt (kısa bas-çek) → 'çok kısa/sessiz' mesajı
 11) Firefox/Safari: Whisper yolu mesajı görünür
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.error
import urllib.request
from uuid import uuid4
from wave import Wave_write

BASE = os.getenv("API_ORIGIN", "http://127.0.0.1:8000").rstrip("/")
API = f"{BASE}/api"

# backend path for unit junk filter
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))


def _multipart(fields: dict[str, str], file_field: str, filename: str, content: bytes, mime: str) -> tuple[bytes, str]:
    boundary = f"----YanimdaSmoke{uuid4().hex}"
    lines: list[bytes] = []
    for key, value in fields.items():
        lines.append(f"--{boundary}".encode())
        lines.append(f'Content-Disposition: form-data; name="{key}"'.encode())
        lines.append(b"")
        lines.append(str(value).encode("utf-8"))
    lines.append(f"--{boundary}".encode())
    lines.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode()
    )
    lines.append(f"Content-Type: {mime}".encode())
    lines.append(b"")
    lines.append(content)
    lines.append(f"--{boundary}--".encode())
    lines.append(b"")
    body = b"\r\n".join(lines)
    return body, f"multipart/form-data; boundary={boundary}"


def _tiny_wav(silence_ms: int = 40) -> bytes:
    """Kısa sessiz WAV — kısa-kayıt kapısından dönmeli (Whisper'a gitmeden)."""
    rate = 8000
    n = max(1, int(rate * silence_ms / 1000))
    buf = io.BytesIO()
    with Wave_write(buf) as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\x00\x00" * n)
    return buf.getvalue()


def _post_voice(audio: bytes, filename: str = "tiny.wav", mime: str = "audio/wav") -> tuple[int, dict]:
    fields = {
        "conversation_id": str(uuid4()),
        "user_name": "VoiceSmoke",
    }
    body, ctype = _multipart(fields, "file", filename, audio, mime)
    req = urllib.request.Request(
        f"{API}/voice-chat",
        data=body,
        headers={"Content-Type": ctype, "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"detail": raw}
    except Exception as err:
        return 0, {"error": str(err)}


def main() -> int:
    failures: list[str] = []
    print(f"[voice-smoke] API = {API}")

    try:
        from services.voice_junk import is_whisper_junk

        assert is_whisper_junk("İzlediğiniz için teşekkür ederim")
        assert not is_whisper_junk("Merhaba")
        print("[voice-smoke] junk filter OK")
    except Exception as err:
        failures.append(f"junk filter: {err}")
        print("FAIL:", failures[-1])

    # Kısa sessiz WAV → boş transcription / nazik mesaj (Whisper'a gitmeden)
    code, data = _post_voice(_tiny_wav(40))
    if code != 200:
        failures.append(f"tiny wav HTTP {code}: {data}")
        print("FAIL:", failures[-1])
    else:
        heard = (data.get("user_transcription") or data.get("text") or "").strip()
        reply = data.get("ai_response") or ""
        if heard:
            failures.append(f"tiny wav transcription beklenmiyordu: {heard!r}")
            print("FAIL:", failures[-1])
        elif not reply:
            failures.append("tiny wav ai_response boş")
            print("FAIL:", failures[-1])
        else:
            print(f"[voice-smoke] kısa/sessiz kayıt OK → {reply[:70]!r}")

    # Boş dosya
    code, data = _post_voice(b"", filename="empty.webm", mime="audio/webm")
    if code == 200 and not (data.get("user_transcription") or "").strip():
        print("[voice-smoke] boş blob OK")
    elif code == 0:
        failures.append(f"backend erişilemiyor: {data}")
        print("FAIL:", failures[-1])
    else:
        print(f"[voice-smoke] boş blob status={code} (kabul)")

    if failures:
        print(f"[voice-smoke] {len(failures)} hata")
        return 1
    print("[voice-smoke] geçti")
    print("[voice-smoke] Manuel checklist: scripts/smoke_voice.py dosya başlığı")
    return 0


if __name__ == "__main__":
    sys.exit(main())
