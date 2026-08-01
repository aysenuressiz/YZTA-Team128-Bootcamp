"""Eskalasyon Ajanı — alerts DB + aile WebSocket (PR-3a) + seçici SMS (PR-3b)."""

from __future__ import annotations

from orchestrator.state import AgentState


def _try_insert_alert(elder_id: str | None, reason: str | None, message: str) -> None:
    if not elder_id:
        print("[ESCALATION] elder_id yok, alert atlandı.")
        return
    try:
        from database import supabase

        user_snip = (message or "").strip()
        if len(user_snip) > 160:
            user_snip = user_snip[:157] + "…"
        reason_text = (reason or "").strip() or "Riskli ifade algılandı"
        if user_snip and "Kullanıcı:" not in reason_text:
            description = f"{reason_text}\nKullanıcının söylediği: «{user_snip}»"
        else:
            description = reason_text or user_snip or "Kullanıcı endişe verici bir durum bildirdi."
        supabase.table("alerts").insert(
            {
                "elder_id": elder_id,
                "alert_type": "conversation_risk",
                "severity": "high",
                "description": description,
            }
        ).execute()
        print(f"[ESCALATION] Alert yazıldı: {elder_id}")
    except Exception as error:
        print(f"[ESCALATION] Alert yazılamadı: {error}")


def _notify_family(elder_id: str | None, reason: str, urgency: str, state: AgentState) -> None:
    try:
        from services.family_notify import notify_family

        # SMS seçici barajı _maybe_sms içinde; burada WS (+ isteğe bağlı stub kapalı)
        notify_family(
            elder_id=elder_id,
            description=reason,
            alert_type="conversation_risk",
            severity="high" if (urgency or "").lower() == "high" else "medium",
            user_id=state.get("user_id"),
            user_name=state.get("user_name"),
            send_sms=False,
        )
    except Exception as error:
        print(f"[ESCALATION] Aile bildirimi atlandı: {error}")
        try:
            from routers.websocket import notify_family_critical

            notify_family_critical(
                elder_id,
                description=reason,
                severity="high",
                alert_type="conversation_risk",
                urgency=urgency,
            )
        except Exception as ws_err:
            print(f"[ESCALATION] Aile WS bildirimi atlandı: {ws_err}")


def _maybe_sms(state: AgentState) -> dict:
    try:
        from services.sms_service import maybe_notify_family_sms

        result = maybe_notify_family_sms(dict(state))
        print(f"[ESCALATION] SMS sonucu: {result}")
        return result
    except Exception as error:
        print(f"[ESCALATION] SMS atlandı: {error}")
        return {"attempted": False, "sent": False, "reason": f"error:{error}"}


def escalation_node(state: AgentState) -> AgentState:
    user_name = state.get("user_name") or "canım"
    reply = (
        f"{user_name}, seni duyuyorum. Güvendesin. "
        "Yakınlarını bu durum hakkında bilgilendiriyorum. "
        "Mümkünse telefonunun yanında kal; onlar seninle iletişime geçecek."
    )

    reason = state.get("escalation_reason") or "Kullanıcı riskli bir durum bildirdi."
    urgency = state.get("urgency") or "high"
    elder_id = state.get("elder_id")

    _try_insert_alert(elder_id, reason, state.get("user_message", ""))
    _notify_family(elder_id, reason, urgency, state)
    sms_result = _maybe_sms(state)

    return {
        **state,
        "agent_response": reply,
        "routed_agent": "escalation",
        "escalation_needed": True,
        "urgency": urgency,
        "escalation_reason": reason,
        "sms_result": sms_result,
    }
