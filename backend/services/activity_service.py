"""Aktivite olayları — kiosk etkileşimleri + aile paneli özeti."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from database import supabase

LOCAL_TZ = ZoneInfo("Europe/Istanbul")

# Skor ağırlıkları
WEIGHTS = {
    "heartbeat": 1,
    "page_view": 1,
    "chat": 3,
    "voice": 3,
    "checkin": 4,
    "medication": 4,
}


def _today_start_iso() -> str:
    now = datetime.now(LOCAL_TZ)
    return now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def log_activity_event(
    *,
    event_type: str,
    user_id: str | None = None,
    elder_id: str | None = None,
    source: str = "kiosk",
    meta: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    event_type = (event_type or "").strip().lower()
    if not event_type:
        return None
    if not user_id and not elder_id:
        return None

    payload = {
        "event_type": event_type,
        "source": source or "kiosk",
        "meta": meta or {},
        "created_at": datetime.utcnow().isoformat(),
    }
    if user_id:
        payload["user_id"] = user_id
    if elder_id:
        payload["elder_id"] = elder_id

    try:
        row = supabase.table("activity_events").insert(payload).execute()
        return (row.data or [None])[0]
    except Exception as error:
        print(f"[ACTIVITY] Yazılamadı: {error}")
        return None


def _count_events_today(user_id: str | None, elder_id: str | None) -> list[dict[str, Any]]:
    today = _today_start_iso()
    events: list[dict[str, Any]] = []

    try:
        if user_id:
            res = (
                supabase.table("activity_events")
                .select("event_type, created_at")
                .eq("user_id", user_id)
                .gte("created_at", today)
                .execute()
            )
            events.extend(res.data or [])
        if elder_id:
            res = (
                supabase.table("activity_events")
                .select("event_type, created_at")
                .eq("elder_id", elder_id)
                .gte("created_at", today)
                .execute()
            )
            # aynı satır iki kez gelmesin diye id yoksa type+time ile kaba tekilleştir
            seen = {(e.get("event_type"), e.get("created_at")) for e in events}
            for row in res.data or []:
                key = (row.get("event_type"), row.get("created_at"))
                if key not in seen:
                    events.append(row)
                    seen.add(key)
    except Exception as error:
        print(f"[ACTIVITY] Okuma hatası: {error}")

    return events


def _proxy_signals(user_id: str | None, elder_id: str | None) -> dict[str, int]:
    """activity_events boşsa bile mevcut tablolardan bugünkü sinyal say."""
    today = _today_start_iso()
    signals = {"chat": 0, "checkin": 0, "medication": 0}

    try:
        if elder_id:
            convs = (
                supabase.table("conversations")
                .select("id")
                .eq("elder_id", elder_id)
                .execute()
            )
            conv_ids = [c["id"] for c in (convs.data or [])]
            if conv_ids:
                # PostgREST in_ filter — çok uzun listelerde sınırlı tut
                for chunk_start in range(0, len(conv_ids), 20):
                    chunk = conv_ids[chunk_start : chunk_start + 20]
                    msg = (
                        supabase.table("messages")
                        .select("id", count="exact")
                        .in_("conversation_id", chunk)
                        .eq("role", "user")
                        .gte("created_at", today)
                        .execute()
                    )
                    signals["chat"] += msg.count or len(msg.data or [])

                for chunk_start in range(0, len(conv_ids), 20):
                    chunk = conv_ids[chunk_start : chunk_start + 20]
                    chk = (
                        supabase.table("checkins")
                        .select("id", count="exact")
                        .in_("conversation_id", chunk)
                        .gte("created_at", today)
                        .execute()
                    )
                    signals["checkin"] += chk.count or len(chk.data or [])

        if user_id:
            chk_user = (
                supabase.table("checkins")
                .select("id", count="exact")
                .eq("conversation_id", user_id)
                .gte("created_at", today)
                .execute()
            )
            if (chk_user.count or len(chk_user.data or [])) > 0 and signals["checkin"] == 0:
                signals["checkin"] = chk_user.count or len(chk_user.data or [])

        if elder_id:
            meds = (
                supabase.table("medications")
                .select("id")
                .eq("elder_id", elder_id)
                .execute()
            )
            med_ids = [m["id"] for m in (meds.data or [])]
            if med_ids:
                logs = (
                    supabase.table("medication_logs")
                    .select("id", count="exact")
                    .in_("medication_id", med_ids)
                    .in_("status", ["taken", "missed", "wrong_medication", "snoozed"])
                    .gte("scheduled_at", today)
                    .execute()
                )
                signals["medication"] = logs.count or len(logs.data or [])
    except Exception as error:
        print(f"[ACTIVITY] Proxy sinyal hatası: {error}")

    return signals


def score_to_label(score: int) -> str:
    """Kiosk etkileşim yoğunluğu — fiziksel hareket / ruh hali değil."""
    if score <= 0:
        return "Bugün kiosk etkileşimi yok"
    if score < 4:
        return "Az etkileşim"
    if score < 10:
        return "Orta etkileşim"
    return "Yoğun etkileşim"


def get_activity_summary(
    user_id: str | None = None,
    elder_id: str | None = None,
    light: bool = False,
) -> dict[str, Any]:
    events = _count_events_today(user_id, elder_id)
    by_type: dict[str, int] = {}
    for event in events:
        key = (event.get("event_type") or "other").lower()
        by_type[key] = by_type.get(key, 0) + 1

    score = sum(WEIGHTS.get(t, 1) * n for t, n in by_type.items())

    # Ağır proxy sorguları — aile paneli özetinde atla (light=True)
    if score == 0 and not light:
        proxies = _proxy_signals(user_id, elder_id)
        score = (
            proxies["chat"] * WEIGHTS["chat"]
            + proxies["checkin"] * WEIGHTS["checkin"]
            + proxies["medication"] * WEIGHTS["medication"]
        )
        by_type = {k: v for k, v in proxies.items() if v > 0}

    last_at = None
    if events:
        last_at = max((e.get("created_at") or "") for e in events)

    return {
        "activity_status": score_to_label(score),
        "score": score,
        "event_counts": by_type,
        "event_total": sum(by_type.values()),
        "last_event_at": last_at,
    }
