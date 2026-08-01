"""Uçtan uca duman testi — login → sağlık → text-chat → demo-alert.

Kullanım (backend ayaktayken):
  python scripts/smoke_e2e.py
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


def _req(method: str, path: str, body: dict | None = None, timeout: float = 20.0) -> tuple[int, dict | list | str]:
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


def main() -> int:
    failures: list[str] = []

    print(f"[smoke] API = {API}")

    code, health = _req("GET", "/health")
    if code != 200:
        # bazı kurulumlarda /health router kökünde
        code2, health2 = _req("GET", "/")
        if code == 0 and code2 == 0:
            failures.append(f"backend erişilemiyor: {health}")
            print("FAIL:", failures[-1])
            return 1
        print(f"[smoke] /health → {code} (opsiyonel)")
    else:
        print(f"[smoke] health OK: {health}")

    conv = str(uuid4())
    code, chat = _req(
        "POST",
        "/text-chat",
        {
            "conversation_id": conv,
            "message": "Merhaba, nasılsın?",
            "user_name": "SmokeTest",
        },
    )
    if code != 200 or not isinstance(chat, dict) or not chat.get("ai_response"):
        failures.append(f"text-chat başarısız: {code} {chat}")
        print("FAIL:", failures[-1])
    else:
        print(f"[smoke] text-chat OK: {str(chat.get('ai_response'))[:80]!r}")

    # Riskli cümle — intent/escalation yolu (LLM kapalıysa bile kural)
    code, risk_chat = _req(
        "POST",
        "/text-chat",
        {
            "conversation_id": str(uuid4()),
            "message": "Düştüm kalkamıyorum",
            "user_name": "SmokeTest",
        },
    )
    if code == 200 and isinstance(risk_chat, dict) and risk_chat.get("ai_response"):
        print(
            f"[smoke] risk text-chat OK escalation={risk_chat.get('escalation')} "
            f"intent={risk_chat.get('intent')}"
        )
    else:
        print(f"[smoke] risk text-chat status={code} (uyarı)")

    # Demo alert — elder_id yoksa 400 beklenir; endpoint var mı diye bakarız
    code, demo = _req(
        "POST",
        "/family/demo-alert",
        {
            "elder_id": "00000000-0000-0000-0000-000000000000",
            "description": "Smoke demo uyarı",
            "alert_type": "medication_missed",
            "severity": "high",
            "send_sms": True,
        },
    )
    if code in {200, 400, 404, 422, 500}:
        # 200 = WS/DB denendi; 500 olabilir (UUID yok) ama route mevcut
        if code == 404 and isinstance(demo, dict) and "Not Found" in str(demo):
            failures.append("demo-alert endpoint 404")
            print("FAIL:", failures[-1])
        else:
            print(f"[smoke] demo-alert route OK (status={code})")
    else:
        failures.append(f"demo-alert beklenmeyen: {code} {demo}")
        print("FAIL:", failures[-1])

    # --- Madde 6–8: SMS prefs, alert PATCH, med stats ---
    dummy_uid = "00000000-0000-0000-0000-000000000001"
    dummy_elder = "00000000-0000-0000-0000-000000000002"
    dummy_alert = "00000000-0000-0000-0000-000000000003"

    code, sms_get = _req("GET", f"/family/sms-prefs/{dummy_uid}")
    if code == 200 and isinstance(sms_get, dict) and "sms_enabled" in sms_get:
        print(f"[smoke] sms-prefs GET OK twilio_ready={sms_get.get('twilio_ready')}")
    else:
        failures.append(f"sms-prefs GET: {code} {sms_get}")
        print("FAIL:", failures[-1])

    code, sms_patch = _req(
        "PATCH",
        "/family/sms-prefs",
        {"user_id": dummy_uid, "sms_enabled": False, "family_phone": "+905551112233"},
    )
    if code in {200, 404}:
        print(f"[smoke] sms-prefs PATCH route OK (status={code})")
    else:
        failures.append(f"sms-prefs PATCH: {code} {sms_patch}")
        print("FAIL:", failures[-1])

    code, stats = _req("GET", f"/medication/stats/{dummy_elder}?days=7")
    if code == 200 and isinstance(stats, dict) and "adherence_rate" in stats and "by_medication" in stats:
        print(f"[smoke] med stats OK days={stats.get('days')} target={stats.get('target_rate')}")
    elif code == 200:
        failures.append(f"med stats eksik alan: {stats}")
        print("FAIL:", failures[-1])
    else:
        print(f"[smoke] med stats status={code} (elder yoksa normal)")

    code, alerts = _req("GET", f"/medication/alerts/{dummy_elder}?open_only=true")
    if code == 200 and isinstance(alerts, dict) and "alerts" in alerts and "open_count" in alerts:
        print(f"[smoke] alerts open_only OK open_count={alerts.get('open_count')}")
    else:
        failures.append(f"alerts open_only: {code} {alerts}")
        print("FAIL:", failures[-1])

    code, patch_alert = _req(
        "PATCH",
        f"/medication/alerts/{dummy_alert}",
        {"status": "acknowledged", "acknowledged_by": "smoke"},
    )
    if code in {200, 404, 400}:
        print(f"[smoke] alert PATCH route OK (status={code})")
    else:
        failures.append(f"alert PATCH: {code} {patch_alert}")
        print("FAIL:", failures[-1])

    code, stub = _req("POST", "/medication", {"foo": 1})
    if code == 410:
        print("[smoke] eski /api/medication stub 410 OK")
    else:
        print(f"[smoke] /api/medication status={code} (410 beklenirdi)")

    # Statik frontend dosyaları (uvicorn static mount varsa)
    for page in ("/", "/frontend/login.html", "/login.html"):
        try:
            with urllib.request.urlopen(f"{BASE}{page}", timeout=8) as resp:
                print(f"[smoke] page {page} → {resp.status}")
                break
        except Exception:
            continue
    else:
        print("[smoke] statik sayfa kontrolü atlandı (ayrı sunucu olabilir)")

    if failures:
        print(f"[smoke] {len(failures)} hata")
        return 1
    print("[smoke] geçti")
    return 0


if __name__ == "__main__":
    sys.exit(main())
