"""
IPQC (In-Process Quality Control) -- the transactional half of the hybrid
split. Records themselves are auto-created (never manually) the moment a
Material Consumption record is finalized -- see
material_consumption_service.find_or_create_ipqc -- so there is no
POST/create route here, matching "do not create unnecessary CRUD
endpoints". List/detail reads are Supabase-direct (see frontend/src/lib/
api.ts); this router exists solely for the one atomic save: Shift Incharge
plus the full set of Check Time inspection blocks (each with its fixed
8-defect Failure/Reason grid), matching the prototype's ipqcSaveDraft/
ipqcSave exactly.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser

router = APIRouter(prefix="/api/v1/ipqc-records", tags=["ipqc"])

MODULE = "ipqc"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    # Admin gets full access to every module -- see deps.effective_permission.
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def _serialize_save(rec: models.IpqcRecord) -> schemas.IpqcSaveOut:
    return schemas.IpqcSaveOut(
        id=rec.id, status=rec.status, shift_incharge=rec.shift_incharge,
        blocks=[
            schemas.IpqcCheckBlockOut(
                id=b.id, check_time=b.check_time, overall_result=b.overall_result, sort_order=b.sort_order,
                defects=[
                    schemas.IpqcBlockDefectOut(defect_sr=d.defect_sr, failure=d.failure, reason=d.reason)
                    for d in sorted(b.defects, key=lambda d: d.defect_sr)
                ],
            )
            for b in sorted(rec.check_blocks, key=lambda b: b.sort_order)
        ],
    )


@router.put("/{record_id}", response_model=schemas.IpqcSaveOut)
def save_ipqc_record(
    record_id: uuid.UUID,
    payload: schemas.IpqcSaveIn,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    # Same convention as Inward QC / Inward Vehicle Inspection: the
    # staff-facing "fill in this record" action is gated on
    # can_fill_section, not can_edit (see 0017's migration note).
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    """
    The single transactional write for IPQC: atomically saves Shift
    Incharge and the full set of Check Time blocks (each block's defect
    Failure/Reason grid), replacing the block list wholesale -- same
    semantics as Production's Wastage save, and for the same reason (a
    short repeatable list edited as a whole from one form).

    Status follows the prototype exactly, no invented model:
    - save_mode='draft' -> status='draft' unconditionally (Save Draft).
    - save_mode='final' -> 'hold' if any defect's Failure >= 1 anywhere
      across every block, else 'approved' (Save) -- ipqcOverallStatus().

    Everything else on the record (Shipment Number, Batch Code,
    Manufacturer, Pad Color, Weight, Dimensions, Absorption Rate, SKU/
    Version, the Production/Material Consumption link) is autopopulated at
    creation and read-only -- never touched here, lives entirely in
    Supabase-direct reads.
    """
    rec = (
        db.query(models.IpqcRecord)
        .options(joinedload(models.IpqcRecord.check_blocks).joinedload(models.IpqcCheckBlock.defects))
        .filter(models.IpqcRecord.id == record_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="IPQC record not found.")

    rec.shift_incharge = payload.shift_incharge

    # Replace every block (and its defects, via cascade) wholesale.
    for existing in list(rec.check_blocks):
        db.delete(existing)
    db.flush()

    has_failure = False
    for i, block in enumerate(payload.blocks):
        new_block = models.IpqcCheckBlock(
            ipqc_record_id=rec.id, check_time=block.check_time,
            overall_result=block.overall_result, sort_order=i,
        )
        db.add(new_block)
        db.flush()
        for d in block.defects:
            db.add(models.IpqcBlockDefect(
                block_id=new_block.id, defect_sr=d.defect_sr,
                failure=d.failure, reason=d.reason,
            ))
            if d.failure is not None and d.failure >= 1:
                has_failure = True

    rec.status = "draft" if payload.save_mode == "draft" else ("hold" if has_failure else "approved")

    # NOTE: RQC is NOT auto-created from here. RQC's creation trigger is
    # Material Consumption (see material_consumption_service.finalize,
    # which calls find_or_create_ipqc immediately followed by
    # find_or_create_rqc) -- RQC exists as Pending from the moment Material
    # Consumption is finalized, regardless of this IPQC record's status.
    # This route only ever affects an RQC record that already exists.

    db.commit()
    db.refresh(rec)
    return _serialize_save(rec)
