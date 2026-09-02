import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.domain import qr_generation_service
from app.domain.pallet_serialization import serialize_qr_list_item, serialize_qr_detail

router = APIRouter(prefix="/api/v1/fg-qr", tags=["fg-qr"])

MODULE = "fg_qr_generation"


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


def _get_or_404(db: Session, rec_id: uuid.UUID) -> models.QrGenerationRecord:
    rec = (
        db.query(models.QrGenerationRecord)
        .options(joinedload(models.QrGenerationRecord.pallets).joinedload(models.Pallet.current_location))
        .options(joinedload(models.QrGenerationRecord.pallets).joinedload(models.Pallet.storage_record))
        .options(joinedload(models.QrGenerationRecord.source_production_run))
        .filter(models.QrGenerationRecord.id == rec_id, models.QrGenerationRecord.qr_type == "fg")
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="FG QR Generation record not found")
    return rec


@router.get("", response_model=list[schemas.QrGenerationListItemOut])
def list_fg_qr(
    search: str = Query(""), date: str = Query(""), sku: str = Query(""),
    db: Session = Depends(get_db), _perm=Depends(require("view")),
):
    q = db.query(models.QrGenerationRecord).filter(models.QrGenerationRecord.qr_type == "fg")
    if search:
        like = f"%{search.lower()}%"
        q = q.filter((models.QrGenerationRecord.shipment_number.ilike(like)) | (models.QrGenerationRecord.sku_code_snapshot.ilike(like)))
    q = q.order_by(models.QrGenerationRecord.created_at.desc())
    recs = q.all()
    if date:
        recs = [r for r in recs if r.created_at.date().isoformat() == date]
    if sku:
        recs = [r for r in recs if sku.lower() in (r.sku_code_snapshot or "").lower()]
    return [serialize_qr_list_item(r) for r in recs]


@router.get("/{rec_id}", response_model=schemas.QrGenerationDetailOut)
def get_fg_qr(rec_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("view"))):
    return serialize_qr_detail(_get_or_404(db, rec_id))


@router.post("/{rec_id}/generate", response_model=schemas.QrGenerationDetailOut)
def generate_fg_qr(
    rec_id: uuid.UUID, db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require("edit")),
):
    rec = _get_or_404(db, rec_id)
    try:
        qr_generation_service.generate_pallets(db, rec, actor_user_id=current_user.user_id)
    except qr_generation_service.QrGenerationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    db.commit()
    return serialize_qr_detail(_get_or_404(db, rec_id))


@router.delete("/{rec_id}")
def delete_fg_qr(rec_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("delete"))):
    rec = _get_or_404(db, rec_id)
    if rec.pallets:
        raise HTTPException(
            status_code=409,
            detail="This FG QR record has generated pallets already in storage, picking, or shipment and cannot be deleted.",
        )
    db.delete(rec)
    db.commit()
    return {"ok": True}


@router.post("/from-production-run/{run_id}", response_model=schemas.QrGenerationDetailOut, status_code=201)
def create_fg_qr_from_run(
    run_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("create")),
):
    """Auto-creates (find-or-create, never duplicated) the FG QR Generation
    record for an approved Production Run — the FG equivalent of an approved
    Inward QC auto-creating its RM QR Generation record. A real Production
    module would call this the moment a run is approved; here it is exposed
    directly since the Production module itself is out of scope."""
    run = db.query(models.ProductionRun).filter(models.ProductionRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Production Run not found")
    # 'saved' is the status prodSaveRecord actually sets once a user
    # completes a Production record's editable fields (Rejection
    # Classification / Wastage / FG Pallets); 'approved' is kept for
    # backward compatibility with pre-existing dev/test data.
    if run.status not in ("saved", "approved"):
        raise HTTPException(status_code=422, detail="Only a saved/completed Production Run can feed FG QR Generation.")
    rec = qr_generation_service.get_or_create_fg_qr_for_production_run(db, run)
    db.commit()
    return serialize_qr_detail(_get_or_404(db, rec.id))
