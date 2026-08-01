"""Aile paneli: mood normalizasyonu, sohbet NLP skoru, haftalık özet, anomali uyarısı."""

from __future__ import annotations

import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from database import supabase

LOCAL_TZ = ZoneInfo("Europe/Istanbul")

# Anomali dedupe (process lifetime + DB alert type)
_sent_mood_alerts: set[str] = set()

MOOD_LABELS = {
    "great": {"label": "Harika", "score": 3, "tone": "good"},
    "good": {"label": "İyi", "score": 2.5, "tone": "good"},
    "okay": {"label": "Normal", "score": 2, "tone": "neutral"},
    "tired": {"label": "Halsiz / yorgun", "score": 1, "tone": "bad"},
    "bad": {"label": "Kötü", "score": 0.5, "tone": "bad"},
    "unknown": {"label": "Veri yok", "score": None, "tone": "unknown"},
}

POSITIVE_WORDS = (
    "iyi", "harika", "guzel", "mutlu", "keyif", "saglikli", "rahat",
    "tesekkur", "sevindim", "enerjik", "neşeli", "neseli", "süper", "super",
)
NEGATIVE_WORDS = (
    "kotu", "kötü", "halsiz", "yorgun", "agrı", "agri", "acı", "aci",
    "uzgun", "üzgün", "sikinti", "sıkıntı", "dusme", "düştüm", "nefessiz",
    "korku", "yalniz", "yalnız", "hasta", "basim", "başım", "midem",
    "uyuyamıyorum", "uyuyamiyorum", "bunaldim", "bunaldım",
)
RISK_WORDS = (
    "dustum", "düştüm", "dusme", "düşme", "ambulans", "acil", "nefes",
    "gogus", "göğüs", "bayildim", "bayıldım", "kanama", "imdat",
    "olmek", "ölmek", "intihar", "kendimi oldur", "kendime zarar",
    "yasamak istemiyorum", "yaşamak istemiyorum", "dayanamıyorum",
)


def _fold(text: str) -> str:
    raw = unicodedata.normalize("NFD", str(text or "").lower())
    return "".join(ch for ch in raw if unicodedata.category(ch) != "Mn")


def normalize_mood(raw: str | None) -> dict[str, Any]:
    """Serbest mood metnini standart etikete çevirir."""
    if raw is None or not str(raw).strip() or str(raw).strip().lower() in {
        "veri yok", "yok", "n/a", "-",
    }:
        meta = MOOD_LABELS["unknown"]
        return {"key": "unknown", "raw": raw or "", **meta}

    low = _fold(raw)
    if any(k in low for k in ("harika", "cok iyi", "çok iyi", "super", "müthiş", "muthis")):
        key = "great"
    elif any(k in low for k in ("iyi", "good", "guzel", "keyif")) and not any(
        k in low for k in ("degil", "değil", "halsiz", "kotu")
    ):
        key = "good"
    elif any(k in low for k in ("halsiz", "yorgun", "tired", "bitkin")):
        key = "tired"
    elif any(k in low for k in ("kotu", "kötü", "bad", "berbat", "rahatsiz", "rahatsız")):
        key = "bad"
    elif any(k in low for k in ("normal", "idare", "orta", "fena degil", "fena değil", "okay")):
        key = "okay"
    else:
        key = "okay"

    meta = MOOD_LABELS[key]
    return {"key": key, "raw": str(raw).strip(), **meta}


def score_text_sentiment(text: str) -> dict[str, Any]:
    """Kural tabanlı TR duygu skoru (−1 … +1) + risk bayrağı."""
    low = _fold(text)
    if not low.strip():
        return {"score": 0.0, "label": "nötr", "risk": False, "hits": {"pos": 0, "neg": 0}}

    pos = sum(1 for w in POSITIVE_WORDS if w in low)
    neg = sum(1 for w in NEGATIVE_WORDS if w in low)
    risk = any(w in low for w in RISK_WORDS)

    raw = (pos - neg) / max(pos + neg, 1)
    if risk:
        raw = min(raw, -0.4)

    if raw >= 0.35:
        label = "olumlu"
    elif raw <= -0.35:
        label = "olumsuz"
    else:
        label = "nötr"

    return {
        "score": round(raw, 3),
        "label": label,
        "risk": risk,
        "hits": {"pos": pos, "neg": neg},
    }


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=LOCAL_TZ)
        return dt.astimezone(LOCAL_TZ)
    except Exception:
        return None


def _days_ago_iso(days: int) -> str:
    now = datetime.now(LOCAL_TZ)
    start = (now - timedelta(days=max(days - 1, 0))).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return start.isoformat()


