"""
RQC (Final Quality Control) -- the quality gate between IPQC and FG QR
Generation. Records are created MANUALLY ONLY, via "+ New Record" (the POST
route below, backed by rqc_service.create_rqc) -- there is no auto-creation
from Material Consumption/IPQC. Shipment Number is the required, unique,
user-entered key used to resolve the Production Run / IPQC link (see
rqc_service.create_rqc). List/detail reads are Supabase-direct (see
frontend/src/lib/api.ts); this router handles the one create route plus the
one atomic save: Manufacturer, the full 15-item defect grid (Found/
Remarks), the 4 COA observation tables, and Overall Result -- and, when
that save results in 'approved', triggering the existing (unchanged) FG QR
Generation find-or-create for this run's Production Run (only possible when
one is actually linked).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser
from app.domain import rqc_service
from app.domain import qr_generation_service

router = APIRouter(prefix="/api/v1/rqc-records", tags=["rqc"])

MODULE = "rqc"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    # Admin gets full access to every module -- see deps.effective_permission.
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def _serialize_save(rec: models.RqcRecord) -> schemas.RqcSaveOut:
    return schemas.RqcSaveOut(
        id=rec.id, status=rec.status, manufacturer=rec.manufacturer, overall_result=rec.overall_result,
        defect_results=[
            schemas.RqcDefectResultOut(defect_sr=d.defect_sr, found=d.found, remarks=d.remarks)
            for d in sorted(rec.defect_results, key=lambda d: d.defect_sr)
        ],
        coa_observations=[
            schemas.RqcCoaObservationOut(coa_group=o.coa_group, sr=o.sr, observation=o.observation)
            for o in sorted(rec.coa_observations, key=lambda o: (o.coa_group, o.sr))
        ],
    )


@router.post("", response_model=schemas.RqcCreateOut, status_code=status.HTTP_201_CREATED)
def create_rqc_record(
    payload: schemas.RqcCreateIn,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    _perm: models.ModulePermission = Depends(require("create")),
):
    """Manual "+ New Record" creation -- see rqc_service.create_rqc for the
    Shipment Number -> IPQC/Production lookup. Cancel on the frontend never
    calls this route at all (no draft is created just by opening the
    panel), so there is nothing to discard on Cancel here."""
    shipment_number = (payload.shipment_number or "").strip()
    if not shipment_number:
        raise HTTPException(status_code=422, detail="Shipment Number is required.")
    try:
        rec = rqc_service.create_rqc(db, shipment_number, payload.manufacturer)
        db.commit()
    except rqc_service.RqcError as e:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except IntegrityError as e:
        db.rollback()
        if "rqc_records_shipment_number_key" in str(e.orig):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f'Shipment Number "{shipment_number}" already exists.')
        raise
    db.refresh(rec)
    return schemas.RqcCreateOut(id=rec.id, shipment_number=rec.shipment_number, status=rec.status)


@router.put("/{record_id}", response_model=schemas.RqcSaveOut)
def save_rqc_record(
    record_id: uuid.UUID,
    payload: schemas.RqcSaveIn,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    # Same convention as IPQC / Inward QC / Inward Vehicle Inspection: the
    # staff-facing "fill in this record" action is gated on
    # can_fill_section, not can_edit.
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    """
    The single transactional write for RQC: atomically saves Manufacturer,
    the full defect grid (Found/Remarks per defect_sr), the 4 COA
    observation tables, and Overall Result -- replacing both child lists
    wholesale, same semantics as IPQC's check-block save.

    Status, no invented model:
    - save_mode='draft' -> status='draft' unconditionally (Save Draft).
    - save_mode='final' -> 'hold' if any defect's Found >= that defect's own
      group reject threshold, else 'approved' (Save) -- rqcOverallStatus().

    When a final save results in 'approved', this is the single trigger
    point for FG QR Generation to auto-populate for this run -- reusing
    get_or_create_fg_qr_for_production_run entirely unchanged, just called
    from here instead of unconditionally from Production's own save route.
    Idempotent either way (partial unique index on source_production_run_id
    is the hard backstop), so re-saving an already-approved RQC record is a
    safe no-op on the FG QR side.

    Everything else on the record (Shipment Number, SKU Code/Version, the
    Production Run / IPQC link, No. of Pallets) is autopopulated at
    creation and read-only -- never touched here, lives entirely in
    Supabase-direct reads.
    """
    rec = (
        db.query(models.RqcRecord)
        .options(joinedload(models.RqcRecord.defect_results))
        .options(joinedload(models.RqcRecord.coa_observations))
        .options(joinedload(models.RqcRecord.production_run))
        .filter(models.RqcRecord.id == record_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RQC record not found.")

    rec.manufacturer = payload.manufacturer
    rec.overall_result = payload.overall_result

    # Replace both child lists wholesale -- same pattern as IPQC's blocks.
    for existing in list(rec.defect_results):
        db.delete(existing)
    for existing in list(rec.coa_observations):
        db.delete(existing)
    db.flush()

    for d in payload.defect_results:
        db.add(models.RqcDefectResult(
            rqc_record_id=rec.id, defect_sr=d.defect_sr, found=d.found, remarks=d.remarks,
        ))
    for o in payload.coa_observations:
        db.add(models.RqcCoaObservation(
            rqc_record_id=rec.id, coa_group=o.coa_group, sr=o.sr, observation=o.observation,
        ))

    rec.status = "draft" if payload.save_mode == "draft" else (
        "hold" if rqc_service.has_any_reject(payload.defect_results) else "approved"
    )

    if rec.status == "approved" and rec.production_run:
        qr_generation_service.get_or_create_fg_qr_for_production_run(db, rec.production_run)

    db.commit()
    db.refresh(rec)
    return _serialize_save(rec)
