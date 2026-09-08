"""
RQC (Final Quality Control) -- the quality gate between IPQC and FG QR
Generation. Records are auto-created (never manually) the moment the
relevant Material Consumption record is finalized -- see
rqc_service.find_or_create_rqc, called from
material_consumption_service.finalize() immediately after
find_or_create_ipqc -- so there is no POST/create route here, matching "do
not create unnecessary CRUD endpoints" (same convention as ipqc.py). RQC's
creation is independent of IPQC's status: it exists as Pending from the
moment Material Consumption is saved and only becomes Approved/Hold via
this router's own save route, once its own inspection requirements are
completed. List/detail reads are
Supabase-direct (see frontend/src/lib/api.ts); this router exists solely
for the one atomic save: Manufacturer, the full 15-item defect grid
(Found/Remarks), the 4 COA observation tables, and Overall Result -- and,
when that save results in 'approved', triggering the existing (unchanged)
FG QR Generation find-or-create for this run's Production Run -- the exact
mechanism that used to run unconditionally from Production's own save
route, now correctly gated on RQC instead.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.domain import rqc_service
from app.domain import qr_generation_service

router = APIRouter(prefix="/api/v1/rqc-records", tags=["rqc"])

MODULE = "rqc"


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
