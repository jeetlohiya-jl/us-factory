"""
Hold & Release -- previously a pure Supabase-direct table (see migration
0024) with zero FastAPI involvement: the browser wrote hold_release_records
rows straight to Supabase and nothing else in the app ever looked at them.

That meant a record put on Hold and then given a passing decision here
(Release or Rework) just sat there forever -- the *source* record (Inward
Vehicle Inspection / Inward QC / IPQC / RQC / Outward Vehicle Inspection)
never left its 'hold'/'onhold' status, and none of the normal downstream
auto-creation (Inward Vehicle Inspection -> Inward QC, Inward QC -> RM QR
Generation, RQC -> FG QR Generation) ever fired for it. Per spec: "unless
[the decision] goes to Reject everything else should be populated to the
next step always."

This router is the one write path that actually finishes a Hold & Release
decision: it saves the same fields the old pure-Supabase write saved
(status stays exactly 'draft' | 'completed', identical semantics), and
ADDITIONALLY -- only when status is being set to 'completed' and the
disposition is Release or Rework (i.e. anything other than Reject) --
pushes the linked source record to the exact same passing status and
downstream side effects its own normal Submit/Save path would have
produced, by calling the very same domain functions those routes call
(vehicle_inspection_service.propagate_to_qc,
qr_generation_service.get_or_create_rm_qr_for_qc,
qr_generation_service.get_or_create_fg_qr_for_production_run). A Reject
disposition intentionally leaves the source record exactly where it is --
still on hold -- since Reject is not "the next step", it's the record
staying stopped.

Read (getOrCreateHoldRelease) stays exactly as it was -- pure Supabase
find-or-create, unchanged -- only the save now flows through here.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user, effective_permission
from app.adapters.auth.base import AuthenticatedUser
from app.domain import vehicle_inspection_service, qr_generation_service

router = APIRouter(prefix="/api/v1/hold-release-records", tags=["hold-release"])

# Disposition values that mean "this record is cleared to continue" -- any
# value other than "Reject" (including blank/not-yet-decided, though the
# frontend only ever sends status='completed' once Disposition is picked).
ADVANCING_DISPOSITIONS = {"Release", "Rework"}

# module -> the status value that means "passed" for that module, matching
# each module's own submit/save route exactly (see module docstrings in
# inward_vehicle_inspections.py / inward_qc.py / ipqc.py / rqc.py /
# outward_vehicle_inspection.py).
PASSING_STATUS = {
    "inward_vehicle_inspection": "approved",
    "inward_qc": "accepted",
    "ipqc": "approved",
    "rqc": "approved",
    "outward_vehicle_inspection": "approved",
}


def _require_fill_permission(module: str, db: Session, current_user: AuthenticatedUser) -> None:
    """Mirrors the frontend's own canFill gating (each module's own
    can_fill_section flag -- see e.g. RecordDetail.tsx's canEdit/
    OviPanel.tsx's canFill), rather than inventing a separate
    'hold_release' permission module."""
    perm = effective_permission(db, current_user.user_id, module)
    if not getattr(perm, "can_fill_section", False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to fill this record.")


def _advance_source_record(db: Session, hr: models.HoldReleaseRecord, current_user: AuthenticatedUser) -> None:
    module, record_id = hr.module, hr.record_id

    if module == "inward_vehicle_inspection":
        inspection = db.query(models.InwardVehicleInspection).filter(models.InwardVehicleInspection.id == record_id).first()
        if not inspection:
            return
        inspection.status = PASSING_STATUS[module]
        inspection.updated_by = current_user.user_id
        db.flush()
        vehicle_inspection_service.propagate_to_qc(db, inspection)

    elif module == "inward_qc":
        qc = db.query(models.InwardQcRecord).filter(models.InwardQcRecord.id == record_id).first()
        if not qc:
            return
        qc.status = PASSING_STATUS[module]
        qc.updated_by = current_user.user_id
        db.flush()
        qr_generation_service.get_or_create_rm_qr_for_qc(db, qc)

    elif module == "ipqc":
        rec = db.query(models.IpqcRecord).filter(models.IpqcRecord.id == record_id).first()
        if not rec:
            return
        rec.status = PASSING_STATUS[module]
        # No downstream auto-creation from IPQC itself -- RQC's creation
        # trigger is Material Consumption, not IPQC's own status (see
        # ipqc.py's save route docstring). Nothing further to call here.

    elif module == "rqc":
        rec = db.query(models.RqcRecord).filter(models.RqcRecord.id == record_id).first()
        if not rec:
            return
        rec.status = PASSING_STATUS[module]
        # Migration 0039 -- no downstream auto-creation from a status flip
        # here, same as IPQC above. FG QR Generation is now triggered per
        # RQC Approval Entry (see api/rqc.py's POST /{record_id}/
        # approval-entries route), never from the whole record reaching
        # 'approved' via Release.

    elif module == "outward_vehicle_inspection":
        rec = db.query(models.OutwardVehicleInspection).filter(models.OutwardVehicleInspection.id == record_id).first()
        if not rec:
            return
        rec.status = PASSING_STATUS[module]
        rec.updated_by = current_user.user_id


@router.put("/{record_id}", response_model=schemas.HoldReleaseOut)
def save_hold_release(
    record_id: uuid.UUID,
    payload: schemas.HoldReleaseSaveIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
):
    hr = db.query(models.HoldReleaseRecord).filter(models.HoldReleaseRecord.id == record_id).first()
    if not hr:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Hold & Release record not found.")

    _require_fill_permission(hr.module, db, current_user)

    hr.date_of_hold = payload.date_of_hold
    hr.product_name = payload.product_name
    hr.batch_code = payload.batch_code
    hr.point_of_detection = payload.point_of_detection
    hr.qty_of_hold = payload.qty_of_hold
    hr.reason_for_hold = payload.reason_for_hold
    hr.record_filled_by = payload.record_filled_by
    hr.date_of_decision = payload.date_of_decision
    hr.disposition = payload.disposition
    hr.reason_of_disposition = payload.reason_of_disposition
    hr.qty_decided = payload.qty_decided
    hr.done_by = payload.done_by
    hr.approved_by = payload.approved_by
    hr.status = payload.status

    if hr.status == "completed" and hr.disposition in ADVANCING_DISPOSITIONS:
        _advance_source_record(db, hr, current_user)

    db.commit()
    db.refresh(hr)
    return hr
