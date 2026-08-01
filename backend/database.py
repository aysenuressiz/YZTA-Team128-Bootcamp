import os
from dotenv import load_dotenv
from supabase import create_client, Client
from datetime import datetime

# .env dosyasındaki gizli bilgileri yükle
load_dotenv()

URL = os.getenv("SUPABASE_URL")
KEY = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# Supabase bağlantısını kur
supabase: Client = create_client(URL, KEY)

# --- TRELLO GÖREVİ 1: KULLANICI BİLGİLERİNİN TUTULMASI ---
def add_elder(full_name, phone, city, preferred_language="tr"):
    data = {
        "full_name": full_name,
        "phone": phone,
        "city": city,
        "preferred_language": preferred_language
    }
    response = supabase.table("elders").insert(data).execute()
    return response.data

# --- TRELLO GÖREVİ 2: SOHBET GEÇMİŞİ TUTULMASI ---
def _resolve_elder_id_for_message(
    user_id: str | None = None,
    elder_id: str | None = None,
) -> str | None:
    if elder_id:
        return elder_id
    if not user_id:
        return None
    try:
        user_row = (
            supabase.table("users")
            .select("elder_id")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
        if user_row.data and user_row.data[0].get("elder_id"):
            return user_row.data[0]["elder_id"]
    except Exception:
        pass
    try:
        from medication.service import resolve_elder_for_user

        elder = resolve_elder_for_user(user_id, "Yaşlı")
        return elder.get("id")
    except Exception:
        return None


def save_message(conversation_id: str, role: str, content: str, user_id: str = None, elder_id: str = None):
    try:
        resolved_elder_id = _resolve_elder_id_for_message(user_id=user_id, elder_id=elder_id)

        # 1. Oturum kontrolü
        conv_check = supabase.table("conversations").select("id").eq("id", conversation_id).execute()

        # 2. Eğer oturum yoksa oluştur (elder_id NOT NULL)
        if not conv_check.data:
            if not resolved_elder_id:
                raise ValueError("Mesaj kaydı için elder_id gerekli.")
            supabase.table("conversations").insert(
                {"id": conversation_id, "elder_id": resolved_elder_id}
            ).execute()
            print(f"[OTURUM OLUŞTURULDU] {conversation_id} aktif.")
        elif resolved_elder_id:
            # Eski oturumda elder_id boşsa doldurmayı dene (sessiz)
            try:
                supabase.table("conversations").update(
                    {"elder_id": resolved_elder_id}
                ).eq("id", conversation_id).is_("elder_id", "null").execute()
            except Exception:
                pass

        # 3. Mesajı kaydet
        payload = {
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
        }
        if user_id:
            payload["user_id"] = user_id
        if resolved_elder_id:
            # elder_id kolonu yoksa insert yine de denenebilir; hata olursa fallback
            try:
                supabase.table("messages").insert({**payload, "elder_id": resolved_elder_id}).execute()
                return
            except Exception:
                pass
        supabase.table("messages").insert(payload).execute()

    except Exception as e:
        print(f"[VERİTABANI HATASI] Mesaj kaydedilemedi: {str(e)}")
        # user_id kolonu yoksa tekrarsız dene
        try:
            supabase.table("messages").insert({
                "conversation_id": conversation_id,
                "role": role,
                "content": content,
            }).execute()
        except Exception as e2:
            print(f"[VERİTABANI HATASI] Mesaj fallback da başarısız: {str(e2)}")

def make_conversation_title(first_message: str | None, created_at: str | None = None) -> str:
    """İlk kullanıcı mesajından kısa başlık üretir (ChatGPT tarzı)."""
    if first_message and str(first_message).strip():
        text = " ".join(str(first_message).strip().split())
        if len(text) > 40:
            text = text[:40].rstrip(" .,;:!?") + "…"
        return text
    if created_at:
        try:
            raw_date = str(created_at).split("T")[0]
            date_obj = datetime.strptime(raw_date, "%Y-%m-%d")
            return f"Sohbet · {date_obj.strftime('%d.%m.%Y')}"
        except Exception:
            pass
    return "Yeni sohbet"


def list_conversations_for_elder(elder_id: str, limit: int = 40) -> list[dict]:
    """Belirli yaşlıya ait sohbetleri, içerik başlığıyla listeler."""
    if not elder_id:
        return []

    conv_resp = (
        supabase.table("conversations")
        .select("id, started_at")
        .eq("elder_id", elder_id)
        .order("started_at", desc=True)
        .limit(limit)
        .execute()
    )
    conversations = conv_resp.data or []
    result: list[dict] = []

    for conv in conversations:
        c_id = conv["id"]
        first_user = (
            supabase.table("messages")
            .select("content, created_at")
            .eq("conversation_id", c_id)
            .eq("role", "user")
            .order("created_at", desc=False)
            .limit(1)
            .execute()
        )
        first = (first_user.data or [None])[0]
        # Hiç kullanıcı mesajı yoksa listeye alma (boş oturum)
        if not first:
            continue
        result.append({
            "conversation_id": c_id,
            "title": make_conversation_title(
                first.get("content"),
                first.get("created_at") or conv.get("started_at"),
            ),
            "started_at": conv.get("started_at"),
        })
    return result


def get_conversation_history(conversation_id):
    response = supabase.table("messages") \
        .select("*") \
        .eq("conversation_id", conversation_id) \
        .order("created_at", desc=False) \
        .execute()
    return response.data

# --- TRELLO GÖREVİ 3: GÜNLÜK DURUM (CHECK-IN) KAYITLARININ TUTULMASI ---
def _resolve_elder_id_for_checkin(
    conversation_id: str,
    elder_id: str | None = None,
) -> str | None:
    if elder_id:
        return elder_id
    try:
        user_row = (
            supabase.table("users")
            .select("elder_id")
            .eq("id", conversation_id)
            .limit(1)
            .execute()
        )
        if user_row.data and user_row.data[0].get("elder_id"):
            return user_row.data[0]["elder_id"]
    except Exception:
        pass
    try:
        from medication.service import resolve_elder_for_user

        elder = resolve_elder_for_user(conversation_id, "Yaşlı")
        return elder.get("id")
    except Exception:
        return None


def save_checkin(conversation_id: str, mood: str, elder_id: str | None = None):
    try:
        resolved_elder_id = _resolve_elder_id_for_checkin(conversation_id, elder_id)

        # 1. Oturum kontrolü
        conv_check = supabase.table("conversations").select("id").eq("id", conversation_id).execute()

        # 2. Eğer oturum yoksa oluştur — elder_id NOT NULL
        if not conv_check.data:
            if not resolved_elder_id:
                raise ValueError(
                    "Check-in için elder_id gerekli; conversations satırı oluşturulamadı."
                )
            supabase.table("conversations").insert(
                {"id": conversation_id, "elder_id": resolved_elder_id}
            ).execute()
            print(f"[OTURUM OLUŞTURULDU] Check-in için {conversation_id} aktif.")

        # 3. Durumu kaydet
        supabase.table("checkins").insert({
            "conversation_id": conversation_id,
            "mood": mood
        }).execute()

    except Exception as e:
        print(f"[VERİTABANI HATASI] Check-in kaydedilemedi: {str(e)}")
        raise e

def get_checkin_history(conversation_id, limit=10):
    """Belirli bir kullanıcının geçmiş check-in kayıtlarını en yeniden eskiye doğru getirir."""
    response = supabase.table("checkins") \
        .select("*") \
        .eq("conversation_id", conversation_id) \
        .order("created_at", desc=True) \
        .limit(limit) \
        .execute()
    return response.data

# --- TRELLO GÖREVİ: CHECK-IN EKSİKLİĞİ TESPİTİ ---
def get_today_checkin_status(conversation_id):
    """
    Bugün (yerel gün başlangıcından şu ana kadar) bu oturum için
    check-in yapılıp yapılmadığını kontrol eder.
    Yapılmışsa en son kaydı, yapılmamışsa None döner.
    """
    today_start = datetime.now().strftime("%Y-%m-%dT00:00:00")

    response = supabase.table("checkins") \
        .select("*") \
        .eq("conversation_id", conversation_id) \
        .gte("created_at", today_start) \
        .order("created_at", desc=True) \
        .limit(1) \
        .execute()

    if response.data:
        return response.data[0]
    return None
