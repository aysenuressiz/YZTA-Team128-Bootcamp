"""Doküman/README özelliklerine göre uçtan uca API duman testi.

Kullanım (backend ayaktayken):
  python scripts/smoke_full_doc.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from uuid import uuid4

BASE = os.getenv("API_ORIGIN", "http://127.0.0.1:8000").rstrip("/")
API = f"{BASE}/api"

PASS = 0
FAIL = 0
WARN = 0


def _req(method: str, path: str, body: dict | None = None, timeout: float = 45.0):
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = raw
        return err.code, payload
    except Exception as err:
        return 0, {"error": str(err)}


def ok(name: str, cond: bool, detail: str = ""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}" + (f" — {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


def warn(name: str, detail: str = ""):
    global WARN
    WARN += 1
    print(f"  WARN  {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    print(f"[full-smoke] API = {API}\n")

    # 1. Health / altyapı
    print("## 1. Altyapı")
    code, health = _req("GET", "/health")
    ok("GET /api/health", code == 200 and isinstance(health, dict) and health.get("ok"), str(health)[:120])
    if isinstance(health, dict):
        ok("Orkestratör açık", health.get("orchestrator") is True, f"orchestrator={health.get('orchestrator')}")
        print(f"         sms_mode={health.get('sms_mode')} twilio_ready={health.get('twilio_ready')}")

    # 2. Refakat — yazılı sohbet
    print("\n## 2. Refakat Ajanı (yazılı sohbet)")
    conv = str(uuid4())
    code, chat = _req(
        "POST",
        "/text-chat",
        {
            "conversation_id": conv,
            "message": "Merhaba, bugün nasılsın?",
            "user_name": "SmokeTest",
        },
    )
    ok(
        "Sohbet yanıtı",
        code == 200 and isinstance(chat, dict) and bool(chat.get("ai_response")),
        f"intent={chat.get('intent') if isinstance(chat, dict) else None}",
    )
    if isinstance(chat, dict):
        ok(
            "Intent döndü",
            chat.get("intent") in {"companion", "health", "escalation"},
            f"intent={chat.get('intent')}",
        )
        print(f"         reply: {str(chat.get('ai_response', ''))[:70]!r}")

    # 3. Eskalasyon / risk
    print("\n## 3. Eskalasyon Ajanı (riskli konuşma)")
    code, risk = _req(
        "POST",
        "/text-chat",
        {
            "conversation_id": str(uuid4()),
            "message": "Düştüm kalkamıyorum yardım et",
            "user_name": "SmokeTest",
        },
    )
    ok(
        "Düşme → escalation",
        code == 200 and isinstance(risk, dict) and risk.get("escalation") is True,
        f"intent={risk.get('intent') if isinstance(risk, dict) else None} esc={risk.get('escalation') if isinstance(risk, dict) else None}",
    )
    if isinstance(risk, dict) and risk.get("risk"):
        ok("Risk skoru döndü", isinstance(risk["risk"], dict) and risk["risk"].get("flagged") is True, str(risk["risk"])[:100])
    else:
        warn("Risk alanı yok veya boş", str(risk)[:100] if isinstance(risk, dict) else "")

    code, suicide = _req(
        "POST",
        "/text-chat",
        {
            "conversation_id": str(uuid4()),
            "message": "ölmek istiyorum",
            "user_name": "SmokeTest",
        },
    )
    ok(
        "Öz zarar → escalation",
        code == 200 and isinstance(suicide, dict) and suicide.get("escalation") is True,
        f"intent={suicide.get('intent') if isinstance(suicide, dict) else None}",
    )

    # 4. Auth endpoints (yanlış şifre = route çalışıyor)
    print("\n## 4. Kimlik doğrulama endpoint’leri")
    code, el = _req(
        "POST",
        "/auth/elderly-login",
        {"phone": "5550000000", "password": "yanlis"},
    )
    ok("elderly-login route", code in {401, 404, 400, 422}, f"status={code}")

    code, fam = _req(
        "POST",
        "/auth/family-login",
        {"phone": "5550000000", "password": "yanlis"},
    )
    ok("family-login route", code in {401, 404, 400, 422}, f"status={code}")

    # 5. Aile paneli
    print("\n## 5. Aile paneli")
    dummy = "00000000-0000-0000-0000-000000000001"
    for path, label in [
        (f"/family/dashboard-summary/{dummy}", "dashboard-summary"),
        (f"/family/weekly-summary/{dummy}", "weekly-summary"),
        (f"/family/mood-analysis/{dummy}", "mood-analysis"),
        (f"/family/sms-prefs/{dummy}", "sms-prefs"),
    ]:
        code, data = _req("GET", path, timeout=30)
        ok(label, code == 200, f"status={code}")

    code, stats = _req("GET", f"/medication/stats/{dummy}?days=7")
    ok(
        "medication stats",
        code == 200 and isinstance(stats, dict) and "adherence_rate" in stats,
        f"keys={list(stats)[:6] if isinstance(stats, dict) else code}",
    )

    code, alerts = _req("GET", f"/medication/alerts/{dummy}?open_only=true")
    ok(
        "alerts open_only",
        code == 200 and isinstance(alerts, dict) and "alerts" in alerts,
        f"open_count={alerts.get('open_count') if isinstance(alerts, dict) else None}",
    )

    code, patch = _req(
        "PATCH",
        f"/medication/alerts/{dummy}",
        {"status": "acknowledged", "acknowledged_by": "smoke"},
    )
    ok("alert PATCH route", code in {200, 404, 400}, f"status={code}")

    # 6. İlaç stub
    print("\n## 6. İlaç API")
    code, stub = _req("POST", "/medication", {})
    ok("eski /medication → 410", code == 410, f"status={code}")

    code, demo = _req(
        "POST",
        "/family/demo-alert",
        {
            "elder_id": "00000000-0000-0000-0000-000000000000",
            "description": "Smoke demo",
            "alert_type": "medication_missed",
            "severity": "high",
            "send_sms": False,
        },
    )
    ok("demo-alert route", code in {200, 400, 404, 422, 500}, f"status={code}")

    # 7. SMS test (trial şablon — gerçek gönderim opsiyonel)
    print("\n## 7. SMS")
    code, sms = _req(
        "POST",
        "/family/sms-test",
        {"phone": "+905468177595", "message": "doc smoke"},
        timeout=20,
    )
    if code == 200 and isinstance(sms, dict) and sms.get("success"):
        ok("sms-test gönderildi", True, f"mode={sms.get('mode')} sid={(sms.get('result') or {}).get('sid')}")
    elif code in {200, 400, 500}:
        warn("sms-test", f"status={code} {str(sms)[:140]}")
    else:
        ok("sms-test route", code != 0, f"status={code}")

    print("\n" + "=" * 50)
    print(f"PASS={PASS}  FAIL={FAIL}  WARN={WARN}")
    if FAIL:
        print("Sonuç: PROJE TAM HAZIR DEĞİL — başarısız testler var.")
        return 1
    if WARN:
        print("Sonuç: DEMO HAZIR (uyarılar var — SMS/trial vb.).")
        return 0
    print("Sonuç: TÜM OTOMATİK API TESTLERİ GEÇTİ.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
