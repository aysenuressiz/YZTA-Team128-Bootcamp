from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from typing import Optional

from pydantic import BaseModel

from medication.health_agent import (
    evaluate_recognition,
    record_manual_taken,
    record_snooze,
)
from medication.recognition import recognize_medication_from_image
from medication.schemas import MedicationRecognitionResponse
from medication import service as medication_service

router = APIRouter(prefix="/api/medication", tags=["medication"])


class AlertStatusUpdate(BaseModel):
    status: str  # acknowledged | resolved | open | closed
    acknowledged_by: str | None = None


@router.post("/recognize", response_model=MedicationRecognitionResponse)
async def recognize_medication(
    file: UploadFile = File(...),
    expected_name: str | None = Form(None),
    medication_id: str | None = Form(None),
    schedule_id: str | None = Form(None),
):
    try:
        image_bytes = await file.read()
        result = recognize_medication_from_image(image_bytes, expected_name=expected_name)

        agent_result = None
        if medication_id and expected_name:
            agent_result = evaluate_recognition(
                medication_id=medication_id,
                schedule_id=schedule_id,
                recognized_name=result.get("recognized_med", ""),
                expected_name=expected_name,
                is_match=result.get("is_match"),
            )
            result["agent_decision"] = agent_result.get("decision")
            result["message"] = agent_result.get("message", result.get("message"))

        return {"status": "success", **result}
    except Exception as error:
        print(f"[ILAC TANIMA HATASI] {error}")
        raise HTTPException(
            status_code=500,
            detail="İlaç fotoğrafı analiz edilemedi. Lütfen tekrar deneyin.",
        ) from error


@router.post("/log")
async def log_medication(
    medication_id: str = Form(...),
    status: str = Form(...),
    confirmed_method: str = Form("button"),
    schedule_id: Optional[str] = Form(None),
):
    """Tablet üzerinden gelen ilaç sonuçlarını medication_logs tablosuna kaydeder."""
    try:
        if status == "taken":
            result = record_manual_taken(medication_id, schedule_id, confirmed_method)
        elif status == "snoozed":
            result = record_snooze(medication_id, schedule_id)
        else:
            log = medication_service.create_medication_log(
                medication_id=medication_id,
                schedule_id=schedule_id,
                status=status,
                confirmation_method=confirmed_method,
            )
            result = {"decision": status, "log": log}

        return {"status": "success", "data": result}
    except Exception as error:
        print(f"[LOG HATASI] {error}")
        raise HTTPException(status_code=500, detail="Log kaydedilemedi.") from error


@router.get("/stats/{elder_id}")
def get_medication_stats(
    elder_id: str,
    days: int = Query(default=7, ge=1, le=90),
):
    """Aile paneli için ilaç uyum istatistikleri (per-med + dönem)."""
    try:
        return medication_service.get_medication_stats(elder_id, days=days)
    except Exception as error:
        print(f"[STATS HATASI] {error}")
        raise HTTPException(status_code=500, detail="İstatistikler alınamadı.") from error


@router.get("/alerts/{elder_id}")
def get_medication_alerts(
    elder_id: str,
    limit: int = Query(default=40, ge=1, le=100),
    open_only: bool = Query(default=False),
):
    """Aile paneli için eskalasyon uyarıları."""
    alerts = medication_service.get_elder_alerts(
        elder_id, limit=limit, open_only=open_only
    )
    open_count = medication_service.count_open_alerts(elder_id)
    return {
        "status": "success",
        "alerts": alerts,
        "open_count": open_count,
    }


@router.patch("/alerts/{alert_id}")
def patch_alert_status(alert_id: str, data: AlertStatusUpdate):
    """Uyarıyı görüldü / çözüldü işaretle."""
    try:
        row = medication_service.update_alert_status(
            alert_id,
            data.status,
            acknowledged_by=data.acknowledged_by,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Uyarı bulunamadı.")
        return {"status": "success", "alert": row}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except HTTPException:
        raise
    except Exception as error:
        print(f"[ALERT PATCH] {error}")
        raise HTTPException(status_code=500, detail="Uyarı güncellenemedi.") from error


@router.get("/history/{elder_id}")
def get_medication_history(elder_id: str, limit: int = 30):
    """Aile paneli geçmiş tablosu için birleşik olay geçmişi."""
    events = medication_service.get_elder_event_history(elder_id, limit=limit)
    return {"status": "success", "events": events}
