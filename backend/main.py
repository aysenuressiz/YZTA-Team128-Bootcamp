from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from groq import Groq
import os
from dotenv import load_dotenv
load_dotenv()
import io
from datetime import datetime
import numpy as np
import cv2

def _get_deepface():
    try:
        from deepface import DeepFace
        return DeepFace
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail="Yüz tanıma modülü hazır değil. 'pip install deepface tf-keras==2.18.0' komutunu çalıştırın.",
        ) from error

import json
import base64
import asyncio

from database import (
    save_message,
    create_client,
    Client,
    save_checkin,
    get_checkin_history,
    get_today_checkin_status,
    list_conversations_for_elder,
)
from medication.router import router as medication_router
from medication.crud_router import router as medication_crud_router
from routers.websocket import router as websocket_router
from routers.health import router as health_router
from medication.scheduler import start_scheduler, set_event_loop
from services import auth_store

app = FastAPI(title="Yanımda Al - Yaşlı Refakatçi API")

@app.on_event("startup")
async def startup_event():
    set_event_loop(asyncio.get_running_loop())
    start_scheduler()

def _cors_origins() -> list[str]:
    raw = (os.getenv("CORS_ORIGINS") or "*").strip()
    if raw == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(medication_router)
app.include_router(medication_crud_router)
app.include_router(websocket_router)
app.include_router(health_router)

groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))

SUPABASE_URL  = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# --- PYDANTIC MODELLERİ (DİNAMİK ID DESTEKLİ) ---
class TextMessageModel(BaseModel):
    conversation_id: str  # Frontend'den gelecek olan dinamik ID
    message: str
    user_id: str | None = None    # Bu mesajın hangi kayıtlı kullanıcıya ait olduğu
    user_name: str | None = None  # AI'ın kişiye doğru isimle hitap edebilmesi için
    elder_id: str | None = None   # Sohbeti yaşlı profiline bağlamak için

class CheckinModel(BaseModel):
    conversation_id: str  # Sağlık durumu kontrolü de bu oturuma bağlanacak
    mood: str
    elder_id: str | None = None
    user_id: str | None = None

class MedModel(BaseModel):
    med_id: str

class SummaryRequestModel(BaseModel):
    conversation_id: str

class FaceAuthRequest(BaseModel):
    image_data: str 

# Yardımcı Fonksiyon: Base64'ü görüntüye çevirir
def base64_to_image(base64_string):
    try:
        if "," in base64_string:
            base64_string = base64_string.split(",")[1]
        img_bytes = base64.b64decode(base64_string)
        img_np = np.frombuffer(img_bytes, dtype=np.uint8)
        img = cv2.imdecode(img_np, cv2.IMREAD_COLOR)
        rgb_img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        return rgb_img
    except Exception as e:
        raise HTTPException(status_code=400, detail="Fotoğraf verisi işlenemedi.")

def build_system_prompt(user_name: str | None = None):
    display_name = user_name or "karşındaki kişi"
    return (
        "Sen 'Yanımda Al' projesinde yalnız yaşayan yaşlılara destek olan sevecen, "
        f"sabırlı ve neşeli bir dijital refakatçi ajansın. Karşındaki kişi 65 yaş üstü "
        f"{display_name}. Cümlelerin çok uzun olmasın, onun durumunu sor, empati yap ve "
        "onu motive et. Tıbbi teşhis veya tedavi önerisi verme."
    )


def _legacy_text_reply(message: str, user_name: str | None = None) -> str:
    response = groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {"role": "system", "content": build_system_prompt(user_name)},
            {"role": "user", "content": message},
        ],
        max_tokens=150,
        temperature=0.7,
    )
    return response.choices[0].message.content


def _resolve_elder_id_for_chat(user_id: str | None, user_name: str | None) -> str | None:
    if not user_id and not (user_name or "").strip():
        return None
    try:
        from medication import service as medication_service

        elder = medication_service.resolve_elder_for_user(
            user_id or "guest",
            (user_name or "Yakınız").strip(),
        )
        return elder.get("id")
    except Exception as error:
        print(f"[ORCHESTRATOR] elder_id çözülemedi: {error}")
        return user_id