def _fetch_checkins(user_id: str | None, elder_id: str | None, days: int = 14) -> list[dict]:
    since = _days_ago_iso(days)
    rows: list[dict] = []
    try:
        if user_id:
            res = (
                supabase.table("checkins")
                .select("mood, created_at, conversation_id")
                .eq("conversation_id", user_id)
                .gte("created_at", since)
                .order("created_at", desc=True)
                .limit(80)
                .execute()
            )
            rows.extend(res.data or [])
        if elder_id and elder_id != user_id:
            res = (
                supabase.table("checkins")
                .select("mood, created_at, conversation_id")
                .eq("conversation_id", elder_id)
                .gte("created_at", since)
                .order("created_at", desc=True)
                .limit(80)
                .execute()
            )
            seen = {(r.get("created_at"), r.get("mood")) for r in rows}
            for row in res.data or []:
                key = (row.get("created_at"), row.get("mood"))
                if key not in seen:
                    rows.append(row)
                    seen.add(key)
    except Exception as error:
        print(f"[INSIGHTS] checkin okuma: {error}")
    return rows


def _fetch_user_messages(
    user_id: str | None,
    elder_id: str | None,
    *,
    days: int = 7,
    limit: int = 60,
) -> list[dict]:
    since = _days_ago_iso(days)
    rows: list[dict] = []

    try:
        if user_id:
            res = (
                supabase.table("messages")
                .select("role, content, created_at")
                .eq("user_id", user_id)
                .eq("role", "user")
                .gte("created_at", since)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            rows.extend(res.data or [])
    except Exception as error:
        print(f"[INSIGHTS] messages.user_id: {error}")

    if len(rows) >= 5 or not elder_id:
        return rows[:limit]

    try:
        convs = (
            supabase.table("conversations")
            .select("id")
            .eq("elder_id", elder_id)
            .order("started_at", desc=True)
            .limit(25)
            .execute()
        )
        conv_ids = [c["id"] for c in (convs.data or [])]
        for i in range(0, len(conv_ids), 15):
            chunk = conv_ids[i : i + 15]
            res = (
                supabase.table("messages")
                .select("role, content, created_at")
                .in_("conversation_id", chunk)
                .eq("role", "user")
                .gte("created_at", since)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            rows.extend(res.data or [])
        rows.sort(key=lambda m: str(m.get("created_at") or ""), reverse=True)
    except Exception as error:
        print(f"[INSIGHTS] messages.elder: {error}")

    return rows[:limit]


def _daily_mood_series(checkins: list[dict], days: int = 7) -> list[dict[str, Any]]:
    by_day: dict[str, list[float]] = defaultdict(list)
    for row in checkins:
        dt = _parse_dt(row.get("created_at"))
        if not dt:
            continue
        norm = normalize_mood(row.get("mood"))
        if norm["score"] is None:
            continue
        day = dt.strftime("%Y-%m-%d")
        by_day[day].append(float(norm["score"]))

    now = datetime.now(LOCAL_TZ).date()
    series = []
    for i in range(days - 1, -1, -1):
        day = (now - timedelta(days=i)).strftime("%Y-%m-%d")
        scores = by_day.get(day) or []
        avg = round(sum(scores) / len(scores), 2) if scores else None
        if avg is None:
            key = "unknown"
        elif avg >= 2.5:
            key = "great"
        elif avg >= 2.0:
            key = "good"
        elif avg >= 1.5:
            key = "okay"
        elif avg >= 1.0:
            key = "tired"
        else:
            key = "bad"
        meta = MOOD_LABELS[key]
        series.append({
            "date": day,
            "avg_score": avg,
            "count": len(scores),
            "key": key,
            "label": meta["label"] if avg is not None else "Kayıt yok",
            "tone": meta["tone"] if avg is not None else "unknown",
        })
    return series


def detect_mood_decline(series: list[dict[str, Any]], streak: int = 3) -> dict[str, Any]:
    """Son N günde sürekli düşük mood (score < 1.5)."""
    recent = [d for d in series if d.get("avg_score") is not None][-streak:]
    if len(recent) < streak:
        return {"triggered": False, "streak": 0, "days": []}

    bad = [d for d in recent if float(d["avg_score"]) < 1.5]
    if len(bad) < streak:
        return {"triggered": False, "streak": len(bad), "days": bad}

    return {
        "triggered": True,
        "streak": len(bad),
        "days": bad,
        "description": (
            f"Son {streak} gündür ruh hali düşük "
            f"({', '.join(d['label'] for d in bad)})."
        ),
    }


def analyze_chat_sentiment(messages: list[dict]) -> dict[str, Any]:
    if not messages:
        return {
            "score": 0.0,
            "label": "veri yok",
            "risk_count": 0,
            "sample_count": 0,
            "daily": [],
            "highlights": [],
        }

    scores = []
    risk_count = 0
    by_day: dict[str, list[float]] = defaultdict(list)
    highlights: list[dict] = []

    for msg in messages:
        content = msg.get("content") or ""
        sent = score_text_sentiment(content)
        scores.append(sent["score"])
        if sent["risk"]:
            risk_count += 1
        dt = _parse_dt(msg.get("created_at"))
        if dt:
            by_day[dt.strftime("%Y-%m-%d")].append(sent["score"])
        if sent["score"] <= -0.35 or sent["risk"]:
            highlights.append({
                "text": content[:140],
                "score": sent["score"],
                "label": sent["label"],
                "risk": sent["risk"],
                "created_at": msg.get("created_at"),
            })

    avg = round(sum(scores) / len(scores), 3) if scores else 0.0
    if avg >= 0.25:
        label = "olumlu"
    elif avg <= -0.25:
        label = "olumsuz"
    else:
        label = "nötr"

    daily = []
    for day in sorted(by_day.keys())[-7:]:
        vals = by_day[day]
        daily.append({
            "date": day,
            "avg_score": round(sum(vals) / len(vals), 3),
            "count": len(vals),
        })

    highlights.sort(key=lambda h: (h["score"], str(h.get("created_at") or "")))
    return {
        "score": avg,
        "label": label,
        "risk_count": risk_count,
        "sample_count": len(scores),
        "daily": daily,
        "highlights": highlights[:5],
    }


def build_mood_analysis(
    *,
    user_id: str | None,
    elder_id: str | None,
    elder_name: str = "Yakınınız",
    notify: bool = True,
) -> dict[str, Any]:
    checkins = _fetch_checkins(user_id, elder_id, days=14)
    messages = _fetch_user_messages(user_id, elder_id, days=7, limit=50)
    series = _daily_mood_series(checkins, days=7)
    chat = analyze_chat_sentiment(messages)
    decline = detect_mood_decline(series, streak=3)

    latest = normalize_mood(checkins[0]["mood"]) if checkins else normalize_mood(None)
    week_scores = [d["avg_score"] for d in series if d.get("avg_score") is not None]
    week_avg = round(sum(week_scores) / len(week_scores), 2) if week_scores else None

    # Check-in + sohbet birleşik skor (0–3 ölçeği)
    chat_as_mood = None
    if chat["sample_count"]:
        # −1..+1 → 0.5..3
        chat_as_mood = round(1.75 + chat["score"] * 1.25, 2)

    combined = None
    parts = [x for x in (week_avg, chat_as_mood) if x is not None]
    if parts:
        combined = round(sum(parts) / len(parts), 2)

    if notify and decline.get("triggered") and elder_id:
        _maybe_notify_mood_decline(elder_id, elder_name, decline["description"])

    return {
        "success": True,
        "elder_id": elder_id,
        "latest": latest,
        "week_avg_score": week_avg,
        "combined_score": combined,
        "checkin_series": series,
        "chat_sentiment": chat,
        "decline": decline,
        "checkin_count": len(checkins),
        "insight": _mood_insight_text(elder_name, latest, week_avg, chat, decline),
    }


def _mood_insight_text(
    name: str,
    latest: dict,
    week_avg: float | None,
    chat: dict,
    decline: dict,
) -> str:
    bits = []
    if latest["key"] != "unknown":
        bits.append(f"Son check-in: {latest['label']}.")
    else:
        bits.append("Bugün henüz check-in yok.")

    if week_avg is not None:
        if week_avg >= 2.3:
            bits.append("Haftalık ruh hali genel olarak iyi.")
        elif week_avg >= 1.5:
            bits.append("Haftalık ruh hali orta seviyede.")
        else:
            bits.append("Haftalık ruh hali düşük seyrediyor; yakından takip önerilir.")

    if chat["sample_count"]:
        bits.append(
            f"Sohbet tonu {chat['label']} "
            f"({chat['sample_count']} mesaj, risk ipucu: {chat['risk_count']})."
        )
    if decline.get("triggered"):
        bits.append(decline["description"])

    return " ".join(bits) if bits else f"{name} için henüz yeterli ruh hali verisi yok."


def _maybe_notify_mood_decline(elder_id: str, name: str, description: str) -> None:
    today = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    key = f"mood_decline:{elder_id}:{today}"
    if key in _sent_mood_alerts:
        return

    try:
        existing = (
            supabase.table("alerts")
            .select("id")
            .eq("elder_id", elder_id)
            .eq("alert_type", "mood_decline")
            .gte("created_at", _days_ago_iso(1))
            .limit(1)
            .execute()
        )
        if existing.data:
            _sent_mood_alerts.add(key)
            return

        supabase.table("alerts").insert(
            {
                "elder_id": elder_id,
                "alert_type": "mood_decline",
                "severity": "medium",
                "description": f"{name}: {description}",
            }
        ).execute()
    except Exception as error:
        print(f"[INSIGHTS] mood_decline alert: {error}")
        try:
            supabase.table("alerts").insert(
                {
                    "elder_id": elder_id,
                    "alert_type": "conversation_risk",
                    "severity": "medium",
                    "description": f"{name}: {description}",
                }
            ).execute()
        except Exception as fallback_err:
            print(f"[INSIGHTS] mood_decline fallback alert: {fallback_err}")
            return

    try:
        from services.family_notify import notify_family

        notify_family(
            elder_id=elder_id,
            description=f"{name}: {description}",
            alert_type="mood_decline",
            severity="medium",
            send_sms=False,
        )
    except Exception as error:
        print(f"[INSIGHTS] mood_decline notify: {error}")

    _sent_mood_alerts.add(key)


def build_weekly_summary(
    *,
    user_id: str | None,
    elder_id: str | None,
    elder_name: str = "Yakınınız",
) -> dict[str, Any]:
    from medication import service as medication_service
    from services import activity_service

    mood = build_mood_analysis(
        user_id=user_id,
        elder_id=elder_id,
        elder_name=elder_name,
        notify=False,
    )

    med_stats = medication_service.get_medication_stats(elder_id) if elder_id else {}
    alerts = medication_service.get_elder_alerts(elder_id, limit=20) if elder_id else []
    since = _days_ago_iso(7)
    week_alerts = [
        a for a in alerts
        if str(a.get("created_at") or "") >= since[:10]
        or str(a.get("created_at") or "") >= since
    ]

    activity = activity_service.get_activity_summary(user_id=user_id, elder_id=elder_id)
    # Haftalık aktivite tahmini: bugün skoru + checkin/mesaj yoğunluğu
    chat_n = mood["chat_sentiment"]["sample_count"]
    checkin_n = mood["checkin_count"]
    activity_week_label = activity.get("activity_status") or "Bugün aktivite yok"
    if activity.get("score", 0) <= 0 and (chat_n or checkin_n):
        activity_week_label = "Hafta içinde etkileşim var"

    adherence = med_stats.get("adherence_rate", 0)
    total_logs = med_stats.get("total_logs", 0)

    bullets = [
        f"Ruh hali: {mood['insight']}",
        (
            f"İlaç uyumu: %{adherence}"
            if total_logs
            else "İlaç uyumu: henüz yeterli kayıt yok."
        ),
        f"Son 7 günde {len(week_alerts)} uyarı kaydı.",
        f"Aktivite: {activity_week_label}.",
    ]

    return {
        "success": True,
        "period_days": 7,
        "elder_id": elder_id,
        "elder_name": elder_name,
        "bullets": bullets,
        "mood": {
            "latest": mood["latest"],
            "week_avg_score": mood["week_avg_score"],
            "combined_score": mood["combined_score"],
            "series": mood["checkin_series"],
            "chat_label": mood["chat_sentiment"]["label"],
            "decline": mood["decline"],
        },
        "medication": {
            "adherence_rate": adherence,
            "total_logs": total_logs,
            "weekly_trend": med_stats.get("weekly_trend") or [],
        },
        "alerts": {
            "week_count": len(week_alerts),
            "recent": week_alerts[:5],
        },
        "activity": {
            **activity,
            "week_label": activity_week_label,
            "chat_messages": chat_n,
            "checkins": checkin_n,
        },
        "narrative_seed": " ".join(bullets),
    }


def generate_period_ai_summary(
    *,
    conversation_id: str,
    days: int = 7,
    groq_client: Any = None,
) -> dict[str, Any]:
    """Günlük veya haftalık AI özeti — tek kaynak."""
    from medication import service as medication_service

    days = max(1, min(int(days or 7), 14))
    elder = medication_service.resolve_elder_for_user(conversation_id, "Yakınınız")
    elder_id = elder.get("id")
    elder_name = elder.get("full_name") or "Yakınınız"

    try:
        user_resp = (
            supabase.table("users")
            .select("name")
            .eq("id", conversation_id)
            .limit(1)
            .execute()
        )
        if user_resp.data and user_resp.data[0].get("name"):
            elder_name = user_resp.data[0]["name"]
    except Exception:
        pass

    messages = _fetch_user_messages(conversation_id, elder_id, days=days, limit=40)
    # Asistan mesajlarını da ekle (bağlam)
    assistant_rows: list[dict] = []
    try:
        since = _days_ago_iso(days)
        if conversation_id:
            res = (
                supabase.table("messages")
                .select("role, content, created_at")
                .eq("user_id", conversation_id)
                .gte("created_at", since)
                .order("created_at", desc=True)
                .limit(40)
                .execute()
            )
            assistant_rows = res.data or []
    except Exception:
        assistant_rows = []

    chat_rows = assistant_rows or messages
    if not chat_rows and elder_id:
        # fallback already in _fetch_user_messages for user msgs; try all roles via conv
        try:
            convs = (
                supabase.table("conversations")
                .select("id")
                .eq("elder_id", elder_id)
                .limit(15)
                .execute()
            )
            ids = [c["id"] for c in (convs.data or [])]
            since = _days_ago_iso(days)
            for i in range(0, len(ids), 15):
                chunk = ids[i : i + 15]
                res = (
                    supabase.table("messages")
                    .select("role, content, created_at")
                    .in_("conversation_id", chunk)
                    .gte("created_at", since)
                    .order("created_at", desc=True)
                    .limit(40)
                    .execute()
                )
                chat_rows.extend(res.data or [])
            chat_rows.sort(key=lambda m: str(m.get("created_at") or ""), reverse=True)
            chat_rows = chat_rows[:40]
        except Exception as error:
            print(f"[AI-SUMMARY] fallback: {error}")

    weekly = build_weekly_summary(
        user_id=conversation_id,
        elder_id=elder_id,
        elder_name=elder_name,
    )

    period_label = "günlük" if days <= 1 else f"son {days} günlük"

    if not chat_rows and not weekly.get("narrative_seed"):
        return {
            "success": True,
            "summary": (
                f"{period_label.capitalize()} dönemde henüz yeterli sohbet veya check-in yok. "
                f"{elder_name} için genel durum stabil görünüyor; kiosk etkileşimi arttıkça özet dolacak."
            ),
            "period_days": days,
            "structured": weekly,
        }

    chat_history = list(reversed(chat_rows))
    formatted = ""
    for msg in chat_history:
        sender = elder_name if msg.get("role") == "user" else "Asistan"
        content = (msg.get("content") or "").strip()
        if content:
            formatted += f"{sender}: {content}\n"

    facts = weekly.get("narrative_seed") or ""
    prompt = (
        "Sen 'Yanımda Al' projesinin aile paneli analistisin. "
        f"{elder_name} için {period_label} özet yaz. "
        "Check-in ruh hali, ilaç uyumu, uyarılar ve sohbet ipuçlarını birleştir. "
        "Tam, okunaklı bir paragraf yaz: 6–8 cümle. "
        "Yarım bırakma; son cümleyi mutlaka tamamla. "
        "Tıbbi teşhis koyma. Türkçe yaz."
    )
    user_payload = (
        f"Yapılandırılmış veriler:\n{facts}\n\n"
        f"Sohbet örnekleri:\n{formatted or '(sohbet yok)'}"
    )

    summary_text = None
    if groq_client is not None:
        try:
            from ai_models import CHAT_MODEL

            response = groq_client.chat.completions.create(
                model=CHAT_MODEL,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": user_payload},
                ],
                max_tokens=520,
                temperature=0.45,
            )
            summary_text = (response.choices[0].message.content or "").strip()
        except Exception as error:
            print(f"[AI-SUMMARY] LLM hatası: {error}")

    if not summary_text:
        summary_text = (
            f"{elder_name} — {period_label} özet: {facts} "
            "Detaylar aile panelindeki ruh hali ve ilaç grafiklerinde."
        )

    return {
        "success": True,
        "summary": summary_text,
        "period_days": days,
        "structured": weekly,
    }


def enrich_dashboard_mood(latest_mood: str) -> dict[str, Any]:
    return normalize_mood(latest_mood)


def activity_empty_friendly(activity: dict[str, Any] | None) -> str:
    activity = activity or {}
    status = activity.get("activity_status") or "Bugün aktivite yok"
    score = int(activity.get("score") or 0)
    if score <= 0:
        return "Henüz etkileşim yok"
    return status
