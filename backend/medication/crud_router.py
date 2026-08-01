from fastapi import APIRouter, HTTPException, Query

from medication import service as medication_service
from medication.schemas import (
    CreateMedicationModel,
    MedicationScheduleInput,
    SyncElderModel,
    UpdateMedicationModel,
)

router = APIRouter(prefix="/api/medications", tags=["medication-definitions"])


@router.post("/demo/kiosk")
async def setup_kiosk_demo():
    """Giriş yapmadan ilaç modülünü test etmek için demo veri hazırlar."""
    result = medication_service.setup_kiosk_demo()
    return {"status": "success", **result}


@router.post("/sync-elder")
async def sync_elder(data: SyncElderModel):
    if not data.user_name.strip():
        raise HTTPException(status_code=400, detail="Kullanıcı adı gerekli.")
    elder = medication_service.resolve_elder_for_user(data.user_id, data.user_name)
    return {"status": "success", "elder": elder}


@router.get("/elder/{elder_id}")
async def list_elder_medications(
    elder_id: str,
    today_only: bool = Query(default=False),
):
    medications = medication_service.list_medications(
        elder_id,
        today_only=today_only,
        include_inactive=not today_only,
    )
    return {"status": "success", "medications": medications}


@router.post("")
async def create_medication(data: CreateMedicationModel):
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="İlaç adı zorunludur.")
    if not data.schedules:
        raise HTTPException(status_code=400, detail="En az bir ilaç saati tanımlanmalıdır.")

    schedules = [item.model_dump() for item in data.schedules]
    medication = medication_service.create_medication(
        elder_id=data.elder_id,
        name=data.name,
        dosage=data.dosage,
        form=data.form,
        notes=data.notes,
        schedules=schedules,
    )
    return {"status": "success", "medication": medication}


@router.patch("/{medication_id}")
async def update_medication(medication_id: str, data: UpdateMedicationModel):
    medication = medication_service.get_medication(medication_id)
    if not medication:
        raise HTTPException(status_code=404, detail="İlaç bulunamadı.")

    updated = medication_service.update_medication(
        medication_id=medication_id,
        name=data.name,
        dosage=data.dosage,
        form=data.form,
        notes=data.notes,
        is_active=data.is_active,
    )
    return {"status": "success", "medication": updated}


@router.delete("/{medication_id}")
async def deactivate_medication(medication_id: str):
    medication = medication_service.get_medication(medication_id)
    if not medication:
        raise HTTPException(status_code=404, detail="İlaç bulunamadı.")

    updated = medication_service.deactivate_medication(medication_id)
    return {"status": "success", "medication": updated}


@router.post("/{medication_id}/schedules")
async def add_medication_schedule(medication_id: str, data: MedicationScheduleInput):
    medication = medication_service.get_medication(medication_id)
    if not medication:
        raise HTTPException(status_code=404, detail="İlaç bulunamadı.")

    schedule = medication_service.add_schedule(
        medication_id=medication_id,
        time_of_day=data.time_of_day,
        days_of_week=data.days_of_week,
    )
    return {"status": "success", "schedule": schedule}


@router.delete("/schedules/{schedule_id}")
async def remove_medication_schedule(schedule_id: str):
    medication_service.delete_schedule(schedule_id)
    return {"status": "success"}