# ==========================================
# 1. YAZILI SOHBET ENDPOINT (DİNAMİK)
# ==========================================
@app.post("/api/text-chat")
async def text_chat(data: TextMessageModel):
    try:
        from orchestrator.graph import is_orchestrator_enabled, run_orchestrator

        if is_orchestrator_enabled():
            elder_id = data.elder_id or _resolve_elder_id_for_chat(data.user_id, data.user_name)
            result = run_orchestrator(
                message=data.message,
                conversation_id=data.conversation_id,
                elder_id=elder_id,
                user_name=data.user_name,
                user_id=data.user_id,
            )
            ai_response = result["ai_response"]
            save_message(
                conversation_id=data.conversation_id,
                role="user",
                content=data.message,
                user_id=data.user_id,
            )
            save_message(
                conversation_id=data.conversation_id,
                role="assistant",
                content=ai_response,
                user_id=data.user_id,
            )
            try:
                from services import activity_service

                activity_service.log_activity_event(
                    event_type="chat",
                    user_id=data.user_id,
                    elder_id=elder_id,
                    meta={"channel": "text"},
                )
            except Exception:
                pass
            return {
                "ai_response": ai_response,
                "intent": result.get("intent"),
                "routed_agent": result.get("routed_agent"),
                "escalation": result.get("escalation", False),
            }

        elder_id = data.elder_id or _resolve_elder_id_for_chat(data.user_id, data.user_name)
        ai_response = _legacy_text_reply(data.message, data.user_name)
        save_message(
            conversation_id=data.conversation_id,
            role="user",
            content=data.message,
            user_id=data.user_id,
            elder_id=elder_id,
        )
        save_message(
            conversation_id=data.conversation_id,
            role="assistant",
            content=ai_response,
            user_id=data.user_id,
            elder_id=elder_id,
        )
        return {"ai_response": ai_response}
    except Exception as e:
        return {"ai_response": f"SİSTEM HATASI BULUNDU: {str(e)}"}

# ==========================================
# 2. SESLİ SOHBET ENDPOINT (DİNAMİK)
# ==========================================
@app.post("/api/voice-chat")
async def voice_chat(
    file: UploadFile = File(...),
    conversation_id: str = Form(...),  # Frontend'den form-data içinde geliyor
    user_id: str = Form(None),
    user_name: str = Form(None),
    elder_id: str = Form(None),
):
    display_name = user_name or "canım"
    try:
        audio_bytes = await file.read()
        if not audio_bytes or len(audio_bytes) < 100:
            return {
                "user_transcription": "Ses algılanamadı.",
                "text": "Ses algılanamadı.",
                "ai_response": f"{display_name}, sesini tam alamadım. Tekrar söyler misin?",
                "response": f"{display_name}, sesini tam alamadım. Tekrar söyler misin?"
            }

        ext = os.path.splitext(file.filename)[1] if file.filename else ".wav"
        if not ext or ext == ".blob": ext = ".wav" 
            
        custom_filename = f"audio{ext}"
        audio_file_like = io.BytesIO(audio_bytes)

        transcription = groq_client.audio.transcriptions.create(
            file=(custom_filename, audio_file_like.read()), 
            model="whisper-large-v3",
            language="tr",
            response_format="json"
        )
        
        user_text = transcription.text

        junk_markers = (
            "altyazı",
            "altyazi",
            "m.k.",
            "subtitle",
            "thanks for watching",
            "thank you for watching",
        )
        cleaned = (user_text or "").strip()
        low = cleaned.lower()
        if (
            not cleaned
            or len(cleaned) < 2
            or any(marker in low for marker in junk_markers)
            or low in {"sessizlik", ".", "..."}
        ):
            user_text = ""
            ai_response = (
                f"{display_name}, sesini net alamadım. "
                "Butona basıp biraz daha net konuşur musun?"
            )
            return {
                "user_transcription": "",
                "text": "",
                "ai_response": ai_response,
                "response": ai_response,
                "message": ai_response,
            }

        if not user_text or user_text.strip() == "":
            user_text = "Sessizlik"
            ai_response = f"{display_name}, ne dediğini tam seçemedim. Tekrar söyler misin?"
            return {
                "user_transcription": user_text,
                "text": user_text,
                "ai_response": ai_response,
                "response": ai_response,
                "message": ai_response,
            }

        from orchestrator.graph import is_orchestrator_enabled, run_orchestrator

        if is_orchestrator_enabled():
            resolved_elder_id = elder_id or _resolve_elder_id_for_chat(user_id, user_name)
            result = run_orchestrator(
                message=user_text,
                conversation_id=conversation_id,
                elder_id=resolved_elder_id,
                user_name=user_name,
                user_id=user_id,
            )
            ai_response = result["ai_response"]
            save_message(
                conversation_id=conversation_id,
                role="user",
                content=user_text,
                user_id=user_id,
                elder_id=resolved_elder_id,
            )
            save_message(
                conversation_id=conversation_id,
                role="assistant",
                content=ai_response,
                user_id=user_id,
                elder_id=resolved_elder_id,
            )
            return {
                "user_transcription": user_text,
                "text": user_text,
                "ai_response": ai_response,
                "response": ai_response,
                "message": ai_response,
                "intent": result.get("intent"),
                "routed_agent": result.get("routed_agent"),
                "escalation": result.get("escalation", False),
            }

        ai_response = _legacy_text_reply(user_text, user_name)
        resolved_elder_id = elder_id or _resolve_elder_id_for_chat(user_id, user_name)
        save_message(
            conversation_id=conversation_id,
            role="user",
            content=user_text,
            user_id=user_id,
            elder_id=resolved_elder_id,
        )
        save_message(
            conversation_id=conversation_id,
            role="assistant",
            content=ai_response,
            user_id=user_id,
            elder_id=resolved_elder_id,
        )

    except Exception as e:
        user_text = "Ses dosyası işlenirken teknik hata oluştu."
        ai_response = f"{display_name}, sesini tam alamadım, iyi misin, her şey yolunda mı?"
    
    return {
        "user_transcription": user_text,
        "text": user_text,
        "ai_response": ai_response,
        "response": ai_response,
        "message": ai_response
    }

