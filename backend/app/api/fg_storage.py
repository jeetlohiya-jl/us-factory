import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.domain import storage_service
from app.domain.pallet_serialization import serialize_pallet, serialize_storage_record

router = APIRouter(prefix="/api/v1/fg-storage", tags=["fg-storage"])

MODULE = "fg_storage"
PALLET_TYPE = "fg"
STORAGE_TYPE = "fg"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    perm = db.query(models.ModulePermission).filter(models.ModulePermission.user_id == current_user.user_id, models.ModulePermission.module == MODULE).first()
    if not perm:
        perm = models.ModulePermission(user_id=current_user.user_id, module=MODULE, can_view=True)
    return perm


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


@router.get("/pending", response_model=list[schemas.PalletOut])
def list_pending(
    search: str = Query(""), sku: str = Query(""),
    db: Session = Depends(get_db), _perm=Depends(require("view")),
):
    q = db.query(models.Pallet).filter(models.Pallet.pallet_type == PALLET_TYPE, models.Pallet.lifecycle_status == "pending_storage")
    pallets = q.order_by(models.Pallet.created_at).all()
    if search:
        s = search.lower()
        pallets = [p for p in pallets if s in p.display_id.lower() or s in (p.sku_code_snapshot or "").lower()]
    if sku:
        pallets = [p for p in pallets if p.sku_code_snapshot == sku]
    return [serialize_pallet(p) for p in pallets]


@router.get("/records", response_model=list[schemas.StorageRecordOut])
def list_storage_records(
    search: str = Query(""),
    db: Session = Depends(get_db), _perm=Depends(require("view")),
):
    q = (
        db.query(models.StorageRecord)
        .options(joinedload(models.StorageRecord.pallet), joinedload(models.StorageRecord.location), joinedload(models.StorageRecord.source_qr_generation), joinedload(models.StorageRecord.stored_by_user))
        .filter(models.StorageRecord.storage_type == STORAGE_TYPE)
        .order_by(models.StorageRecord.stored_at.desc())
    )
    recs = q.all()
    if search:
        s = search.lower()
        recs = [r for r in recs if s in r.pallet.display_id.lower() or s in (r.pallet.sku_code_snapshot or "").lower()]
    return [serialize_storage_record(r) for r in recs]


@router.get("/records/{record_id}", response_model=schemas.StorageRecordOut)
def get_storage_record(record_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("view"))):
    rec = (
        db.query(models.StorageRecord)
        .options(joinedload(models.StorageRecord.pallet), joinedload(models.StorageRecord.location), joinedload(models.StorageRecord.source_qr_generation), joinedload(models.StorageRecord.stored_by_user))
        .filter(models.StorageRecord.id == record_id, models.StorageRecord.storage_type == STORAGE_TYPE)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="FG Storage record not found")
    return serialize_storage_record(rec)


class ScanIn(BaseModel):
    payload: str


@router.post("/scan-pallet", response_model=schemas.PalletOut)
def scan_pallet(body: ScanIn, db: Session = Depends(get_db), _perm=Depends(require("create"))):
    try:
        pallet = storage_service.resolve_pallet_for_storage(db, body.payload, PALLET_TYPE)
    except storage_service.StorageValidationError as e:
        raise HTTPException(status_code=422, detail=e.message)
    return serialize_pallet(pallet)


@router.post("/scan-location")
def scan_location(body: ScanIn, db: Session = Depends(get_db), _perm=Depends(require("create"))):
    try:
        location = storage_service.resolve_location_for_storage(db, body.payload)
    except storage_service.StorageValidationError as e:
        raise HTTPException(status_code=422, detail=e.message)
    return {"id": str(location.id), "display_id": location.display_id, "zone": location.zone}


class ConfirmIn(BaseModel):
    pallet_payload: str
    location_payload: str


@router.post("/confirm", response_model=schemas.StorageRecordOut)
def confirm(
    body: ConfirmIn, db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require("create")),
):
    """Both scans are re-resolved and re-validated here, server-side, against
    the live DB — never trusting client-cached identifiers alone — and the
    whole thing commits as one transaction: either both pallet and location
    are saved together, or nothing is."""
    if not body.pallet_payload or not body.location_payload:
        raise HTTPException(status_code=422, detail="Both a pallet scan and a location scan are required before storage can be confirmed.")
    try:
        pallet = storage_service.resolve_pallet_for_storage(db, body.pallet_payload, PALLET_TYPE)
        location = storage_service.resolve_location_for_storage(db, body.location_payload)
        rec = storage_service.confirm_storage(db, pallet, location, STORAGE_TYPE, current_user.user_id)
        db.commit()
    except storage_service.StorageValidationError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    db.refresh(rec)
    return serialize_storage_record(rec)
