"""
Minimal Production Run listing — added strictly to give FG QR Generation a
real upstream source to auto-populate from (see the note in
migrations/0003_rm_fg_qr_storage.sql and app/db/models.py:ProductionRun).
The full Production/IPQC/Material Allocation modules are out of scope here;
this is intentionally just enough to drive "Production feeds FG QR
Generation" for approved runs, exactly as an approved Inward QC feeds RM QR
Generation.
"""
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser

router = APIRouter(prefix="/api/v1/production-runs", tags=["production-runs"])

MODULE = "production"


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


def _serialize(run: models.ProductionRun) -> schemas.ProductionRunOut:
    return schemas.ProductionRunOut(
        id=run.id, run_number=run.run_number, shipment_number=run.shipment_number,
        sku_code=run.sku_code.code if run.sku_code else None,
        sku_version=run.sku_version.version if run.sku_version else None,
        category=run.category, total_fg_pallets=run.total_fg_pallets, status=run.status,
    )


@router.get("", response_model=list[schemas.ProductionRunOut])
def list_production_runs(
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
):
    runs = (
        db.query(models.ProductionRun)
        .options(joinedload(models.ProductionRun.sku_code), joinedload(models.ProductionRun.sku_version))
        .order_by(models.ProductionRun.created_at.desc())
        .all()
    )
    fg_qr_run_ids = {
        r.source_production_run_id
        for r in db.query(models.QrGenerationRecord.source_production_run_id)
        .filter(models.QrGenerationRecord.source_production_run_id.isnot(None))
        .all()
    }
    out = []
    for run in runs:
        item = _serialize(run)
        item.has_fg_qr = run.id in fg_qr_run_ids
        out.append(item)
    return out


@router.post("", response_model=schemas.ProductionRunOut, status_code=201)
def create_production_run(
    run_number: str, sku_code_id: uuid.UUID, sku_version_id: uuid.UUID | None = None,
    shipment_number: str | None = None, total_fg_pallets: int = 0, shift: str | None = None,
    category: str = "fgtray", status_: str = "approved",
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
):
    """Dev/test-only creation endpoint — a real Production module would own
    this. Kept intentionally bare-bones since it is out of scope here."""
    run = models.ProductionRun(
        run_number=run_number, sku_code_id=sku_code_id, sku_version_id=sku_version_id,
        shipment_number=shipment_number, total_fg_pallets=total_fg_pallets, shift=shift,
        category=category, status=status_, created_by=current_user.user_id,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return _serialize(run)


def _serialize_save(run: models.ProductionRun) -> schemas.ProductionSaveOut:
    return schemas.ProductionSaveOut(
        id=run.id, status=run.status, total_fg_pallets=run.total_fg_pallets,
        rejection_damage=run.rejection_damage,
        rejection_misplaced_glue=run.rejection_misplaced_glue,
        rejection_misplaced_pad=run.rejection_misplaced_pad,
        rejection_glue_on_pad=run.rejection_glue_on_pad,
        rejection_pad_placement_direction=run.rejection_pad_placement_direction,
        rejection_adhesion_issue=run.rejection_adhesion_issue,
        wastage_entries=[
            schemas.ProductionWastageEntryOut(
                id=w.id, machine_id=w.machine_id, trays=w.trays, reason=w.reason, sort_order=w.sort_order,
            )
            for w in sorted(run.wastage_entries, key=lambda w: w.sort_order)
        ],
    )


@router.put("/{run_id}", response_model=schemas.ProductionSaveOut)
def save_production_run(
    run_id: uuid.UUID,
    payload: schemas.ProductionSaveIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm: models.ModulePermission = Depends(require("edit")),
):
    """
    The single transactional write for the editable Production feature,
    matching the prototype's prodSaveRecord: atomically saves Rejection
    Classification, Total FG Pallets Generated and the full Wastage list
    (replaced wholesale, matching the prototype's own in-memory array
    semantics), and advances status from 'pending' to 'saved' -- the exact
    status prodPropagateToFgQr checks before a run becomes eligible for FG
    QR Generation. Idempotent: saving an already-saved run just updates the
    editable fields and leaves status as 'saved'.

    Everything else about a Production record (machines, SKU, Material
    Consumption linkage, the SKU Version's Production Details lookup) is
    read-only and never touched here -- it lives entirely in Supabase-direct
    reads, per the hybrid architecture split.
    """
    run = (
        db.query(models.ProductionRun)
        .options(joinedload(models.ProductionRun.wastage_entries))
        .filter(models.ProductionRun.id == run_id)
        .first()
    )
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Production record not found.")

    run.rejection_damage = payload.rejection_damage
    run.rejection_misplaced_glue = payload.rejection_misplaced_glue
    run.rejection_misplaced_pad = payload.rejection_misplaced_pad
    run.rejection_glue_on_pad = payload.rejection_glue_on_pad
    run.rejection_pad_placement_direction = payload.rejection_pad_placement_direction
    run.rejection_adhesion_issue = payload.rejection_adhesion_issue
    run.total_fg_pallets = payload.total_fg_pallets

    # Replace the wastage list wholesale -- simplest, safest semantics for a
    # short repeatable list edited as a whole from one form (add/remove rows
    # freely, save once), and it sidesteps having to diff prior entries.
    for existing in list(run.wastage_entries):
        db.delete(existing)
    db.flush()
    for i, entry in enumerate(payload.wastage_entries):
        db.add(models.ProductionWastageEntry(
            production_run_id=run.id, machine_id=entry.machine_id,
            trays=entry.trays, reason=entry.reason, sort_order=i,
        ))

    if run.status == "pending":
        run.status = "saved"

    # Records who actually filled in and saved this record's editable
    # fields -- every save re-stamps this, not just the first, so the
    # record always reflects whoever most recently completed it.
    run.completed_by = uuid.UUID(current_user.user_id)
    run.completed_at = datetime.utcnow()

    db.commit()
    db.refresh(run)
    return _serialize_save(run)