# ==========================================
# 3. SOHBET LİSTESİNİ GETİR (KULLANICIYA ÖZEL)
# ==========================================
@app.get("/api/conversations")
async def get_conversations(
    elder_id: str | None = None,
    user_id: str | None = None,
):
    """
    Sohbet geçmişi yalnızca ilgili yaşlıya (elder_id) aittir.
    user_id verilirse users.elder_id üzerinden çözülür.
    Filtre yoksa boş liste döner (tüm kullanıcıların sohbetini sızdırmaz).
    """
    try:
        resolved_elder_id = elder_id
        if not resolved_elder_id and user_id:
            resolved_elder_id = _resolve_elder_id_for_chat(user_id, None)
        if not resolved_elder_id:
            return []
        return list_conversations_for_elder(resolved_elder_id)
    except Exception as e:
        print("!!! CONVERSATIONS HATASI:", str(e))
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/conversations/{conversation_id}")
async def get_chat_history(conversation_id: str):
    try:
        response = supabase.table("messages").select("role", "content").eq("conversation_id", conversation_id).order("created_at", desc=False).execute()
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ==========================================
# 4. GÜNLÜK DURUM (CHECK-IN) ENDPOINTS
# ==========================================
@app.post("/api/checkin")
async def daily_checkin(data: CheckinModel):
    try:
        elder_id = data.elder_id or _resolve_elder_id_for_chat(
            data.user_id or data.conversation_id,
            None,
        )
        save_checkin(
            conversation_id=data.conversation_id,
            mood=data.mood,
            elder_id=elder_id,
        )
        try:
            from services import activity_service

            activity_service.log_activity_event(
                event_type="checkin",
                user_id=data.user_id or data.conversation_id,
                elder_id=elder_id,
                meta={"mood": data.mood},
            )
        except Exception:
            pass
        return {"status": "success", "mood": data.mood}
    except Exception as e:
        print("!!! CHECKIN HATASI:", str(e))
        raise HTTPException(status_code=500, detail="Check-in kaydedilemedi.")

@app.get("/api/checkin/history")
async def checkin_history(conversation_id: str, limit: int = 10):
    try:
        history = get_checkin_history(conversation_id=conversation_id, limit=limit)
        return {"history": history}
    except Exception as e:
        raise HTTPException(status_code=500, detail="Check-in geçmişi alınamadı.")

@app.get("/api/checkin/status")
async def checkin_status(conversation_id: str):
    """
    Check-in eksikliği tespiti: Bugün bu kullanıcı için check-in yapılmış mı?
    Aile tarafı ve Durumum ekranı bu bilgiyi kullanarak uyarı gösterebilir.
    """
    try:
        today_checkin = get_today_checkin_status(conversation_id=conversation_id)
        return {
            "checked_in_today": today_checkin is not None,
            "last_checkin": today_checkin
        }
    except Exception as e:
        print("!!! CHECKIN-STATUS HATASI:", str(e))
        raise HTTPException(status_code=500, detail="Check-in durumu alınamadı.")


class ActivityEventModel(BaseModel):
    event_type: str
    user_id: str | None = None
    elder_id: str | None = None
    meta: dict | None = None


@app.post("/api/activity")
async def post_activity(data: ActivityEventModel):
    """Kiosk etkileşimini activity_events tablosuna yazar."""
    try:
        from services import activity_service

        row = activity_service.log_activity_event(
            event_type=data.event_type,
            user_id=data.user_id,
            elder_id=data.elder_id,
            meta=data.meta or {},
        )
        if not row:
            return {"status": "skipped"}
        return {"status": "success"}
    except Exception as e:
        print("!!! ACTIVITY HATASI:", str(e))
        raise HTTPException(status_code=500, detail="Aktivite kaydedilemedi.")


@app.get("/api/activity/summary")
async def activity_summary(user_id: str | None = None, elder_id: str | None = None):
    try:
        from services import activity_service

        return {
            "status": "success",
            **activity_service.get_activity_summary(user_id=user_id, elder_id=elder_id),
        }
    except Exception as e:
        print("!!! ACTIVITY-SUMMARY HATASI:", str(e))
        raise HTTPException(status_code=500, detail="Aktivite özeti alınamadı.")


@app.post("/api/medication")
async def take_medication(data: MedModel):
    return {"status": "success"}
# İlaç tanıma: backend/medication/router.py

