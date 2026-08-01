"""Check-in eksikliği tespiti — günde bir kez aileye uyarı."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from database import get_today_checkin_status, supabase
from medication import service as medication_service
from routers.websocket import notify_family_critical

LOCAL_TZ = ZoneInfo("Europe/Istanbul")
CHECKIN_DEADLINE_HOUR = 12
_sent_checkin_alerts: set[str] = set()


def _extract_user_id_from_notes(notes: str | None) -> str | None:
    text = notes or ""
    marker = "users tablosu user_id:"
    if marker not in text:
        return None
    return text.split(marker, 1)[1].strip().split()[0] or None


def _has_checkin_today(user_id: str | None, elder_id: str) -> bool:
    if user_id and get_today_checkin_status(user_id):
        return True

    try:
        convs = (
            supabase.table("conversations")
            .select("id")
            .eq("elder_id", elder_id)
            .execute()
        )
        for conv in convs.data or []:
            if get_today_checkin_status(conv["id"]):
                return True
    except Exception as error:
        print(f"[CHECKIN-MISS] conversation check hatası: {error}")

    return False


def _alert_already_today(elder_id: str) -> bool:
    today = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    key = f"{elder_id}:{today}"
    if key in _sent_checkin_alerts:
        return True
    try:
        today_start = (
            datetime.now(LOCAL_TZ)
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .isoformat()
        )
        res = (
            supabase.table("alerts")
            .select("id")
            .eq("elder_id", elder_id)
            .eq("alert_type", "checkin_missing")
            .gte("created_at", today_start)
            .limit(1)
            .execute()
        )
        if res.data:
            _sent_checkin_alerts.add(key)
            return True
    except Exception as error:
        print(f"[CHECKIN-MISS] alert sorgu hatası: {error}")
    return False


def _create_checkin_missing_alert(elder_id: str, elder_name: str) -> None:
    description = (
        f"{elder_name} bugün henüz günlük check-in yapmadı. "
        "Durumunu kontrol etmek isteyebilirsiniz."
    )
    try:
        supabase.table("alerts").insert(
            {
                "elder_id": elder_id,
                "alert_type": "checkin_missing",
                "severity": "medium",
                "description": description,
            }
        ).execute()
    except Exception as error:
        print(f"[CHECKIN-MISS] alert yazılamadı: {error}")
        return

    today = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
    _sent_checkin_alerts.add(f"{elder_id}:{today}")

    notify_family_critical(
        elder_id,
        description=description,
        severity="medium",
        alert_type="checkin_missing",
        urgency="medium",
    )
    print(f"[CHECKIN-MISS] Uyarı oluşturuldu: {elder_name} / {elder_id}")


def _collect_targets() -> list[dict]:
    """elder_id + user_id + name listesi."""
    targets: dict[str, dict] = {}

    try:
        elders = supabase.table("elders").select("id, full_name, notes").execute()
        for elder in elders.data or []:
            elder_id = elder.get("id")
            if not elder_id:
                continue
            targets[elder_id] = {
                "elder_id": elder_id,
                "name": elder.get("full_name") or "Yakınınız",
                "user_id": _extract_user_id_from_notes(elder.get("notes")),
            }
    except Exception as error:
        print(f"[CHECKIN-MISS] elders okunamadı: {error}")

    try:
        profiles = supabase.table("elder_profiles").select("user_id").execute()
        for row in profiles.data or []:
            uid = row.get("user_id")
            if not uid:
                continue
            try:
                elder = medication_service.resolve_elder_for_user(uid, "Yaşlı")
                elder_id = elder.get("id")
                if not elder_id:
                    continue
                entry = targets.setdefault(
                    elder_id,
                    {
                        "elder_id": elder_id,
                        "name": elder.get("full_name") or "Yakınınız",
                        "user_id": uid,
                    },
                )
                if not entry.get("user_id"):
                    entry["user_id"] = uid
            except Exception:
                continue
    except Exception as error:
        print(f"[CHECKIN-MISS] profiles okunamadı: {error}")

    return list(targets.values())


def check_missing_checkins() -> None:
    """Her 15 dk: öğleden sonra check-in yapmayan yaşlılar için uyarı."""
    try:
        now = datetime.now(LOCAL_TZ)
        if now.hour < CHECKIN_DEADLINE_HOUR:
            return

        for target in _collect_targets():
            elder_id = target["elder_id"]
            if _alert_already_today(elder_id):
                continue
            if _has_checkin_today(target.get("user_id"), elder_id):
                continue
            _create_checkin_missing_alert(elder_id, target.get("name") or "Yakınınız")

    except Exception as error:
        print(f"[CHECKIN-MISS] Hata: {error}")
