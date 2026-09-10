"""
Outward Vehicle Inspection (OVI) -- auto-created (never manually) the
instant a Customer Shipment is recorded (see customer_shipment_service.
create_customer_shipment -> ovi_service.create_pending_for_shipment), so
there is no POST/create route here, matching the same "do not create
unnecessary CRUD endpoints" convention as ipqc.py/rqc.py. List/detail reads
are Supabase-direct (see frontend/src/lib/api.ts); this router exists
solely for the one atomic save (Step 1 fields + the 7-question checklist +
remarks, status computed server-side -- never trust a client-computed
status) and Admin-only delete.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser
from app.adapters.storage.factory import get_storage_adapter
from app.domain import ovi_service

router = APIRouter(prefix="/api/v1/outward-vehicle-inspections", tags=["outward-vehicle-inspection"])

MODULE = "outward_vehicle_inspection"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    # Admin gets full access to every module -- see deps.effective_permission.
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def _serialize(rec: models.OutwardVehicleInspection) -> schemas.OviSaveOut:
    return schemas.OviSaveOut(
        id=rec.id, status=rec.status,
        truck_number=rec.truck_number, invoice_number=rec.invoice_number,
        transporter_name=rec.transporter_name, seal_number=rec.seal_number,
        quantity=rec.quantity, remarks=rec.remarks,
        answers=[schemas.OviAnswerOut(question_sr=a.question_sr, answer=a.answer) for a in sorted(rec.answers, key=lambda a: a.question_sr)],
    )


@router.put("/{record_id}", response_model=schemas.OviSaveOut)
def save_ovi_record(
    record_id: uuid.UUID,
    payload: schemas.OviSaveIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    # Same convention as IPQC/RQC/Inward Vehicle Inspection: the staff-
    # facing "fill in this record" action is gated on can_fill_section.
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    """
    The single transactional write for OVI: Step 1 fields (Truck, Invoice,
    Transporter, Seal, Quantity) + Step 2's 7-question checklist + Remarks
    -- replacing the answers list wholesale, same pattern as RQC's defect
    grid. Status is computed here, server-side, never trusted from the
    client (see ovi_service.compute_status):
      - save_mode='draft' -> 'draft' unconditionally.
      - save_mode='final' -> 'pending' if any of the 7 required questions
        is unanswered, 'hold' if any answered question is 'not_ok', else
        'approved'.
    Shipment Number and Customer Name are never touched here -- they're
    locked-in snapshots from Customer Shipment, read-only, Supabase-direct.
    """
    rec = (
        db.query(models.OutwardVehicleInspection)
        .options(joinedload(models.OutwardVehicleInspection.answers))
        .filter(models.OutwardVehicleInspection.id == record_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Outward Vehicle Inspection record not found.")

    rec.truck_number = payload.truck_number
    rec.invoice_number = payload.invoice_number
    rec.transporter_name = payload.transporter_name
    rec.seal_number = payload.seal_number
    rec.quantity = payload.quantity
    rec.remarks = payload.remarks
    rec.updated_by = current_user.user_id

    for existing in list(rec.answers):
        db.delete(existing)
    db.flush()

    answers_by_sr: dict[int, str | None] = {}
    for a in payload.answers:
        db.add(models.OutwardVehicleInspectionAnswer(
            inspection_id=rec.id, question_sr=a.question_sr, answer=a.answer,
        ))
        answers_by_sr[a.question_sr] = a.answer

    rec.status = ovi_service.compute_status(payload.save_mode, answers_by_sr)

    db.commit()
    db.refresh(rec)
    return _serialize(rec)


@router.delete("/{record_id}", status_code=204)
def delete_ovi_record(
    record_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require("delete")),
):
    rec = db.query(models.OutwardVehicleInspection).filter(models.OutwardVehicleInspection.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Outward Vehicle Inspection record not found")
    db.delete(rec)
    db.commit()


def _get_with_images_or_404(db: Session, record_id: uuid.UUID) -> models.OutwardVehicleInspection:
    rec = (
        db.query(models.OutwardVehicleInspection)
        .options(joinedload(models.OutwardVehicleInspection.images))
        .filter(models.OutwardVehicleInspection.id == record_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Outward Vehicle Inspection record not found.")
    return rec


def _serialize_images(rec: models.OutwardVehicleInspection) -> list[schemas.OviImageOut]:
    return [schemas.OviImageOut.model_validate(img) for img in rec.images]


@router.post("/{record_id}/images", response_model=list[schemas.OviImageOut])
async def upload_ovi_image(
    record_id: uuid.UUID,
    image_type: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _perm=Depends(require("fill_section")),
):
    """
    One of the 18 fixed loading-photo slots (see OVI_IMAGE_TYPES) -- each
    slot holds at most one photo; uploading again for a slot that already
    has one behaves the same as replace_ovi_image (same storage_path,
    overwritten in place), matching Inward Vehicle Inspection's own single-
    image-field convention. No OCR here -- these are loading-progress
    photos, not identifier images.
    """
    if image_type not in ovi_service.ALL_OVI_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown image_type '{image_type}'.")
    rec = _get_with_images_or_404(db, record_id)
    existing = next((i for i in rec.images if i.image_type == image_type), None)
    content = await file.read()
    storage = get_storage_adapter()

    if existing:
        stored = storage.save(existing.storage_path, content, file.content_type or "application/octet-stream")
        existing.public_url = stored.public_url
    else:
        ext = (file.filename or "upload").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "jpg"
        storage_path = f"{record_id}/{image_type}_{uuid.uuid4().hex[:8]}.{ext}"
        stored = storage.save(storage_path, content, file.content_type or "application/octet-stream")
        sort_order = next((i for i, t in enumerate(ovi_service.OVI_IMAGE_TYPES) if t["key"] == image_type), 0)
        db.add(models.OutwardVehicleInspectionImage(
            inspection_id=record_id, image_type=image_type, storage_path=stored.storage_path,
            public_url=stored.public_url, sort_order=sort_order,
        ))

    db.commit()
    return _serialize_images(_get_with_images_or_404(db, record_id))


@router.put("/{record_id}/images/{image_id}", response_model=list[schemas.OviImageOut])
async def replace_ovi_image(
    record_id: uuid.UUID,
    image_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _perm=Depends(require("fill_section")),
):
    rec = _get_with_images_or_404(db, record_id)
    image_row = next((i for i in rec.images if i.id == image_id), None)
    if not image_row:
        raise HTTPException(status_code=404, detail="Image not found.")
    content = await file.read()
    storage = get_storage_adapter()
    stored = storage.save(image_row.storage_path, content, file.content_type or "application/octet-stream")
    image_row.public_url = stored.public_url
    db.commit()
    return _serialize_images(_get_with_images_or_404(db, record_id))


@router.delete("/{record_id}/images/{image_id}", response_model=list[schemas.OviImageOut])
def delete_ovi_image(
    record_id: uuid.UUID,
    image_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require("fill_section")),
):
    rec = _get_with_images_or_404(db, record_id)
    image_row = next((i for i in rec.images if i.id == image_id), None)
    if not image_row:
        raise HTTPException(status_code=404, detail="Image not found.")
    storage = get_storage_adapter()
    try:
        storage.delete(image_row.storage_path)
    except Exception:
        pass
    db.delete(image_row)
    db.commit()
    return _serialize_images(_get_with_images_or_404(db, record_id))