@app.post("/api/family/generate-ai-summary")
async def generate_ai_summary(data: SummaryRequestModel):
    try:
        messages_response = (
            supabase.table("messages")
            .select("role, content")
            .eq("conversation_id", data.conversation_id)
            .order("created_at", desc=True)
            .limit(15)
            .execute()
        )

        if not messages_response.data:
            return {
                "success": True,
                "summary": (
                    "Bugün henüz dijital refakatçi ile bir sohbet gerçekleşmedi. "
                    "Yaşlınızın genel durumu stabil görünüyor."
                ),
            }

        chat_history = list(reversed(messages_response.data))
        formatted_history = ""
        for msg in chat_history:
            sender = "Yaşlı" if msg["role"] == "user" else "Asistan"
            formatted_history += f"{sender}: {msg['content']}\n"

        ai_family_prompt = (
            "Sen 'Yanımda Al' projesinin arka plandaki analiz zekasısın. "
            "Sana yalnız yaşayan bir birey ile dijital refakatçi asistan arasındaki son sohbet geçmişi verilecek. "
            "Bu konuşmaları analiz ederek aileye/refakatçiye ulaştırılacak kısa, samimi ama bilgilendirici bir günlük özet çıkar. "
            "Mod, sağlık veya ilaçlarla ilgili ipuçlarını ve varsa sıkıntıları belirt. "
            "Tıbbi kararlar verme. Maksimum 3-4 cümle olsun."
        )

        response = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": ai_family_prompt},
                {"role": "user", "content": f"Analiz edilecek sohbet geçmişi:\n{formatted_history}"},
            ],
            max_tokens=200,
            temperature=0.5,
        )

        return {"success": True, "summary": response.choices[0].message.content.strip()}
    except Exception as error:
        print(f"[AI ÖZET HATASI]: {error}")
        raise HTTPException(status_code=500, detail="Yapay zeka özeti şu an üretilemedi.") from error

# ==========================================
# 5. YÜZ TANIMA SİSTEMİ (DEEPFACE ENTEGRELİ)
# ==========================================
FACE_ANALYSIS_TIMEOUT_SEC = 90
FACE_MATCH_THRESHOLD = 0.68
VGG_FACE_WEIGHTS_EXPECTED_BYTES = 500_000_000  # ~580MB; eksik dosya bozuk sayılır


def _vgg_weights_path() -> str:
    home = os.path.expanduser("~")
    return os.path.join(home, ".deepface", "weights", "vgg_face_weights.h5")


def _ensure_vgg_face_weights() -> None:
    """Bozuk / yarım indirilmiş VGG-Face ağırlığını silip yeniden indirilmesini sağlar."""
    path = _vgg_weights_path()
    if not os.path.isfile(path):
        return
    size = os.path.getsize(path)
    if size >= VGG_FACE_WEIGHTS_EXPECTED_BYTES:
        return
    print(
        f"!!! Bozuk VGG-Face ağırlığı siliniyor ({size} bayt < {VGG_FACE_WEIGHTS_EXPECTED_BYTES}). "
        "Sonraki istekte yeniden indirilecek (~580MB)."
    )
    try:
        os.remove(path)
    except OSError as err:
        print("!!! Ağırlık silinemedi:", err)


def _extract_face_embedding(rgb_image):
    """Yüz tespiti + hizalama ile embedding; başarısızsa skip fallback."""
    _ensure_vgg_face_weights()
    DeepFace = _get_deepface()
    try:
        embeddings_data = DeepFace.represent(
            img_path=rgb_image,
            model_name="VGG-Face",
            enforce_detection=False,
            detector_backend="opencv",
            align=True,
        )
    except Exception as detect_error:
        print("-> opencv tespit başarısız, skip fallback:", detect_error)
        embeddings_data = DeepFace.represent(
            img_path=rgb_image,
            model_name="VGG-Face",
            enforce_detection=False,
            detector_backend="skip",
            align=False,
        )
    if not embeddings_data:
        raise HTTPException(status_code=400, detail="Fotoğrafta yüz tespit edilemedi!")
    return embeddings_data[0]["embedding"]


def _as_embedding_list(face_vector) -> list:
    """Tek vektör (eski) veya çok açılı liste/{angles/vectors} yapısını listeye çevirir."""
    if face_vector is None:
        return []
    if isinstance(face_vector, list) and face_vector:
        if isinstance(face_vector[0], (int, float)):
            return [face_vector]
        if isinstance(face_vector[0], list):
            return [v for v in face_vector if isinstance(v, list) and v]
    if isinstance(face_vector, dict):
        out: list = []
        for item in face_vector.get("vectors") or []:
            if isinstance(item, list) and item and isinstance(item[0], (int, float)):
                out.append(item)
        angles = face_vector.get("angles") or {}
        if isinstance(angles, dict):
            for item in angles.values():
                if isinstance(item, list) and item and isinstance(item[0], (int, float)):
                    out.append(item)
        return out
    return []


