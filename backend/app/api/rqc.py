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
        fg_pallets_generated=rec.fg_pallets_generated,
        table_person_number=rec.table_person_number,
        machine_allocations=[
            schemas.RqcMachineAllocationOut(
                machine_id=a.machine_id, machine=a.machine.code if a.machine else None, fg_pallets_count=a.fg_pallets_count,
            )
            for a in rec.machine_allocations
        ],
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


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rqc_record(
    record_id: uuid.UUID,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    _perm: models.ModulePermission = Depends(require("delete")),
):
    """Same shape as customer_shipment.py's delete: a friendly pre-check
    (rqc_service.blocked_delete_reason) surfaces a 409 before what would
    otherwise be a silent orphan -- deleting a record whose approval
    entries already have a GENERATED FG QR batch (real pallets/QR codes)
    would leave those batches alive but permanently unlinked, since
    qr_generation_records.source_rqc_approval_entry_id is ondelete=SET
    NULL, not CASCADE. Everything else (defect_results, coa_observations,
    machine_allocations, approval_entries -- and any still-PENDING batch's
    link, which is fine to lose) cascades cleanly via the model's own
    relationship cascades."""
    rec = db.query(models.RqcRecord).filter(models.RqcRecord.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RQC record not found.")

    reason = rqc_service.blocked_delete_reason(db, rec)
    if reason:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)

    db.delete(rec)
    db.commit()
    return None


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
    Number of FG Pallets Generated, the full defect grid (Found/Remarks per
    defect_sr), the 4 COA observation tables, and Overall Result --
    replacing both child lists wholesale, same semantics as IPQC's
    check-block save.

    Status, no invented model:
    - save_mode='draft' -> status='draft' unconditionally (Save Draft).
    - save_mode='final' -> 'hold' if any defect's Found >= that defect's own
      group reject threshold, else 'approved' (Save) -- rqcOverallStatus().

    Migration 0039: this route no longer touches fg_pallets_generated or
    machine_allocations, and no longer triggers FG QR Generation. Both are
    now owned by the incremental RQC Approval Entries ledger -- see
    rqc_service.create_approval_entry and the POST /{record_id}/
    approval-entries route below. Wholesale-deleting machine_allocations
    here would have destroyed every approval entry's own per-machine split
    on every ordinary form save, since those rows are now entry-scoped
    (rqc_machine_allocations.rqc_approval_entry_id) -- so that block is
    gone entirely, along with the fg_pallets_generated overwrite and the
    FG-QR-generation trigger.

    Everything else on the record (Shipment Number, SKU Code/Version, the
    Production Run / IPQC link) is autopopulated at creation and read-only
    -- never touched here, lives entirely in Supabase-direct reads.
    """
    rec = (
        db.query(models.RqcRecord)
        .options(joinedload(models.RqcRecord.defect_results))
        .options(joinedload(models.RqcRecord.coa_observations))
        .options(joinedload(models.RqcRecord.production_run))
        .options(joinedload(models.RqcRecord.machine_allocations))
        .filter(models.RqcRecord.id == record_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RQC record not found.")

    rec.manufacturer = payload.manufacturer
    rec.overall_result = payload.overall_result

    # Replace only the two child lists this route still owns -- same
    # pattern as IPQC's blocks. Machine allocations are NOT touched here
    # (see docstring above): they belong to individual approval entries.
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

    db.commit()
    db.refresh(rec)
    return _serialize_save(rec)


@router.post("/{record_id}/approval-entries", response_model=schemas.RqcApprovalEntryOut, status_code=status.HTTP_201_CREATED)
def create_rqc_approval_entry(
    record_id: uuid.UUID,
    payload: schemas.RqcApprovalEntryIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    # Same gate as the main save route -- this is the staff-facing "record
    # today's RQC activity" action.
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    """
    Migration 0039 -- records ONE incremental RQC approval activity (task
    sections 2-6): a Date + Operator (the logged-in user) + Approved
    Pallets count, optionally split across machines. Never overwrites a
    prior entry; a shipment can accumulate many of these over time.

    This is always the trigger point for FG QR Generation -- one batch for
    exactly this entry's own approved_pallets, via
    get_or_create_fg_qr_for_rqc_approval_entry (idempotent: a partial
    unique index on source_rqc_approval_entry_id is the hard backstop, so
    retrying the same entry is a safe no-op). A Production Run link is not
    required -- a standalone RQC record (shipment number entered before, or
    without, a matching IPQC record) still gets its FG QR batch from its
    own SKU snapshot/shipment_number; see that function's docstring.
    """
    rec = (
        db.query(models.RqcRecord)
        .options(joinedload(models.RqcRecord.production_run))
        .filter(models.RqcRecord.id == record_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RQC record not found.")

    try:
        entry = rqc_service.create_approval_entry(
            db, rec,
            entry_date=payload.entry_date,
            approved_pallets=payload.approved_pallets,
            operator_user_id=current_user.user_id,
            table_person_number=payload.table_person_number,
            machine_allocations=[(str(a.machine_id), a.fg_pallets_count) for a in payload.machine_allocations],
        )

        batch = qr_generation_service.get_or_create_fg_qr_for_rqc_approval_entry(db, entry)
        fg_qr_batch_id = batch.id

        db.commit()
    except (rqc_service.RqcError, qr_generation_service.QrGenerationError) as e:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))

    db.refresh(entry)
    return _serialize_approval_entry(entry, fg_qr_batch_id=fg_qr_batch_id, fg_pallets_generated=rec.fg_pallets_generated)


@router.post("/{record_id}/approval-entries/{entry_id}/generate-fg-qr", response_model=schemas.RqcApprovalEntryOut)
def generate_fg_qr_for_approval_entry(
    record_id: uuid.UUID,
    entry_id: uuid.UUID,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    """
    2026-09-17 -- a manual retry/backfill for an approval entry that was
    recorded before FG QR Generation could reach it (e.g. an entry created
    when this record had no linked Production Run, back when that was
    required -- it no longer is, see get_or_create_fg_qr_for_rqc_approval_entry).
    Idempotent, same as the automatic trigger in the POST route above: a
    partial unique index on source_rqc_approval_entry_id means calling this
    on an entry that already has a batch just returns that existing batch.
    """
    entry = (
        db.query(models.RqcApprovalEntry)
        .options(joinedload(models.RqcApprovalEntry.machine_allocations))
        .options(joinedload(models.RqcApprovalEntry.rqc_record))
        .filter(models.RqcApprovalEntry.id == entry_id, models.RqcApprovalEntry.rqc_record_id == record_id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RQC approval entry not found.")

    try:
        batch = qr_generation_service.get_or_create_fg_qr_for_rqc_approval_entry(db, entry)
        db.commit()
    except qr_generation_service.QrGenerationError as e:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))

    db.refresh(entry)
    return _serialize_approval_entry(entry, fg_qr_batch_id=batch.id, fg_pallets_generated=entry.rqc_record.fg_pallets_generated)


def _serialize_approval_entry(
    entry: models.RqcApprovalEntry, *, fg_qr_batch_id, fg_pallets_generated,
) -> schemas.RqcApprovalEntryOut:
    return schemas.RqcApprovalEntryOut(
        id=entry.id, entry_date=entry.entry_date, operator_user_id=entry.operator_user_id,
        approved_pallets=entry.approved_pallets, table_person_number=entry.table_person_number,
        machine_allocations=[
            schemas.RqcMachineAllocationOut(
                machine_id=a.machine_id, machine=a.machine.code if a.machine else None, fg_pallets_count=a.fg_pallets_count,
            )
            for a in entry.machine_allocations
        ],
        fg_qr_batch_id=fg_qr_batch_id,
        fg_pallets_generated=fg_pallets_generated,
    )
