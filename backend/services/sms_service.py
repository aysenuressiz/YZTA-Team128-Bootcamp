"""Twilio SMS — kimlik bilgisi varsa gerçek gönderim, yoksa güvenli stub."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

SMS_PAIN_ESCALATION_THRESHOLD = int(os.getenv("SMS_PAIN_ESCALATION_THRESHOLD", "9"))


def should_send_family_sms(
    *,
    pain_level: int | None = None,
    is_danger: bool = False,
    wrong_medication: bool = False,
    intent: str | None = None,
    urgency: str | None = None,
) -> bool:
    """
    SMS barajı (yanlış pozitif azaltma):
    - ağrı >= 9 → SMS
    - is_danger / yanlış ilaç → SMS
    - ağrı biliniyor ve < 9 → SMS YOK (WS eskalasyonu yeterli; örn. 7)
    - ağrı yok + intent=escalation + urgency=high → SMS (düşme, nefes vb.)
    """
    if is_danger or wrong_medication:
        return True

    if pain_level is not None:
        try:
            return int(pain_level) >= SMS_PAIN_ESCALATION_THRESHOLD
        except (TypeError, ValueError):
            return False

    if (intent or "").lower() == "escalation" and (urgency or "").lower() == "high":
        return True

    return False


def _twilio_credentials() -> dict[str, str] | None:
    """
    İki yol:
    1) Account SID (AC…) + Auth Token + From phone
    2) Account SID (AC…) + API Key (SK…) + API Secret + From phone
    """
    account_sid = (os.getenv("TWILIO_ACCOUNT_SID") or "").strip()
    auth_token = (os.getenv("TWILIO_AUTH_TOKEN") or "").strip()
    api_key = (os.getenv("TWILIO_API_KEY") or "").strip()
    api_secret = (os.getenv("TWILIO_API_SECRET") or "").strip()
    from_phone = (os.getenv("TWILIO_PHONE_NUMBER") or "").strip()

    placeholders = ("your_", "xxx", "changeme")
    values = [account_sid, auth_token, api_key, api_secret, from_phone]
    if any(
        v.lower().startswith(p)
        for v in values if v
        for p in placeholders
    ):
        return None

    if not from_phone or not account_sid:
        return None
    # Account SID Twilio'da AC ile başlar
    if not account_sid.startswith("AC"):
        return None

    if api_key.startswith("SK") and api_secret:
        return {
            "auth_mode": "api_key",
            "account_sid": account_sid,
            "api_key": api_key,
            "api_secret": api_secret,
            "from_phone": from_phone,
        }

    if auth_token:
        return {
            "auth_mode": "auth_token",
            "account_sid": account_sid,
            "auth_token": auth_token,
            "from_phone": from_phone,
        }

    return None


def sms_delivery_mode() -> str:
    """
    twilio | stub | misconfigured
    FAMILY_SMS_ENABLED:
      - false/off → her zaman stub
      - true/on  → twilio (eksikse misconfigured)
      - auto/boş → kimlik varsa twilio, yoksa stub
    """
    flag = (os.getenv("FAMILY_SMS_ENABLED") or "auto").strip().lower()
    has_creds = _twilio_credentials() is not None

    if flag in {"0", "false", "no", "off"}:
        return "stub"
    if flag in {"1", "true", "yes", "on"}:
        return "twilio" if has_creds else "misconfigured"
    # auto
    return "twilio" if has_creds else "stub"


def twilio_ready() -> bool:
    return sms_delivery_mode() == "twilio"


def to_e164(phone: str, *, default_region: str = "TR") -> str | None:
    """Yerel TR numarayı Twilio E.164 formatına çevirir (+905xxxxxxxxx)."""
    raw = (phone or "").strip()
    if not raw or raw.lower().startswith("email:"):
        return None

    if raw.startswith("+"):
        digits = re.sub(r"\D", "", raw)
        return f"+{digits}" if len(digits) >= 10 else None

    digits = re.sub(r"\D", "", raw)
    if not digits:
        return None

    if default_region.upper() == "TR":
        if digits.startswith("90") and len(digits) >= 12:
            digits = digits[2:]
        if digits.startswith("0") and len(digits) == 11:
            digits = digits[1:]
        if len(digits) == 10 and digits.startswith("5"):
            return f"+90{digits}"
        if len(digits) >= 10:
            return f"+90{digits[-10:]}"

    if len(digits) >= 10:
        return f"+{digits}"
    return None


def send_family_sms(to_phone: str, message: str) -> dict[str, Any]:
    """
    Gerçek Twilio veya stub.
    Dönüş: {sent, mode, to, reason?, sid?}
    Geriye uyumluluk: bool(result) → sent
    """
    result: dict[str, Any] = {"sent": False, "mode": sms_delivery_mode(), "to": None}

    if not to_phone or not str(to_phone).strip():
        result["reason"] = "no_phone"
        logger.warning("SMS gönderilemedi: alıcı telefon yok.")
        return _SmsResult(result)

    e164 = to_e164(str(to_phone))
    if not e164:
        result["reason"] = "invalid_phone"
        logger.warning("SMS gönderilemedi: geçersiz telefon %r", to_phone)
        return _SmsResult(result)

    result["to"] = e164
    body = (message or "").strip()
    if not body:
        result["reason"] = "empty_body"
        logger.warning("SMS gönderilemedi: mesaj boş.")
        return _SmsResult(result)

    mode = result["mode"]
    if mode == "stub":
        logger.info("[SMS STUB] Kime: %s | Mesaj: %s", e164, body)
        print(f"[SMS STUB] Kime: {e164} | Mesaj: {body}")
        result["sent"] = True
        result["reason"] = "stub"
        return _SmsResult(result)

    if mode == "misconfigured":
        result["reason"] = "twilio_credentials_missing"
        logger.error(
            "FAMILY_SMS_ENABLED açık ama TWILIO_ACCOUNT_SID / AUTH_TOKEN / PHONE_NUMBER eksik."
        )
        print("[SMS] Twilio kimlik bilgileri eksik — gerçek SMS gönderilemedi.")
        return _SmsResult(result)

    creds = _twilio_credentials()
    if not creds:
        result["reason"] = "twilio_credentials_missing"
        return _SmsResult(result)

    try:
        from twilio.rest import Client
    except ImportError:
        result["reason"] = "twilio_package_missing"
        logger.error("twilio paketi yüklü değil; SMS gönderilemedi.")
        print("[SMS] twilio paketi yok: pip install twilio")
        return _SmsResult(result)

    try:
        if creds.get("auth_mode") == "api_key":
            client = Client(
                creds["api_key"],
                creds["api_secret"],
                creds["account_sid"],
            )
        else:
            client = Client(creds["account_sid"], creds["auth_token"])

        # Yeni Twilio trial: özel body yasak; şablon adı kullanılmalı
        trial_flag = (os.getenv("TWILIO_TRIAL_MODE") or "auto").strip().lower()
        trial_template = (
            os.getenv("TWILIO_TRIAL_TEMPLATE") or "sms_account_alerts"
        ).strip() or "sms_account_alerts"
        force_trial = trial_flag in {"1", "true", "yes", "on"}
        never_trial = trial_flag in {"0", "false", "no", "off"}

        create_kwargs: dict[str, Any] = {
            "from_": creds["from_phone"],
            "to": e164,
            "body": trial_template if force_trial else body[:1600],
        }

        try:
            msg = client.messages.create(**create_kwargs)
        except Exception as first_error:
            err_text = str(first_error).lower()
            if (
                not never_trial
                and "template" in err_text
                and create_kwargs["body"] != trial_template
            ):
                create_kwargs["body"] = trial_template
                msg = client.messages.create(**create_kwargs)
                result["trial_template"] = trial_template
            else:
                raise

        result["sent"] = True
        result["sid"] = getattr(msg, "sid", None)
        result["reason"] = "sent"
        if create_kwargs.get("body") == trial_template:
            result["trial_template"] = trial_template
            result["note"] = (
                "Twilio trial: özel metin yerine şablon gönderildi "
                f"({trial_template}). Hesabı upgrade edince özel SMS açılır."
            )
        logger.info("SMS gönderildi → %s sid=%s", e164, result["sid"])
        print(f"[SMS] Gönderildi → {e164} sid={result['sid']}")
        return _SmsResult(result)
    except Exception as error:
        result["reason"] = f"twilio_error:{error}"
        logger.error("Twilio SMS hatası: %s", error)
        print(f"[SMS] Twilio hatası: {error}")
        return _SmsResult(result)


class _SmsResult(dict):
    """dict + truthiness = sent (eski `if send_family_sms(...)` uyumu)."""

    def __bool__(self) -> bool:
        return bool(self.get("sent"))


def _user_id_from_elder_notes(notes: str | None) -> str | None:
    if not notes:
        return None
    match = re.search(r"users tablosu user_id:\s*([^\s]+)", notes, re.IGNORECASE)
    return match.group(1).strip() if match else None


def resolve_family_contact(
    *,
    user_id: str | None = None,
    elder_id: str | None = None,
) -> dict[str, Any]:
    """
    Aile telefonu: users.family_phone.
    İsteğe bağlı users.family_sms_enabled (yoksa True).
    Demo: FAMILY_SMS_OVERRIDE_PHONE env.
    """
    override = (os.getenv("FAMILY_SMS_OVERRIDE_PHONE") or "").strip()
    if override:
        return {
            "phone": override,
            "phone_e164": to_e164(override),
            "sms_enabled": True,
            "source": "env_override",
        }

    try:
        from database import supabase
    except Exception as error:
        logger.warning("Supabase yok; aile telefonu çözülemedi: %s", error)
        return {"phone": None, "sms_enabled": False, "source": "error"}

    candidate_ids: list[str] = []
    if user_id:
        candidate_ids.append(str(user_id))
    if elder_id and str(elder_id) not in candidate_ids:
        candidate_ids.append(str(elder_id))
        try:
            elder_res = (
                supabase.table("elders")
                .select("id, notes")
                .eq("id", elder_id)
                .limit(1)
                .execute()
            )
            if elder_res.data:
                linked = _user_id_from_elder_notes(elder_res.data[0].get("notes"))
                if linked and linked not in candidate_ids:
                    candidate_ids.append(linked)
        except Exception as error:
            logger.warning("Elder notes okunamadı: %s", error)

    for candidate in candidate_ids:
        try:
            try:
                res = (
                    supabase.table("users")
                    .select("id, family_phone, family_sms_enabled, family_name")
                    .eq("id", candidate)
                    .limit(1)
                    .execute()
                )
            except Exception:
                res = (
                    supabase.table("users")
                    .select("id, family_phone, family_name")
                    .eq("id", candidate)
                    .limit(1)
                    .execute()
                )

            if not res.data:
                continue
            row = res.data[0]
            phone = (row.get("family_phone") or "").strip()
            if not phone or phone.lower().startswith("email:"):
                continue
            sms_pref = row.get("family_sms_enabled")
            sms_enabled = True if sms_pref is None else bool(sms_pref)
            return {
                "phone": phone,
                "phone_e164": to_e164(phone),
                "sms_enabled": sms_enabled,
                "family_name": row.get("family_name"),
                "source": f"users:{candidate}",
            }
        except Exception as error:
            logger.warning("users telefon sorgusu başarısız (%s): %s", candidate, error)

    try:
        from services import auth_store

        for candidate in candidate_ids:
            row = auth_store.get_family_phone_for_user(candidate) or {}
            phone = (row.get("family_phone") or "").strip()
            if not phone or phone.lower().startswith("email:"):
                continue
            sms_pref = row.get("family_sms_enabled")
            return {
                "phone": phone,
                "phone_e164": to_e164(phone),
                "sms_enabled": True if sms_pref is None else bool(sms_pref),
                "family_name": row.get("family_name"),
                "source": f"auth_store:{candidate}",
            }
    except Exception as error:
        logger.warning("auth_store telefon fallback: %s", error)

    return {"phone": None, "sms_enabled": False, "source": "not_found"}


def maybe_notify_family_sms(state: dict[str, Any]) -> dict[str, Any]:
    """Eskalasyon state'inden SMS kararı + gönderim. Sonuç özeti döner."""
    decision = state.get("health_decision") or {}
    pain_level = decision.get("pain_level")
    if pain_level is None and state.get("pain_level") is not None:
        pain_level = state.get("pain_level")

    is_danger = bool(decision.get("is_danger") or state.get("is_danger"))
    wrong_medication = bool(decision.get("wrong_medication"))
    intent = state.get("intent")
    urgency = state.get("urgency") or "high"

    if not should_send_family_sms(
        pain_level=pain_level if pain_level is not None else None,
        is_danger=is_danger,
        wrong_medication=wrong_medication,
        intent=intent,
        urgency=urgency,
    ):
        return {"attempted": False, "sent": False, "reason": "below_sms_threshold"}

    contact = resolve_family_contact(
        user_id=state.get("user_id"),
        elder_id=state.get("elder_id"),
    )
    phone = contact.get("phone")
    if not phone:
        return {"attempted": True, "sent": False, "reason": "no_family_phone"}

    if contact.get("sms_enabled") is False:
        return {"attempted": True, "sent": False, "reason": "family_sms_disabled"}

    detail = state.get("escalation_reason") or state.get("user_message") or "Kritik sağlık olayı"
    elder_name = state.get("user_name") or "Yakınınız"
    body = (
        f"Yanımda Al KRİTİK UYARI: {elder_name} için yüksek risk.\n"
        f"Detay: {str(detail)[:160]}\n"
        "Lütfen aile panelini kontrol edin."
    )
    send_result = send_family_sms(phone, body)
    if isinstance(send_result, dict):
        sent_ok = bool(send_result.get("sent"))
        reason = send_result.get("reason") or ("sent" if sent_ok else "send_failed")
        mode = send_result.get("mode")
        sid = send_result.get("sid")
        to_phone = send_result.get("to") or phone
    else:
        sent_ok = bool(send_result)
        reason = "sent" if sent_ok else "send_failed"
        mode = None
        sid = None
        to_phone = phone

    return {
        "attempted": True,
        "sent": sent_ok,
        "reason": reason,
        "mode": mode,
        "phone_masked": _mask_phone(to_phone),
        "sid": sid,
    }


def _mask_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    if len(digits) < 4:
        return "***"
    return f"***{digits[-4:]}"