def _face_model_error_detail(error: Exception) -> str:
    message = str(error)
    if "vgg_face_weights" in message.lower() or "pre-trained weights" in message.lower():
        return (
            "Yüz modeli dosyası bozuk veya eksik. Backend konsolunda ağırlık yeniden indirilecek; "
            "birkaç dakika bekleyip tekrar deneyin. (Ad+yaş ile de giriş yapabilirsiniz.)"
        )
    return "Yüz analizi başarısız oldu."


@app.post("/api/auth/register-face")
async def register_face(request: FaceAuthRequest):
    try:
        rgb_image = base64_to_image(request.image_data)
        loop = asyncio.get_running_loop()
        elderly_face_vector = await asyncio.wait_for(
            loop.run_in_executor(None, _extract_face_embedding, rgb_image),
            timeout=FACE_ANALYSIS_TIMEOUT_SEC,
        )
        return {
            "success": True,
            "message": "Yüz imzası başarıyla çıkarıldı.",
            "face_vector": elderly_face_vector,
        }
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail="Yüz analizi zaman aşımına uğradı. Yüz olmadan kayıt olabilirsiniz.",
        )
    except HTTPException:
        raise
    except Exception as e:
        print("!!! REGISTER-FACE HATASI:", str(e))
        raise HTTPException(status_code=400, detail=_face_model_error_detail(e))

@app.post("/api/auth/face-login")
async def face_login(request: FaceAuthRequest):
    try:
        current_rgb_image = base64_to_image(request.image_data)
        loop = asyncio.get_running_loop()
        login_face_encoding = await asyncio.wait_for(
            loop.run_in_executor(None, _extract_face_embedding, current_rgb_image),
            timeout=FACE_ANALYSIS_TIMEOUT_SEC,
        )
        DeepFace = _get_deepface()
        best_user = None
        best_overall = None
        for user in auth_store.list_users_with_faces():
            saved_vectors = _as_embedding_list(user.get("face_vector"))
            if not saved_vectors:
                continue
            best_distance = None
            for saved_face_vector in saved_vectors:
                if len(saved_face_vector) != len(login_face_encoding):
                    continue
                distance = float(
                    DeepFace.verification.find_cosine_distance(
                        login_face_encoding, saved_face_vector
                    )
                )
                if best_distance is None or distance < best_distance:
                    best_distance = distance
            if best_distance is None:
                continue
            print(f"-> {user['name']} için en iyi mesafe: {best_distance} ({len(saved_vectors)} açı)")
            if best_overall is None or best_distance < best_overall:
                best_overall = best_distance
                best_user = user
            if best_distance <= FACE_MATCH_THRESHOLD:
                elder_id = user.get("elder_id")
                if not elder_id:
                    from medication.service import resolve_elder_for_user as resolve_elder
                    elder = resolve_elder(user["id"], user.get("name") or "Yaşlı")
                    elder_id = elder["id"]
                return {
                    "success": True,
                    "message": f"Giriş Başarılı. Hoş geldin {user['name']}",
                    "user_id": user["id"],
                    "name": user["name"],
                    "elder_id": elder_id,
                }
        detail = "Yüz tanınamadı!"
        if best_overall is not None:
            detail = (
                f"Yüz tanınamadı (en yakın mesafe: {best_overall:.3f}, eşik: {FACE_MATCH_THRESHOLD}). "
                "Daha iyi ışıkta tekrar deneyin veya telefon/e-posta ve şifre ile giriş yapın."
            )
        elif not auth_store.list_users_with_faces():
            detail = "Kayıtlı yüz bulunamadı. Telefon veya e-posta ve şifre ile giriş yapabilirsiniz."
        raise HTTPException(status_code=401, detail=detail)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail="Yüz analizi zaman aşımına uğradı. Tekrar deneyin.",
        )
    except HTTPException:
        raise
    except Exception as e:
        print("!!! FACE-LOGIN HATASI:", str(e))
        raise HTTPException(status_code=400, detail=_face_model_error_detail(e))


# ==========================================
# 6. AİLE GİRİŞİ & GENEL KAYIT (EKLENENLER)
# ==========================================

class FamilyLoginModel(BaseModel):
    phone: str | None = None
    email: str | None = None
    password: str

class ElderlyLoginModel(BaseModel):
    phone: str | None = None
    email: str | None = None
    password: str

class FullRegisterModel(BaseModel):
    elderly: dict
    family: dict

@app.post("/api/auth/family-login")
async def family_login(data: FamilyLoginModel):
    try:
        return auth_store.family_login(
            phone=data.phone,
            email=data.email,
            password=data.password,
        )
    except HTTPException:
        raise
    except Exception as e:
        print("!!! FAMILY-LOGIN HATASI:", str(e))
        raise HTTPException(status_code=500, detail="Giriş yapılırken veritabanı hatası oluştu.")


@app.post("/api/auth/elderly-login")
async def elderly_login(data: ElderlyLoginModel):
    try:
        return auth_store.elderly_login(
            phone=data.phone,
            email=data.email,
            password=data.password,
        )
    except HTTPException:
        raise
    except Exception as e:
        print("!!! ELDERLY-LOGIN HATASI:", str(e))
        raise HTTPException(status_code=500, detail="Giriş yapılırken veritabanı hatası oluştu.")

