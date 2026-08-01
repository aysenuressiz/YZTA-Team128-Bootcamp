"""Aileye kritik bildirim: WebSocket + SMS (Twilio veya stub)."""

from __future__ import annotations

from typing import Any


def notify_family(
    *,
    elder_id: str | None,
    description: str,
    alert_type: str = "conversation_risk",
    severity: str = "high",
    user_id: str | None = None,
    user_name: str | None = None,
    send_sms: bool = True,
) -> dict[str, Any]:
    """
    Kritik olayda:
    1) Aile paneline WebSocket CRITICAL_HEALTH_EVENT
    2) (opsiyonel) SMS — Twilio hazırsa gerçek, değilse stub log
    """
    result: dict[str, Any] = {
        "ws": False,
        "sms": {"attempted": False, "sent": False},
        "elder_id": elder_id,
        "alert_type": alert_type,
    }
    if not elder_id:
        result["error"] = "no_elder_id"
        return result

    try:
        from routers.websocket import notify_family_critical

        notify_family_critical(
            elder_id,
            description=description,
            severity=severity,
            alert_type=alert_type,
            urgency=severity,
        )
        result["ws"] = True
    except Exception as error:
        print(f"[FAMILY-NOTIFY] WS hatası: {error}")
        result["ws_error"] = str(error)

    if send_sms and severity in {"high", "critical", "medium"}:
        try:
            from services.sms_service import (
                resolve_family_contact,
                send_family_sms,
                sms_delivery_mode,
            )

            contact = resolve_family_contact(user_id=user_id, elder_id=elder_id)
            phone = contact.get("phone")
            if not phone:
                result["sms"] = {
                    "attempted": True,
                    "sent": False,
                    "reason": "no_family_phone",
                    "mode": sms_delivery_mode(),
                }
            elif contact.get("sms_enabled") is False:
                result["sms"] = {
                    "attempted": True,
                    "sent": False,
                    "reason": "family_sms_disabled",
                    "mode": sms_delivery_mode(),
                }
            else:
                name = user_name or contact.get("family_name") or "Yakınınız"
                body = f"Yanımda Al UYARI ({alert_type}): {name} — {description}"
                sent = send_family_sms(phone, body[:320])
                if isinstance(sent, dict):
                    result["sms"] = {
                        "attempted": True,
                        "sent": bool(sent.get("sent")),
                        "mode": sent.get("mode"),
                        "reason": sent.get("reason"),
                        "to": sent.get("to"),
                        "sid": sent.get("sid"),
                        "stub": sent.get("mode") == "stub",
                    }
                else:
                    result["sms"] = {
                        "attempted": True,
                        "sent": bool(sent),
                        "stub": True,
                    }
        except Exception as error:
            print(f"[FAMILY-NOTIFY] SMS hatası: {error}")
            result["sms"] = {"attempted": True, "sent": False, "reason": str(error)}

    print(f"[FAMILY-NOTIFY] result={result}")
    return result
