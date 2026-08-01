"""Aile paneli: özet, aktivite, sohbet dökümü, haftalık özet, ruh hali.

Not: handler'lar sync `def` — Supabase I/O event loop'u kilitlemesin (threadpool).
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from database import supabase
from medication import service as medication_service
from services import activity_service, family_insights

router = APIRouter(tags=["Family Dashboard"])
LOCAL_TZ = ZoneInfo("Europe/Istanbul")


class SummaryRequestModel(BaseModel):
    conversation_id: str
    days: int = Field(default=7, ge=1, le=14)


class FamilySmsPrefsModel(BaseModel):
    user_id: str
    sms_enabled: bool
    family_phone: str | None = None


def _safe_checkin_latest(conversation_id: str) -> str:
    try:
        checkin_response = (
            supabase.table("checkins")
            .select("mood, created_at")
            .eq("conversation_id", conversation_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if checkin_response.data:
            return checkin_response.data[0].get("mood") or "Normal"
    except Exception as error:
        print(f"[DASH] checkin: {error}")
    return "Veri Yok"


def _safe_checkin_history(conversation_id: str, limit: int = 10) -> list:
    try:
        history_response = (
            supabase.table("checkins")
            .select("mood, created_at, conversation_id")
            .eq("conversation_id", conversation_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return history_response.data or []
    except Exception as error:
        print(f"[DASH] checkin history: {error}")
        return []


@router.get("/api/family/sms-prefs/{user_id}")
def get_family_sms_prefs(user_id: str):
    """Aile SMS tercihi (users.family_sms_enabled + family_phone)."""
    try:
        from services import auth_store

        row = auth_store.get_family_phone_for_user(user_id) or {}
        phone = (row.get("family_phone") or "").strip() or None
        sms_enabled = row.get("family_sms_enabled")
        if sms_enabled is None:
            sms_enabled = bool(phone)
        return {
            "success": True,
            "user_id": user_id,
            "sms_enabled": bool(sms_enabled),
            "family_phone": phone,
            "has_phone": bool(phone),
            "twilio_ready": _twilio_ready(),
            "sms_mode": _sms_mode(),
        }
    except Exception as error:
        print(f"[SMS-PREFS GET] {error}")
        return {
            "success": True,
            "user_id": user_id,
            "sms_enabled": False,
            "family_phone": None,
            "has_phone": False,
            "twilio_ready": _twilio_ready(),
            "partial": True,
        }


@router.patch("/api/family/sms-prefs")
def patch_family_sms_prefs(data: FamilySmsPrefsModel):
    """SMS tercihini sunucuya kaydet."""
    user_id = (data.user_id or "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id gerekli")

    payload: dict = {"family_sms_enabled": bool(data.sms_enabled)}
    if data.family_phone is not None:
        phone = str(data.family_phone).strip()
        payload["family_phone"] = phone or None

    try:
        res = (
            supabase.table("users")
            .update(payload)
            .eq("id", user_id)
            .execute()
        )
        if not res.data:
            # elder notes auth blob güncellemesi (eski kayıtlar)
            try:
                from services import auth_store

                ok = auth_store.set_family_sms_pref(
                    user_id,
                    sms_enabled=bool(data.sms_enabled),
                    family_phone=payload.get("family_phone"),
                )
                if not ok:
                    raise HTTPException(
                        status_code=404,
                        detail="Kullanıcı bulunamadı; SMS tercihi kaydedilemedi.",
                    )
            except HTTPException:
                raise
            except Exception as nested:
                print(f"[SMS-PREFS] auth_store fallback: {nested}")
                raise HTTPException(
                    status_code=404,
                    detail="Kullanıcı bulunamadı; SMS tercihi kaydedilemedi.",
                ) from nested

        return {
            "success": True,
            "user_id": user_id,
            "sms_enabled": bool(data.sms_enabled),
            "family_phone": payload.get("family_phone"),
            "twilio_ready": _twilio_ready(),
        }
    except HTTPException:
        raise
    except Exception as error:
        print(f"[SMS-PREFS PATCH] {error}")
        raise HTTPException(status_code=500, detail="SMS tercihi kaydedilemedi.") from error


def _twilio_ready() -> bool:
    from services.sms_service import twilio_ready

    return twilio_ready()


def _sms_mode() -> str:
    from services.sms_service import sms_delivery_mode

    return sms_delivery_mode()


class FamilySmsTestModel(BaseModel):
    user_id: str | None = None
    elder_id: str | None = None
    phone: str | None = None
    message: str | None = None


@router.post("/api/family/sms-test")
def post_family_sms_test(data: FamilySmsTestModel):
    """Gerçek/stub SMS denemesi — Twilio kurulumu doğrulama."""
    from services.sms_service import (
        resolve_family_contact,
        send_family_sms,
        sms_delivery_mode,
        to_e164,
    )

    mode = sms_delivery_mode()
    phone = (data.phone or "").strip() or None
    if not phone:
        contact = resolve_family_contact(user_id=data.user_id, elder_id=data.elder_id)
        phone = contact.get("phone")
        if contact.get("sms_enabled") is False:
            raise HTTPException(status_code=400, detail="SMS tercihi kapalı.")

    if not phone:
        raise HTTPException(
            status_code=400,
            detail="Telefon yok. users.family_phone veya istekte phone gerekli.",
        )

    body = (data.message or "Yanımda Al test SMS — sistem çalışıyor.").strip()
    result = send_family_sms(phone, body)
    return {
        "success": bool(result.get("sent")) if isinstance(result, dict) else bool(result),
        "mode": mode,
        "result": dict(result) if isinstance(result, dict) else {"sent": bool(result)},
        "e164": to_e164(phone),
        "hint": (
            "Gerçek SMS gitti."
            if mode == "twilio" and (result.get("sent") if isinstance(result, dict) else result)
            else (
                "Stub mod: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER "
                "ekleyin; FAMILY_SMS_ENABLED=true veya auto yapın."
                if mode == "stub"
                else "Twilio kimlik bilgileri eksik veya hatalı."
            )
        ),
    }


@router.get("/api/family/dashboard-summary/{conversation_id}")
def get_family_dashboard_summary(conversation_id: str):
    """Hızlı özet — her blok bağımsız; biri patlasa panel boş kalmaz."""
    latest_mood_raw = _safe_checkin_latest(conversation_id)
    mood_norm = family_insights.normalize_mood(latest_mood_raw)
    history = _safe_checkin_history(conversation_id, 10)

    elder_id = None
    elder = {}
    try:
        elder = medication_service.resolve_elder_for_user(conversation_id, "Yakınız") or {}
        elder_id = elder.get("id")
    except Exception as error:
        print(f"[DASH] elder resolve: {error}")

    med_stats: dict = {}
    medication_status = "Henüz kayıt yok"
    recent_alerts: list = []
    if elder_id:
        try:
            med_stats = medication_service.get_medication_stats(elder_id) or {}
            adherence = med_stats.get("adherence_rate", 0)
            total = med_stats.get("total_logs", 0)
            medication_status = f"%{adherence} uyum" if total > 0 else "Henüz kayıt yok"
        except Exception as error:
            print(f"[DASH] med stats: {error}")
            med_stats = {"weekly_trend": [], "total_logs": 0, "adherence_rate": 0}
        try:
            recent_alerts = medication_service.get_elder_alerts(
                elder_id, limit=8, open_only=True
            ) or []
            open_alert_count = medication_service.count_open_alerts(elder_id)
        except Exception as error:
            print(f"[DASH] alerts: {error}")
            open_alert_count = 0
    else:
        open_alert_count = 0

    activity = {
        "activity_status": "Henüz etkileşim yok",
        "score": 0,
        "event_counts": {},
        "event_total": 0,
        "last_event_at": None,
    }
    try:
        activity = activity_service.get_activity_summary(
            user_id=conversation_id,
            elder_id=elder_id,
            light=True,
        )
    except Exception as error:
        print(f"[DASH] activity: {error}")

    activity_status = family_insights.activity_empty_friendly(activity)
    status_line = f"{mood_norm['label']} · {medication_status} · {activity_status}"

    return {
        "success": True,
        "latest_mood": mood_norm["label"],
        "latest_mood_raw": latest_mood_raw,
        "mood": mood_norm,
        "status_line": status_line,
        "medication_status": medication_status,
        "medication_stats": med_stats,
        "recent_alerts": recent_alerts,
        "open_alert_count": open_alert_count,
        "activity_status": activity_status,
        "activity": activity,
        "history": history,
        "elder_id": elder_id,
    }


@router.get("/api/family/weekly-summary/{elderly_id}")
def get_family_weekly_summary(elderly_id: str):
    try:
        elder = medication_service.resolve_elder_for_user(elderly_id, "Yakınınız") or {}
        elder_id = elder.get("id")
        elder_name = elder.get("full_name") or "Yakınınız"
        try:
            user_resp = (
                supabase.table("users")
                .select("name")
                .eq("id", elderly_id)
                .limit(1)
                .execute()
            )
            if user_resp.data and user_resp.data[0].get("name"):
                elder_name = user_resp.data[0]["name"]
        except Exception:
            pass

        return family_insights.build_weekly_summary(
            user_id=elderly_id,
            elder_id=elder_id,
            elder_name=elder_name,
        )
    except Exception as error:
        print(f"[HATA] Haftalık özet: {error}")
        return {
            "success": True,
            "period_days": 7,
            "elder_id": None,
            "elder_name": "Yakınınız",
            "bullets": [
                "Haftalık özet şu an kısmen yüklenemedi.",
                "Bağlantı düzelince Yenile ile tekrar deneyin.",
            ],
            "mood": {"latest": family_insights.normalize_mood(None), "series": []},
            "medication": {"adherence_rate": 0, "total_logs": 0, "weekly_trend": []},
            "alerts": {"week_count": 0, "recent": []},
            "activity": {"week_label": "Veri yok", "score": 0},
            "partial": True,
            "error": str(error),
        }


@router.get("/api/family/mood-analysis/{elderly_id}")
def get_family_mood_analysis(elderly_id: str):
    try:
        elder = medication_service.resolve_elder_for_user(elderly_id, "Yakınınız") or {}
        elder_id = elder.get("id")
        elder_name = elder.get("full_name") or "Yakınınız"
        try:
            user_resp = (
                supabase.table("users")
                .select("name")
                .eq("id", elderly_id)
                .limit(1)
                .execute()
            )
            if user_resp.data and user_resp.data[0].get("name"):
                elder_name = user_resp.data[0]["name"]
        except Exception:
            pass

        return family_insights.build_mood_analysis(
            user_id=elderly_id,
            elder_id=elder_id,
            elder_name=elder_name,
            notify=True,
        )
    except Exception as error:
        print(f"[HATA] Ruh hali analizi: {error}")
        return {
            "success": True,
            "latest": family_insights.normalize_mood(None),
            "week_avg_score": None,
            "combined_score": None,
            "checkin_series": [],
            "chat_sentiment": {"score": 0, "label": "veri yok", "sample_count": 0, "highlights": []},
            "decline": {"triggered": False},
            "checkin_count": 0,
            "insight": "Ruh hali verisi şu an yüklenemedi. Yenile ile tekrar deneyin.",
            "partial": True,
        }


@router.post("/api/family/generate-ai-summary")
def generate_ai_summary_via_router(data: SummaryRequestModel):
    """Haftalık (varsayılan 7 gün) birleşik AI özeti."""
    try:
        import os

        from groq import Groq

        api_key = os.environ.get("GROQ_API_KEY")
        client = Groq(api_key=api_key) if api_key else None
        return family_insights.generate_period_ai_summary(
            conversation_id=data.conversation_id,
            days=data.days,
            groq_client=client,
        )
    except Exception as error:
        print(f"[AI ÖZET HATASI]: {error}")
        return {
            "success": True,
            "summary": (
                "Yapay zeka özeti şu an üretilemedi. "
                "İlaç, check-in ve uyarı kartlarından genel durumu takip edebilirsiniz."
            ),
            "period_days": data.days,
            "partial": True,
        }


@router.get("/api/family/risk-history/{elderly_id}")
def get_family_risk_history(
    elderly_id: str,
    days: int = Query(default=14, ge=1, le=60),
):
    try:
        elder = medication_service.resolve_elder_for_user(elderly_id, "Yakınınız") or {}
        elder_id = elder.get("id")
        from services.risk_scoring import get_risk_history

        return get_risk_history(
            elder_id=elder_id,
            user_id=elderly_id,
            days=days,
        )
    except Exception as error:
        print(f"[HATA] Risk geçmişi: {error}")
        return {
            "success": True,
            "period_days": days,
            "events": [],
            "alerts": [],
            "avg_score": None,
            "high_count": 0,
            "sample_count": 0,
            "partial": True,
        }


@router.get("/api/family/chat-transcript/{elderly_id}")
def get_family_chat_transcript(
    elderly_id: str,
    limit: int = Query(default=40, ge=1, le=100),
    today_only: bool = Query(default=True),
):
    """Yaşlıya ait sohbet mesajlarını aile paneli için döner."""
    try:
        elder = medication_service.resolve_elder_for_user(elderly_id, "Yakınız") or {}
        elder_id = elder.get("id")
        if not elder_id:
            return {"success": True, "messages": [], "elder_id": None, "risk_flag_count": 0}

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
            return {"success": True, "messages": [], "elder_id": elder_id, "risk_flag_count": 0}

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
        messages.reverse()

        from services.risk_scoring import annotate_messages

        annotated = annotate_messages(messages)
        risk_flags = sum(1 for m in annotated if m.get("is_risk"))

        return {
            "success": True,
            "elder_id": elder_id,
            "today_only": today_only,
            "messages": annotated,
            "risk_flag_count": risk_flags,
        }
    except Exception as error:
        print(f"[HATA] Sohbet dökümü alınamadı: {error}")
        return {
            "success": True,
            "messages": [],
            "elder_id": None,
            "risk_flag_count": 0,
            "partial": True,
            "error": str(error),
        }