# ==========================================
# 6.b AİLE PANELİ - ÖZET VERİLERİ (EKSİK OLAN VE EKLENEN)
# ==========================================
class SummaryRequestModel(BaseModel):
    conversation_id: str

# Özet + sohbet dökümü: routers/health.py

@app.post("/api/family/generate-ai-summary")
async def generate_ai_summary(data: SummaryRequestModel):
    """Aile paneli günlük AI özeti — user_id veya elder sohbetleri üzerinden."""
    try:
        today_start = datetime.now().strftime("%Y-%m-%dT00:00:00")
        chat_rows = []

        # 1) messages.user_id = elderly users.id (SQL sonrası yeni mesajlar)
        try:
            messages_response = (
                supabase.table("messages")
                .select("role, content")
                .eq("user_id", data.conversation_id)
                .gte("created_at", today_start)
                .order("created_at", desc=True)
                .limit(30)
                .execute()
            )
            chat_rows = messages_response.data or []
        except Exception as user_id_err:
            print("[AI-SUMMARY] user_id sorgusu atlandı:", user_id_err)

        # 2) Fallback: elder → conversations → messages (eski kayıtlar)
        if not chat_rows:
            try:
                from medication import service as medication_service

                elder = medication_service.resolve_elder_for_user(data.conversation_id, "Yakınız")
                elder_id = elder.get("id")
                if elder_id:
                    convs = (
                        supabase.table("conversations")
                        .select("id")
                        .eq("elder_id", elder_id)
                        .order("started_at", desc=True)
                        .limit(20)
                        .execute()
                    )
                    conv_ids = [c["id"] for c in (convs.data or [])]
                    for i in range(0, len(conv_ids), 15):
                        chunk = conv_ids[i : i + 15]
                        res = (
                            supabase.table("messages")
                            .select("role, content, created_at")
                            .in_("conversation_id", chunk)
                            .gte("created_at", today_start)
                            .order("created_at", desc=True)
                            .limit(30)
                            .execute()
                        )
                        chat_rows.extend(res.data or [])
                    chat_rows.sort(key=lambda m: str(m.get("created_at") or ""), reverse=True)
                    chat_rows = chat_rows[:30]
            except Exception as fallback_err:
                print("[AI-SUMMARY] elder fallback atlandı:", fallback_err)

        if not chat_rows:
            return {
                "success": True,
                "summary": (
                    "Bugün henüz dijital refakatçi ile bir sohbet gerçekleşmedi. "
                    "Yaşlınızın genel durumu stabil görünüyor."
                ),
            }

        chat_history = list(reversed(chat_rows))

        elderly_name = "kullanıcı"
        try:
            user_resp = supabase.table("users").select("name").eq("id", data.conversation_id).execute()
            if user_resp.data and user_resp.data[0].get("name"):
                elderly_name = user_resp.data[0]["name"]
        except Exception as name_err:
            print("[İSİM ÇEKME HATASI]:", str(name_err))

        formatted_history = ""
        for msg in chat_history:
            sender = elderly_name if msg["role"] == "user" else "Asistan"
            formatted_history += f"{sender}: {msg['content']}\n"

        ai_family_prompt = (
            "Sen 'Yanımda Al' projesinin arka plandaki analiz zekasısın. "
            f"Sana yalnız yaşayan {elderly_name} ile dijital refakatçi asistan arasındaki son sohbet geçmişi verilecek. "
            f"Bu konuşmaları analiz ederek {elderly_name}'nın ailesine/refakatçisine ulaştırılacak kısa, "
            f"samimi ama bilgilendirici bir günlük özet çıkar. {elderly_name}'nın modunu, sağlığıyla veya "
            "ilaçlarıyla ilgili verdiği ipuçlarını, eğer varsa bir sıkıntısını veya talebini mutlaka belirt. "
            "Tıbbi kararlar verme, doğrudan durumu özetle. Maksimum 3-4 cümle olsun."
        )

        response = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": ai_family_prompt},
                {"role": "user", "content": f"Analiz edilecek sohbet geçmişi:\n{formatted_history}"},
            ],
            max_tokens=200,
            temperature=0.5,
        )

        ai_summary = response.choices[0].message.content.strip()
        return {"success": True, "summary": ai_summary}

    except Exception as e:
        print(f"[AI ÖZET HATASI]: {str(e)}")
        raise HTTPException(status_code=500, detail="Yapay zeka özeti şu an üretilemedi.")


