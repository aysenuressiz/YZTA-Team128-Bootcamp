"""Konuşma risk skoru (0–100) + geçmiş + sohbet anotasyonu."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from database import supabase
from orchestrator.router import is_medication_identity_question, rule_based_intent
from services.family_insights import score_text_sentiment

LOCAL_TZ = ZoneInfo("Europe/Istanbul")

URGENCY_SCORE = {"low": 25, "medium": 55, "high": 85}


def score_message_risk(
    message: str,
    *,
    intent: str | None = None,
    urgency: str | None = None,
    escalated: bool = False,
) -> dict[str, Any]:
    """Tek mesaj için risk skoru. Intent verilmezse kural tabanlı tahmin."""
    text = (message or "").strip()
    sentiment = score_text_sentiment(text)
    ruled = rule_based_intent(text)

    # "Bu ne ilacı?" gibi sorular sağlık riski sayılmasın
    if is_medication_identity_question(text) and not escalated:
        return {
            "score": 12,
            "level": "low",
            "intent": "companion",
            "urgency": "low",
            "sentiment": sentiment["label"],
            "sentiment_risk": bool(sentiment.get("risk")),
            "ruled": None,
            "flagged": False,
        }

    resolved_intent = (intent or ruled or "companion").lower()
    if escalated:
        resolved_intent = "escalation"
    if resolved_intent == "health" and is_medication_identity_question(text):
        resolved_intent = "companion"

    base = 15
    if resolved_intent == "escalation":
        base = 78
    elif resolved_intent == "health":
        base = 48
    elif ruled == "health":
        base = 45

    # Duygu / risk kelimeleri
    base += int(max(-20, min(25, -sentiment["score"] * 30)))
    if sentiment.get("risk"):
        if resolved_intent == "escalation" or ruled == "escalation":
            base = max(base, 78)
        else:
            base = max(base, min(base + 15, 62))

    urg = (urgency or ("high" if resolved_intent == "escalation" else "low")).lower()
    if urg in URGENCY_SCORE and resolved_intent == "escalation":
        base = max(base, URGENCY_SCORE[urg])

    score = int(max(0, min(100, base)))
    if score >= 70:
        level = "high"
    elif score >= 45:
        level = "medium"
    else:
        level = "low"

    return {
        "score": score,
        "level": level,
        "intent": resolved_intent,
        "urgency": urg,
        "sentiment": sentiment["label"],
        "sentiment_risk": bool(sentiment.get("risk")),
        "ruled": ruled,
        "flagged": score >= 70 or resolved_intent == "escalation",
    }


def persist_risk_event(
    *,
    elder_id: str | None,
    user_id: str | None,
    message: str,
    risk: dict[str, Any],
    conversation_id: str | None = None,
    reason: str | None = None,
) -> None:
    """activity_events üzerine risk_score yazar (şema değişikliği yok)."""
    if not elder_id and not user_id:
        return
    if not risk.get("flagged") and int(risk.get("score") or 0) < 55:
        return
    try:
        from services import activity_service

        activity_service.log_activity_event(
            event_type="risk_score",
            user_id=user_id,
            elder_id=elder_id,
            source="orchestrator",
            meta={
                "score": risk.get("score"),
                "level": risk.get("level"),
                "intent": risk.get("intent"),
                "urgency": risk.get("urgency"),
                "reason": reason,
                "conversation_id": conversation_id,
                "preview": (message or "")[:160],
            },
        )
    except Exception as error:
        print(f"[RISK] persist atlandı: {error}")


def annotate_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sohbet dökümü satırlarına risk alanları ekler."""
    out: list[dict[str, Any]] = []
    for msg in messages:
        row = dict(msg)
        role = (row.get("role") or "").lower()
        if role == "user":
            risk = score_message_risk(row.get("content") or "")
            row["risk"] = risk
            row["is_risk"] = bool(risk.get("flagged"))
        else:
            row["risk"] = None
            row["is_risk"] = False
        out.append(row)
    return out


def get_risk_history(
    *,
    elder_id: str | None,
    user_id: str | None = None,
    days: int = 14,
    limit: int = 40,
) -> dict[str, Any]:
    since = (datetime.now(LOCAL_TZ) - timedelta(days=max(days - 1, 0))).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).isoformat()

    events: list[dict[str, Any]] = []
    try:
        if elder_id:
            res = (
                supabase.table("activity_events")
                .select("event_type, meta, created_at, elder_id, user_id")
                .eq("elder_id", elder_id)
                .eq("event_type", "risk_score")
                .gte("created_at", since)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            events.extend(res.data or [])
        if user_id:
            res = (
                supabase.table("activity_events")
                .select("event_type, meta, created_at, elder_id, user_id")
                .eq("user_id", user_id)
                .eq("event_type", "risk_score")
                .gte("created_at", since)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            seen = {(e.get("created_at"), str(e.get("meta"))) for e in events}
            for row in res.data or []:
                key = (row.get("created_at"), str(row.get("meta")))
                if key not in seen:
                    events.append(row)
                    seen.add(key)
    except Exception as error:
        print(f"[RISK] history okuma: {error}")

    # Alert tabanlı yedek (conversation_risk)
    alerts: list[dict] = []
    try:
        if elder_id:
            res = (
                supabase.table("alerts")
                .select("alert_type, severity, description, created_at")
                .eq("elder_id", elder_id)
                .eq("alert_type", "conversation_risk")
                .gte("created_at", since)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            alerts = res.data or []
    except Exception as error:
        print(f"[RISK] alerts okuma: {error}")

    events.sort(key=lambda e: str(e.get("created_at") or ""), reverse=True)
    events = events[:limit]

    scores = []
    for ev in events:
        meta = ev.get("meta") or {}
        if isinstance(meta, dict) and meta.get("score") is not None:
            try:
                scores.append(int(meta["score"]))
            except (TypeError, ValueError):
                pass

    avg = round(sum(scores) / len(scores), 1) if scores else None
    high_count = sum(1 for s in scores if s >= 70) + len(alerts)

    return {
        "success": True,
        "period_days": days,
        "events": events,
        "alerts": alerts,
        "avg_score": avg,
        "high_count": high_count,
        "sample_count": len(scores),
    }
