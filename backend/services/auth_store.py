"""Kayıt / giriş depolama — users tablosu (tercih) veya elders.notes (yedek)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from database import supabase
from medication.service import resolve_elder_for_user

logger = logging.getLogger(__name__)

AUTH_NOTES_PREFIX = "YANIMDA_AUTH_JSON:"
_users_table_available: bool | None = None


def _normalize_phone(phone: str) -> str:
    digits = re.sub(r"\D+", "", phone or "")
    if digits.startswith("90") and len(digits) >= 12:
        digits = digits[2:]
    if digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    return digits


def _normalize_name(name: str) -> str:
    text = (name or "").strip().casefold()
    replacements = {
        "ı": "i",
        "i̇": "i",
        "ş": "s",
        "ğ": "g",
        "ü": "u",
        "ö": "o",
        "ç": "c",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return re.sub(r"\s+", " ", text)


def users_table_exists() -> bool:
    global _users_table_available
    if _users_table_available is not None:
        return _users_table_available
    try:
        supabase.table("users").select("id").limit(1).execute()
        _users_table_available = True
    except Exception as error:
        message = str(error)
        if "PGRST205" in message or "Could not find the table" in message:
            _users_table_available = False
            logger.warning("users tablosu yok — elders.notes yedek depolama kullanılacak.")
        else:
            # Geçici ağ hatalarında tekrar dene
            logger.warning("users tablo kontrolü başarısız: %s", error)
            return False
    return _users_table_available


def refresh_users_table_cache() -> bool:
    global _users_table_available
    _users_table_available = None
    return users_table_exists()


def _parse_auth_from_notes(notes: str | None) -> dict[str, Any] | None:
    if not notes:
        return None
    text = notes.strip()
    if text.startswith(AUTH_NOTES_PREFIX):
        text = text[len(AUTH_NOTES_PREFIX) :]
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict) and "yanimda_auth" in data:
        return data["yanimda_auth"]
    if isinstance(data, dict) and data.get("family_phone") and data.get("family_password"):
        return data
    return None


def _encode_auth_notes(auth: dict[str, Any]) -> str:
    return AUTH_NOTES_PREFIX + json.dumps({"yanimda_auth": auth}, ensure_ascii=False, separators=(",", ":"))


def _create_elder(full_name: str, family_phone: str, notes: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "full_name": full_name.strip(),
        "preferred_language": "tr",
        "phone": _normalize_phone(family_phone) or None,
    }
    if notes:
        payload["notes"] = notes
    created = supabase.table("elders").insert(payload).execute()
    if not created.data:
        raise HTTPException(status_code=500, detail="Yaşlı profili (elders) oluşturulamadı.")
    return created.data[0]


def register_elderly_and_family(
    *,
    elderly_name: str,
    elderly_age: int | None,
    face_vector: list[float] | list[list[float]] | dict[str, Any] | None,
    family_name: str,
    family_phone: str | None,
    family_password: str,
    elderly_first_name: str | None = None,
    elderly_last_name: str | None = None,
    elderly_birth_date: str | None = None,
    elderly_phone: str | None = None,
    elderly_email: str | None = None,
    elderly_password: str | None = None,
    family_first_name: str | None = None,
    family_last_name: str | None = None,
    family_relationship: str | None = None,
    family_birth_date: str | None = None,
    family_email: str | None = None,
) -> dict[str, Any]:
    first = (elderly_first_name or "").strip()
    last = (elderly_last_name or "").strip()
    name = (elderly_name or "").strip() or f"{first} {last}".strip()
    family_first = (family_first_name or "").strip()
    family_last = (family_last_name or "").strip()
    family = (family_name or "").strip() or f"{family_first} {family_last}".strip()
    phone = _normalize_phone(family_phone or "")
    elder_phone = _normalize_phone(elderly_phone or "")
    email = (elderly_email or "").strip().lower() or None
    fam_email = (family_email or "").strip().lower() or None
    relationship = (family_relationship or "").strip() or None
    birth_date = (elderly_birth_date or "").strip() or None
    fam_birth = (family_birth_date or "").strip() or None
    password = (family_password or "").strip()
    elder_password = (elderly_password or "").strip()

    def _email_ok(value: str | None) -> bool:
        if not value:
            return False
        return "@" in value and "." in value.split("@")[-1]

    if not name:
        raise HTTPException(status_code=400, detail="Yaşlı adı ve soyadı zorunludur.")
    if not family:
        raise HTTPException(status_code=400, detail="Aile / refakatçi adı ve soyadı zorunludur.")
    if not elder_phone and not email:
        raise HTTPException(status_code=400, detail="Yaşlı için telefon veya e-posta girin.")
    if elder_phone and len(elder_phone) < 10:
        raise HTTPException(status_code=400, detail="Geçerli bir yaşlı telefon numarası girin.")
    if email and not _email_ok(email):
        raise HTTPException(status_code=400, detail="Geçerli bir yaşlı e-postası girin.")
    if not phone and not fam_email:
        raise HTTPException(status_code=400, detail="Aile için telefon veya e-posta girin.")
    if phone and len(phone) < 10:
        raise HTTPException(status_code=400, detail="Geçerli bir aile telefon numarası girin.")
    if fam_email and not _email_ok(fam_email):
        raise HTTPException(status_code=400, detail="Geçerli bir aile e-postası girin.")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Aile şifresi en az 6 karakter olmalı.")
    if elder_password and len(elder_password) < 6:
        raise HTTPException(status_code=400, detail="Yaşlı şifresi en az 6 karakter olmalı.")
    if not elder_password:
        raise HTTPException(status_code=400, detail="Yaşlı şifresi zorunludur.")

    # family_phone NOT NULL olan ortamlarda e-posta ile kayıt için benzersiz yer tutucu
    phone_for_db = phone or f"email:{fam_email}"

    def _safe_exists(column: str, value: str) -> bool | None:
        """Sütun yoksa None (kontrol atlanır), varsa True/False döner."""
        if not value:
            return False
        try:
            found = (
                supabase.table("users")
                .select("id")
                .eq(column, value)
                .limit(1)
                .execute()
            )
            return bool(found.data)
        except Exception as err:
            print(f"[register] {column} kontrolü atlandı:", err)
            return None

    if users_table_exists():
        if phone and _safe_exists("family_phone", phone):
            raise HTTPException(status_code=409, detail="Bu aile telefon numarası zaten kayıtlı.")
        if (not phone) and phone_for_db and _safe_exists("family_phone", phone_for_db):
            raise HTTPException(status_code=409, detail="Bu aile e-postası zaten kayıtlı.")
        if elder_phone and _safe_exists("phone", elder_phone):
            raise HTTPException(status_code=409, detail="Bu yaşlı telefon numarası zaten kayıtlı.")
        if email and _safe_exists("email", email):
            raise HTTPException(status_code=409, detail="Bu yaşlı e-postası zaten kayıtlı.")
        if fam_email and _safe_exists("family_email", fam_email):
            raise HTTPException(status_code=409, detail="Bu aile e-postası zaten kayıtlı.")

        elder_contact = elder_phone or phone or None
        elder = _create_elder(name, elder_contact or "", notes="users tablosu bağlanacak")
        row = {
            "name": name,
            "first_name": first or None,
            "last_name": last or None,
            "birth_date": birth_date,
            "age": elderly_age,
            "phone": elder_phone or None,
            "email": email,
            "elderly_password": elder_password,
            "face_vector": face_vector,
            "family_name": family,
            "family_first_name": family_first or None,
            "family_last_name": family_last or None,
            "family_relationship": relationship,
            "family_birth_date": fam_birth,
            "family_phone": phone_for_db,
            "family_email": fam_email,
            "family_password": password,
            "family_sms_enabled": bool(phone),
            "elder_id": elder["id"],
        }

        # Migration uygulanmamış ortamlarda eksik sütunlarla aşamalı geri düş
        insert_attempts = [
            row,
            {
                "name": name,
                "age": elderly_age,
                "face_vector": face_vector,
                "family_name": family,
                "family_phone": phone_for_db,
                "family_password": password,
                "family_sms_enabled": bool(phone),
                "elder_id": elder["id"],
            },
        ]
        inserted = None
        last_err: Exception | None = None
        for attempt in insert_attempts:
            try:
                inserted = supabase.table("users").insert(attempt).execute()
                if inserted.data:
                    break
            except Exception as err:
                last_err = err
                print("[register] insert denemesi başarısız:", err)
                inserted = None

        if not inserted or not inserted.data:
            detail = f"Kullanıcı kaydı oluşturulamadı: {last_err}" if last_err else "Kullanıcı kaydı oluşturulamadı."
            raise HTTPException(status_code=500, detail=detail)
        user = inserted.data[0]
        supabase.table("elders").update(
            {"notes": f"users tablosu user_id: {user['id']}"}
        ).eq("id", elder["id"]).execute()
        return {
            "success": True,
            "storage": "users",
            "user_id": user["id"],
            "elder_id": elder["id"],
            "name": name,
            "message": "Kayıt işlemi başarıyla tamamlandı!",
        }

    elders = (
        supabase.table("elders")
        .select("id, full_name, phone, notes")
        .execute()
        .data
        or []
    )
    for elder in elders:
        auth = _parse_auth_from_notes(elder.get("notes"))
        elder_phone_existing = _normalize_phone(elder.get("phone") or "")
        if phone and (
            (auth and _normalize_phone(str(auth.get("family_phone") or "")) == phone)
            or elder_phone_existing == phone
        ):
            raise HTTPException(status_code=409, detail="Bu telefon numarası zaten kayıtlı.")

    user_id = str(uuid4())
    auth_blob = {
        "user_id": user_id,
        "age": elderly_age,
        "first_name": first,
        "last_name": last,
        "birth_date": birth_date,
        "phone": elder_phone,
        "email": email,
        "elderly_password": elder_password,
        "family_name": family,
        "family_first_name": family_first,
        "family_last_name": family_last,
        "family_relationship": relationship,
        "family_birth_date": fam_birth,
        "family_phone": phone_for_db,
        "family_email": fam_email,
        "family_password": password,
        "face_vector": face_vector,
        "family_sms_enabled": bool(phone),
    }
    notes = _encode_auth_notes(auth_blob) + f"\nusers tablosu user_id: {user_id}"
    elder = _create_elder(name, elder_phone or phone or "", notes=notes)
    return {
        "success": True,
        "storage": "elders_notes",
        "user_id": user_id,
        "elder_id": elder["id"],
        "name": name,
        "message": "Kayıt tamamlandı (elders yedek depolama). İsterseniz users tablosu migration'ını uygulayın.",
    }


def family_login(
    *,
    phone: str | None = None,
    email: str | None = None,
    password: str,
) -> dict[str, Any]:
    normalized = _normalize_phone(phone or "")
    mail = (email or "").strip().lower() or None
    plain = (password or "").strip()
    if (not normalized and not mail) or not plain:
        raise HTTPException(status_code=400, detail="Telefon veya e-posta ile birlikte şifre zorunludur.")

    def _family_ok(user: dict[str, Any]) -> bool:
        return str(user.get("family_password") or "") == plain

    def _pack(user: dict[str, Any]) -> dict[str, Any]:
        elder_id = user.get("elder_id")
        if not elder_id:
            elder = resolve_elder_for_user(user["id"], user.get("name") or "Yaşlı")
            elder_id = elder["id"]
            try:
                supabase.table("users").update({"elder_id": elder_id}).eq("id", user["id"]).execute()
            except Exception:
                pass
        return {
            "success": True,
            "message": f"Hoş geldiniz, {user.get('family_name')}",
            "family_name": user.get("family_name"),
            "elderly_id": user.get("id"),
            "elderly_name": user.get("name"),
            "user_id": user.get("id"),
            "elder_id": elder_id,
        }

    if users_table_exists():
        user = None
        if normalized:
            response = (
                supabase.table("users")
                .select("*")
                .eq("family_phone", normalized)
                .limit(1)
                .execute()
            )
            if response.data:
                user = response.data[0]
            else:
                all_users = supabase.table("users").select("*").execute().data or []
                for u in all_users:
                    if _normalize_phone(str(u.get("family_phone") or "")) == normalized:
                        user = u
                        break
        if user is None and mail:
            by_email = (
                supabase.table("users")
                .select("*")
                .eq("family_email", mail)
                .limit(1)
                .execute()
            )
            if by_email.data:
                user = by_email.data[0]
            else:
                # e-posta ile kayıtta family_phone = email:{mail} olabilir
                placeholder = (
                    supabase.table("users")
                    .select("*")
                    .eq("family_phone", f"email:{mail}")
                    .limit(1)
                    .execute()
                )
                if placeholder.data:
                    user = placeholder.data[0]

        if not user:
            raise HTTPException(status_code=404, detail="Bu telefon / e-postaya ait bir kayıt bulunamadı.")
        if not _family_ok(user):
            raise HTTPException(status_code=401, detail="Hatalı şifre girdiniz.")
        return _pack(user)

    elders = supabase.table("elders").select("*").execute().data or []
    for elder in elders:
        auth = _parse_auth_from_notes(elder.get("notes"))
        if not auth:
            continue
        auth_phone = _normalize_phone(str(auth.get("family_phone") or ""))
        auth_email = str(auth.get("family_email") or "").strip().lower() or None
        phone_match = normalized and (
            auth_phone == normalized or auth_phone == f"email:{mail or ''}"
        )
        email_match = mail and (auth_email == mail or auth_phone == f"email:{mail}")
        if not (phone_match or email_match):
            continue
        if str(auth.get("family_password") or "") != plain:
            raise HTTPException(status_code=401, detail="Hatalı şifre girdiniz.")
        user_id = auth.get("user_id") or elder["id"]
        return {
            "success": True,
            "message": f"Hoş geldiniz, {auth.get('family_name')}",
            "family_name": auth.get("family_name"),
            "elderly_id": user_id,
            "elderly_name": elder.get("full_name"),
            "user_id": user_id,
            "elder_id": elder["id"],
        }

    raise HTTPException(status_code=404, detail="Bu telefon / e-postaya ait bir kayıt bulunamadı.")


def elderly_login(
    *,
    phone: str | None = None,
    email: str | None = None,
    password: str,
) -> dict[str, Any]:
    normalized = _normalize_phone(phone or "")
    mail = (email or "").strip().lower() or None
    plain = (password or "").strip()
    if (not normalized and not mail) or not plain:
        raise HTTPException(status_code=400, detail="Telefon veya e-posta ile birlikte şifre zorunludur.")

    if users_table_exists():
        user = None
        if normalized:
            response = (
                supabase.table("users")
                .select("*")
                .eq("phone", normalized)
                .limit(1)
                .execute()
            )
            if response.data:
                user = response.data[0]
        if user is None and mail:
            by_email = (
                supabase.table("users")
                .select("*")
                .eq("email", mail)
                .limit(1)
                .execute()
            )
            if by_email.data:
                user = by_email.data[0]

        if not user:
            raise HTTPException(status_code=404, detail="Bu telefon / e-postaya ait bir kayıt bulunamadı.")
        stored = str(user.get("elderly_password") or "")
        if not stored or stored != plain:
            raise HTTPException(status_code=401, detail="Hatalı şifre girdiniz.")

        elder_id = user.get("elder_id")
        if not elder_id:
            elder = resolve_elder_for_user(user["id"], user.get("name") or "Yaşlı")
            elder_id = elder["id"]
        return {
            "success": True,
            "message": f"Giriş Başarılı. Hoş geldin {user.get('name')}",
            "user_id": user["id"],
            "name": user.get("name"),
            "elder_id": elder_id,
        }

    elders = supabase.table("elders").select("*").execute().data or []
    for elder in elders:
        auth = _parse_auth_from_notes(elder.get("notes"))
        if not auth:
            continue
        auth_phone = _normalize_phone(str(auth.get("phone") or ""))
        auth_email = str(auth.get("email") or "").strip().lower() or None
        phone_match = bool(normalized) and auth_phone == normalized
        email_match = bool(mail) and auth_email == mail
        if not (phone_match or email_match):
            continue
        if str(auth.get("elderly_password") or "") != plain:
            raise HTTPException(status_code=401, detail="Hatalı şifre girdiniz.")
        user_id = auth.get("user_id") or elder["id"]
        return {
            "success": True,
            "message": f"Giriş Başarılı. Hoş geldin {elder.get('full_name')}",
            "user_id": user_id,
            "name": elder.get("full_name"),
            "elder_id": elder["id"],
        }

    raise HTTPException(status_code=404, detail="Bu telefon / e-postaya ait bir kayıt bulunamadı.")


def credentials_login(*, name: str, age: int) -> dict[str, Any]:
    target_name = _normalize_name(name)
    target_age = int(age)

    if users_table_exists():
        rows = (
            supabase.table("users")
            .select("id, name, age, elder_id")
            .execute()
            .data
            or []
        )
        for user in rows:
            if _normalize_name(str(user.get("name") or "")) == target_name and int(user.get("age") or -1) == target_age:
                elder_id = user.get("elder_id")
                if not elder_id:
                    elder = resolve_elder_for_user(user["id"], user.get("name") or "Yaşlı")
                    elder_id = elder["id"]
                return {
                    "success": True,
                    "message": f"Giriş Başarılı. Hoş geldin {user['name']}",
                    "user_id": user["id"],
                    "name": user["name"],
                    "elder_id": elder_id,
                }
        raise HTTPException(status_code=401, detail="Girdiğiniz ad veya yaş hatalı.")

    elders = supabase.table("elders").select("*").execute().data or []
    for elder in elders:
        auth = _parse_auth_from_notes(elder.get("notes"))
        elder_name = _normalize_name(str(elder.get("full_name") or ""))
        if elder_name != target_name:
            continue
        auth_age = int(auth.get("age")) if auth and auth.get("age") is not None else None
        if auth_age is not None and auth_age != target_age:
            continue
        if auth_age is None:
            # yaş notes'ta yoksa isim eşleşmesi yeterli değil — yaş zorunlu
            continue
        user_id = (auth or {}).get("user_id") or elder["id"]
        return {
            "success": True,
            "message": f"Giriş Başarılı. Hoş geldin {elder.get('full_name')}",
            "user_id": user_id,
            "name": elder.get("full_name"),
            "elder_id": elder["id"],
        }

    raise HTTPException(status_code=401, detail="Girdiğiniz ad veya yaş hatalı.")


def list_users_with_faces() -> list[dict[str, Any]]:
    if users_table_exists():
        rows = (
            supabase.table("users")
            .select("id, name, face_vector, elder_id")
            .not_.is_("face_vector", "null")
            .execute()
            .data
            or []
        )
        return rows

    results: list[dict[str, Any]] = []
    elders = supabase.table("elders").select("id, full_name, notes").execute().data or []
    for elder in elders:
        auth = _parse_auth_from_notes(elder.get("notes"))
        if not auth or not auth.get("face_vector"):
            continue
        results.append(
            {
                "id": auth.get("user_id") or elder["id"],
                "name": elder.get("full_name"),
                "face_vector": auth.get("face_vector"),
                "elder_id": elder["id"],
            }
        )
    return results


def get_family_phone_for_user(user_id: str) -> dict[str, Any] | None:
    """SMS servisi için telefon çözümleme."""
    if users_table_exists():
        try:
            row = (
                supabase.table("users")
                .select("id, family_phone, family_sms_enabled, family_name")
                .eq("id", user_id)
                .limit(1)
                .execute()
            )
            if row.data:
                return row.data[0]
        except Exception as error:
            logger.warning("users telefon sorgusu: %s", error)

    elders = supabase.table("elders").select("*").execute().data or []
    for elder in elders:
        auth = _parse_auth_from_notes(elder.get("notes"))
        if not auth:
            continue
        if auth.get("user_id") == user_id or elder.get("id") == user_id:
            return {
                "id": user_id,
                "family_phone": auth.get("family_phone") or elder.get("phone"),
                "family_sms_enabled": auth.get("family_sms_enabled", True),
                "family_name": auth.get("family_name"),
            }
    return None