@app.post("/api/auth/register")
async def register_user_and_family(data: FullRegisterModel):
    try:
        elderly = data.elderly or {}
        family = data.family or {}
        age_raw = elderly.get("age")
        age = int(age_raw) if age_raw not in (None, "") else None
        first = str(elderly.get("first_name") or "").strip()
        last = str(elderly.get("last_name") or "").strip()
        elderly_name = str(elderly.get("name") or "").strip() or f"{first} {last}".strip()
        fam_first = str(family.get("first_name") or "").strip()
        fam_last = str(family.get("last_name") or "").strip()
        family_name = str(family.get("name") or "").strip() or f"{fam_first} {fam_last}".strip()
        password = str(family.get("password") or "")
        password_confirm = family.get("password_confirm")
        if password_confirm is not None and str(password_confirm) != password:
            raise HTTPException(status_code=400, detail="Aile şifreleri eşleşmiyor.")
        elderly_password = str(elderly.get("password") or "")
        elderly_password_confirm = elderly.get("password_confirm")
        if elderly_password_confirm is not None and str(elderly_password_confirm) != elderly_password:
            raise HTTPException(status_code=400, detail="Yaşlı şifreleri eşleşmiyor.")
        return auth_store.register_elderly_and_family(
            elderly_name=elderly_name,
            elderly_age=age,
            face_vector=elderly.get("face_vector"),
            family_name=family_name,
            family_phone=str(family.get("phone") or "") or None,
            family_password=password,
            elderly_first_name=first or None,
            elderly_last_name=last or None,
            elderly_birth_date=str(elderly.get("birth_date") or "") or None,
            elderly_phone=str(elderly.get("phone") or "") or None,
            elderly_email=str(elderly.get("email") or "") or None,
            elderly_password=elderly_password or None,
            family_first_name=fam_first or None,
            family_last_name=fam_last or None,
            family_relationship=str(family.get("relationship") or "") or None,
            family_birth_date=str(family.get("birth_date") or "") or None,
            family_email=str(family.get("email") or "") or None,
        )
    except HTTPException:
        raise
    except Exception as e:
        print("!!! REGISTER HATASI:", str(e))
        raise HTTPException(status_code=400, detail=f"Veritabanı kayıt hatası: {str(e)}")


# ==========================================
# 7. YAŞLI İÇİN AD+YAŞ İLE GİRİŞ (B PLANI)
# ==========================================
class CredentialsAuthRequest(BaseModel):
    name: str
    age: int

@app.post("/api/auth/credentials-login")
async def credentials_login(request: CredentialsAuthRequest):
    try:
        return auth_store.credentials_login(name=request.name, age=request.age)
    except HTTPException:
        raise
    except Exception as e:
        print("!!! CREDENTIALS-LOGIN HATASI:", str(e))
        raise HTTPException(status_code=400, detail="Giriş esnasında bir hata oluştu.")


# ==========================================
# 8. PROFİL + SOHBET RESİM
# ==========================================
class ElderProfileModel(BaseModel):
    full_name: str | None = None
    birth_date: str | None = None
    phone: str | None = None
    email: str | None = None
    conditions: str | None = None
    allergies: str | None = None
    height_cm: float | None = None
    weight_kg: float | None = None
    emergency_name: str | None = None
    emergency_phone: str | None = None
    notes: str | None = None
    profile_photo_url: str | None = None


