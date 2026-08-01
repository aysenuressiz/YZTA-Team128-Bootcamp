"""Aile paneli: özet, aktivite, sohbet dökümü."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query

from database import supabase
from medication import service as medication_service
from services import activity_service

router = APIRouter(tags=["Family Dashboard"])
LOCAL_TZ = ZoneInfo("Europe/Istanbul")


@router.get("/api/family/dashboard-summary/{conversation_id}")
async def get_family_dashboard_summary(conversation_id: str):
    try:
        checkin_response = (
            supabase.table("checkins")
            .select("*")
            .eq("conversation_id", conversation_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )

        latest_mood = "Veri Yok"
        if checkin_response.data:
            latest_mood = checkin_response.data[0].get("mood", "Normal")

        history_response = (
            supabase.table("checkins")
            .select("*")
            .eq("conversation_id", conversation_id)
            .order("created_at", desc=True)
            .limit(10)
            .execute()
        )

        elder = medication_service.resolve_elder_for_user(conversation_id, "Yakınız")
        elder_id = elder.get("id")
        med_stats = medication_service.get_medication_stats(elder_id) if elder_id else {}
        adherence = med_stats.get("adherence_rate", 0)
        total = med_stats.get("total_logs", 0)

        medication_status = f"%{adherence} Uyum" if total > 0 else "Henüz kayıt yok"
        recent_alerts = medication_service.get_elder_alerts(elder_id, limit=5) if elder_id else []

        activity = activity_service.get_activity_summary(
            user_id=conversation_id,
            elder_id=elder_id,
        )

        return {
            "success": True,
            "latest_mood": latest_mood,
            "medication_status": medication_status,
            "medication_stats": med_stats,
            "recent_alerts": recent_alerts,
            "activity_status": activity.get("activity_status", "Bugün aktivite yok"),
            "activity": activity,
            "history": history_response.data,
        }
    except Exception as error:
        print(f"[HATA] Dashboard verileri çekilemedi: {error}")
        raise HTTPException(status_code=500, detail="Dashboard verileri yüklenemedi.") from error


@router.get("/api/family/chat-transcript/{elderly_id}")
async def get_family_chat_transcript(
    elderly_id: str,
    limit: int = Query(default=40, ge=1, le=100),
    today_only: bool = Query(default=True),
):
    """Yaşlıya ait sohbet mesajlarını aile paneli için döner."""
    try:
        elder = medication_service.resolve_elder_for_user(elderly_id, "Yakınız")
        elder_id = elder.get("id")
        if not elder_id:
            return {"success": True, "messages": [], "elder_id": None}

        convs = (
            supabase.table("conversations")
            .select("id, started_at")
            .eq("elder_id", elder_id)
            .order("started_at", desc=True)
            .limit(30)
            .execute()
        )
        conv_ids = [c["id"] for c in (convs.data or [])]
        if not conv_ids:
            return {"success": True, "messages": [], "elder_id": elder_id}

        today_start = None
        if today_only:
            now = datetime.now(LOCAL_TZ)
            today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

        messages: list[dict] = []
        for chunk_start in range(0, len(conv_ids), 15):
            chunk = conv_ids[chunk_start : chunk_start + 15]
            query = (
                supabase.table("messages")
                .select("role, content, created_at, conversation_id")
                .in_("conversation_id", chunk)
                .order("created_at", desc=True)
                .limit(limit)
            )
            if today_start:
                query = query.gte("created_at", today_start)
            res = query.execute()
            messages.extend(res.data or [])

        messages.sort(key=lambda m: str(m.get("created_at") or ""), reverse=True)
        messages = messages[:limit]
        # Aileye kronolojik okuma: eskiden yeniye
        messages.reverse()

        return {
            "success": True,
            "elder_id": elder_id,
            "today_only": today_only,
            "messages": messages,
        }
    except Exception as error:
        print(f"[HATA] Sohbet dökümü alınamadı: {error}")
        raise HTTPException(status_code=500, detail="Sohbet dökümü yüklenemedi.") from error
