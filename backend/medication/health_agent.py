"""
Sağlık Ajanı — ilaç tanıma sonucunu planlanan ilaçla eşleştirir,
log kaydı oluşturur ve gerekirse Eskalasyon Ajanına sinyal gönderir.
"""
from datetime import datetime
from typing import Any

from database import supabase

from medication import service as medication_service

STATUS_TAKEN = "taken"
STATUS_MISSED = "missed"
STATUS_WRONG = "wrong_medication"
STATUS_SNOOZED = "snoozed"


def evaluate_recognition(
    medication_id: str,
    schedule_id: str | None,
    recognized_name: str,
    expected_name: str,
    is_match: bool | None,
) -> dict[str, Any]:
    """Vision sonucunu değerlendirir; doğru ilaçsa taken, değilse wrong_medication."""
    if is_match is False:
        log = medication_service.create_medication_log(
            medication_id=medication_id,
            schedule_id=schedule_id,
            status=STATUS_WRONG,
            confirmation_method="camera",
        )
        _create_escalation_alert(
            medication_id=medication_id,
            alert_type="wrong_medication",
            severity="high",
            description=(
                f"Yanlış ilaç tespit edildi. Beklenen: '{expected_name}', "
                f"tanınan: '{recognized_name}'."
            ),
        )
        recognized = (recognized_name or "bilinmeyen ilaç").strip() or "bilinmeyen ilaç"
        expected = (expected_name or "beklenen ilaç").strip()
        return {
            "decision": STATUS_WRONG,
            "message": (
                f"Yanlış ilaç. Beklenen: {expected}. "
                f"Kamerada görünen: {recognized}. "
                f"Lütfen {expected} kutusunu gösterin; emin değilseniz bir yakınınıza danışın."
            ),
            "log": log,
        }

    log = medication_service.create_medication_log(
        medication_id=medication_id,
        schedule_id=schedule_id,
        status=STATUS_TAKEN,
        confirmation_method="camera",
    )
    return {
        "decision": STATUS_TAKEN,
        "message": f"Harika, doğru ilaç: {recognized_name}. İçebilirsiniz.",
        "log": log,
    }


def record_manual_taken(
    medication_id: str,
    schedule_id: str | None,
    confirmation_method: str = "button",
) -> dict[str, Any]:
    if medication_service.has_schedule_been_resolved_today(medication_id, schedule_id):
        return {
            "decision": "skipped",
            "message": "Bu doz bugün zaten kaydedilmiş.",
            "log": None,
        }

    log = medication_service.create_medication_log(
        medication_id=medication_id,
        schedule_id=schedule_id,
        status=STATUS_TAKEN,
        confirmation_method=confirmation_method,
    )
    return {"decision": STATUS_TAKEN, "message": "İlaç alındı olarak kaydedildi.", "log": log}


def record_snooze(medication_id: str, schedule_id: str | None) -> dict[str, Any]:
    """Erteleme — 3. ertelemeden sonra missed + aile bildirimi."""
    prior = medication_service.count_today_snoozes(medication_id, schedule_id)
    log = medication_service.create_medication_log(
        medication_id=medication_id,
        schedule_id=schedule_id,
        status=STATUS_SNOOZED,
        confirmation_method="snooze",
    )
    snooze_count = prior + 1
    if snooze_count >= 3:
        missed = record_missed(medication_id, schedule_id, reason="max_snooze")
        return {
            "decision": STATUS_MISSED,
            "message": "3 erteleme sonrası ilaç içilmedi olarak kaydedildi. Aile bilgilendirildi.",
            "log": missed.get("log") or log,
            "snooze_count": snooze_count,
            "max_snoozes": 3,
        }
    return {
        "decision": STATUS_SNOOZED,
        "message": "Hatırlatma 10 dakika ertelendi.",
        "log": log,
        "snooze_count": snooze_count,
        "max_snoozes": 3,
    }


def record_missed(medication_id: str, schedule_id: str | None, reason: str = "timeout") -> dict[str, Any]:
    if medication_service.has_schedule_been_resolved_today(medication_id, schedule_id):
        return {"decision": "skipped", "message": "Bu doz zaten kayıtlı.", "log": None}

    log = medication_service.create_medication_log(
        medication_id=medication_id,
        schedule_id=schedule_id,
        status=STATUS_MISSED,
        confirmation_method=reason,
    )
    medication = medication_service.get_medication(medication_id) or {}
    med_name = medication.get("name", "İlaç")
    elder_id = medication.get("elder_id")
    _create_escalation_alert(
        medication_id=medication_id,
        elder_id=elder_id,
        alert_type="medication_missed",
        severity="high",
        description=f"Yaşlı birey '{med_name}' ilacını almadı.",
    )
    return {"decision": STATUS_MISSED, "message": "İlaç kaçırıldı olarak işaretlendi.", "log": log}


def _create_escalation_alert(
    medication_id: str,
    alert_type: str,
    severity: str,
    description: str,
    elder_id: str | None = None,
) -> None:
    if not elder_id:
        medication = medication_service.get_medication(medication_id) or {}
        elder_id = medication.get("elder_id")
    if not elder_id:
        return

    try:
        supabase.table("alerts").insert(
            {
                "elder_id": elder_id,
                "alert_type": alert_type,
                "severity": severity,
                "description": description,
            }
        ).execute()
    except Exception as error:
        print(f"[ESKALASYON] Alert kaydı başarısız: {error}")

    if severity in {"high", "medium", "critical"}:
        try:
            from services.family_notify import notify_family

            notify_family(
                elder_id=elder_id,
                description=description,
                alert_type=alert_type,
                severity=severity,
                send_sms=severity in {"high", "critical"},
            )
        except Exception as error:
            print(f"[ESKALASYON] Aile bildirimi atlandı: {error}")
            try:
                from routers.websocket import notify_family_critical

                notify_family_critical(
                    elder_id,
                    description=description,
                    severity=severity,
                    alert_type=alert_type,
                    urgency="high",
                )
            except Exception as ws_err:
                print(f"[ESKALASYON] Aile WS bildirimi atlandı: {ws_err}")