@app.get("/api/elder-profile/{user_id}")
async def get_elder_profile(user_id: str):
    try:
        from database import supabase as sb

        row = (
            sb.table("elder_profiles")
            .select("*")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        profile = (row.data or [None])[0] or {"user_id": user_id}

        # Kullanıcı tablosundan kişisel alanları tamamla
        try:
            user_row = (
                sb.table("users")
                .select("*")
                .eq("id", user_id)
                .limit(1)
                .execute()
            )
            user = (user_row.data or [None])[0] or {}
            name_candidates = [
                user.get("full_name"),
                user.get("name"),
                user.get("display_name"),
            ]
            if not profile.get("full_name"):
                profile["full_name"] = next((v for v in name_candidates if v), None)
            for src, dest in (
                ("birth_date", "birth_date"),
                ("phone", "phone"),
                ("phone_number", "phone"),
                ("email", "email"),
                ("mail", "email"),
            ):
                if not profile.get(dest) and user.get(src):
                    profile[dest] = user.get(src)
        except Exception as user_err:
            print("!!! ELDER-PROFILE user merge:", user_err)

        return {"status": "success", "profile": profile}
    except Exception as e:
        print("!!! ELDER-PROFILE GET:", e)
        return {"status": "success", "profile": {"user_id": user_id}}


@app.put("/api/elder-profile/{user_id}")
async def put_elder_profile(user_id: str, body: ElderProfileModel):
    try:
        from database import supabase as sb

        def _num(value):
            if value is None or value == "":
                return None
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        payload = {
            "user_id": user_id,
            "full_name": (body.full_name or "").strip() or None,
            "birth_date": body.birth_date or None,
            "phone": (body.phone or "").strip(),
            "email": (body.email or "").strip(),
            "conditions": (body.conditions or "").strip(),
            "allergies": (body.allergies or "").strip(),
            "height_cm": _num(body.height_cm),
            "weight_kg": _num(body.weight_kg),
            "emergency_name": (body.emergency_name or "").strip(),
            "emergency_phone": (body.emergency_phone or "").strip(),
            "notes": (body.notes or "").strip(),
            "profile_photo_url": body.profile_photo_url,
            "updated_at": datetime.utcnow().isoformat(),
        }
        if not payload["full_name"]:
            payload.pop("full_name")
        # Boş photo'yu ezmeyelim
        if not payload["profile_photo_url"]:
            payload.pop("profile_photo_url")

        existing = (
            sb.table("elder_profiles")
            .select("id")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            try:
                sb.table("elder_profiles").update(payload).eq("user_id", user_id).execute()
            except Exception:
                # Yeni kolonlar henüz yoksa temel alanlarla kaydet
                basic = {
                    "conditions": payload["conditions"],
                    "emergency_name": payload["emergency_name"],
                    "emergency_phone": payload["emergency_phone"],
                    "notes": payload["notes"],
                    "updated_at": payload["updated_at"],
                }
                sb.table("elder_profiles").update(basic).eq("user_id", user_id).execute()
        else:
            try:
                sb.table("elder_profiles").insert(payload).execute()
            except Exception:
                basic = {
                    "user_id": user_id,
                    "conditions": payload["conditions"],
                    "emergency_name": payload["emergency_name"],
                    "emergency_phone": payload["emergency_phone"],
                    "notes": payload["notes"],
                    "updated_at": payload["updated_at"],
                }
                sb.table("elder_profiles").insert(basic).execute()

        # İsim güncellemesi users tablosuna da yazılsın
        if body.full_name:
            try:
                sb.table("users").update({"full_name": body.full_name.strip(), "name": body.full_name.strip()}).eq("id", user_id).execute()
            except Exception:
                pass

        return {"status": "success", "profile": payload}
    except Exception as e:
        print("!!! ELDER-PROFILE PUT:", e)
        raise HTTPException(
            status_code=400,
            detail="Profil kaydedilemedi. elder_profiles tablosunu oluşturduğunuzdan emin olun.",
        )


@app.post("/api/chat-image")
async def chat_image(
    file: UploadFile = File(...),
    message: str = Form(""),
    conversation_id: str = Form(...),
    user_id: str = Form(None),
    user_name: str = Form(None),
    elder_id: str = Form(None),
):
    """Sohbet görseli + isteğe bağlı mesaj → vision veya metin orkestratörü."""
    display_name = user_name or "canım"
    try:
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="Boş dosya")

        b64 = base64.b64encode(raw).decode("ascii")
        mime = file.content_type or "image/jpeg"
        caption = (message or "").strip()
        user_prompt = caption or "Bu görseli incele ve Türkçe yanıt ver."

        ai_response = None
        try:
            vision = groq_client.chat.completions.create(
                model="meta-llama/llama-4-scout-17b-16e-instruct",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Sen Yanımda Al adlı nazik bir refakatçi asistansın. "
                            "Yaşlı kullanıcıya sade, sıcak ve anlaşılır Türkçe cevap ver. "
                            "Görseli kullanıcının sorusuna göre yorumla; ilaç, yiyecek, "
                            "belge veya genel bir fotoğraf olabilir. "
                            "Kesin tıbbi teşhis koyma; kuşku varsa aileye veya "
                            "eczacıya/doktora danışmasını söyle."
                        ),
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": user_prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:{mime};base64,{b64}"},
                            },
                        ],
                    },
                ],
                max_completion_tokens=400,
            )
            ai_response = vision.choices[0].message.content
        except Exception as vision_err:
            print("!!! CHAT-IMAGE vision:", vision_err)
            from orchestrator.graph import is_orchestrator_enabled, run_orchestrator

            text_fallback = (
                f"{user_prompt} (Kullanıcı bir görsel gönderdi; görsel ayrıntılı "
                "okunamadı. Genel, nazik bir yanıt ver.)"
            )
            if is_orchestrator_enabled():
                resolved = elder_id or _resolve_elder_id_for_chat(user_id, user_name)
                result = run_orchestrator(
                    message=text_fallback,
                    conversation_id=conversation_id,
                    elder_id=resolved,
                    user_name=user_name,
                    user_id=user_id,
                )
                ai_response = result["ai_response"]
            else:
                ai_response = (
                    f"{display_name}, fotoğrafını aldım ama şu an görseli net "
                    "okuyamadım. Ne sormak istediğini yazarsan yardımcı olurum."
                )

        save_message(
            conversation_id=conversation_id,
            role="user",
            content=f"[Fotoğraf] {user_prompt}",
            user_id=user_id,
            elder_id=elder_id,
        )
        save_message(
            conversation_id=conversation_id,
            role="assistant",
            content=ai_response,
            user_id=user_id,
            elder_id=elder_id,
        )
        return {"ai_response": ai_response, "user_message": user_prompt}
    except HTTPException:
        raise
    except Exception as e:
        print("!!! CHAT-IMAGE:", e)
        raise HTTPException(status_code=400, detail=f"Resim işlenemedi: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)