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
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser
from app.domain import material_consumption_service as mc_svc
from app.domain import rqc_service
from app.domain.material_consumption_service import MaterialConsumptionError

router = APIRouter(prefix="/api/v1/production-runs", tags=["production-runs"])

MODULE = "production"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    # Admin gets full access to every module -- see deps.effective_permission.
    return deps.effective_permission(db, current_user.user_id, MODULE)


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
    # `page`/`page_size` are optional and default to unbounded (None) --
    # this endpoint doubles as the full dropdown source for FG QR
    # Generation's "Production feeds FG QR Generation" picker
    # (frontend/src/app/fg-qr-generation/page.tsx), which needs every run,
    # not a page of them. Callers that DO want a bounded page (matching the
    # pagination pattern used elsewhere) can pass page=1 to opt in.
    page: int | None = Query(default=None, ge=1),
    page_size: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
):
    # `has_fg_qr` folded into the main query as a correlated EXISTS
    # subquery instead of a second full-table query over
    # qr_generation_records (finding #3 in PERF_AUDIT.md) -- one round trip
    # instead of two.
    has_fg_qr_expr = (
        db.query(models.QrGenerationRecord.id)
        .filter(models.QrGenerationRecord.source_production_run_id == models.ProductionRun.id)
        .exists()
    )
    q = (
        db.query(models.ProductionRun, has_fg_qr_expr.label("has_fg_qr"))
        .options(joinedload(models.ProductionRun.sku_code), joinedload(models.ProductionRun.sku_version))
        .order_by(models.ProductionRun.created_at.desc())
    )
    if page is not None:
        q = q.offset((page - 1) * page_size).limit(page_size)
    out = []
    for run, has_fg_qr in q.all():
        item = _serialize(run)
        item.has_fg_qr = bool(has_fg_qr)
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


def _sum_rejections(run: models.ProductionRun) -> dict:
    # Migration 0038: Rejection Classification now lives per machine entry
    # (own_entry_ids-style traversal, same as save_production_run's own
    # loop below). This aggregate is only for ProductionSaveOut's response
    # shape -- the frontend doesn't actually read these response fields
    # today (it just refetches after a save), but keeping the response
    # contract populated avoids silently returning zeros for existing
    # callers of this route.
    totals = {
        "rejection_damage": Decimal("0"), "rejection_misplaced_glue": Decimal("0"),
        "rejection_misplaced_pad": Decimal("0"), "rejection_glue_on_pad": Decimal("0"),
        "rejection_pad_placement_direction": Decimal("0"), "rejection_adhesion_issue": Decimal("0"),
    }
    for mc in run.material_consumptions:
        for e in mc.machine_entries:
            totals["rejection_damage"] += e.rejection_damage or Decimal("0")
            totals["rejection_misplaced_glue"] += e.rejection_misplaced_glue or Decimal("0")
            totals["rejection_misplaced_pad"] += e.rejection_misplaced_pad or Decimal("0")
            totals["rejection_glue_on_pad"] += e.rejection_glue_on_pad or Decimal("0")
            totals["rejection_pad_placement_direction"] += e.rejection_pad_placement_direction or Decimal("0")
            totals["rejection_adhesion_issue"] += e.rejection_adhesion_issue or Decimal("0")
    return totals


def _serialize_save(run: models.ProductionRun) -> schemas.ProductionSaveOut:
    totals = _sum_rejections(run)
    return schemas.ProductionSaveOut(
        id=run.id, status=run.status, total_fg_pallets=run.total_fg_pallets,
        **totals,
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
    # Same convention as Inward QC / Inward Vehicle Inspection: the
    # staff-facing "fill in this record" action is gated on
    # can_fill_section, not can_edit (see 0017's migration note).
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    """
    The single transactional write for the editable Production feature,
    matching the prototype's prodSaveRecord: atomically saves Rejection
    Classification and the full Wastage list (replaced wholesale, matching
    the prototype's own in-memory array semantics), and advances status
    from 'pending' to 'saved' -- the exact status prodPropagateToFgQr
    checks before a run becomes eligible for FG QR Generation. Idempotent:
    saving an already-saved run just updates the editable fields and leaves
    status as 'saved'.

    Total FG Pallets Generated is NO LONGER collected here (moved to the
    top of the RQC form -- see RqcRecord.fg_pallets_generated / migration
    0030); this route no longer writes production_runs.total_fg_pallets.

    Everything else about a Production record (machines, SKU, Material
    Consumption linkage, the SKU Version's Production Details lookup) is
    read-only and never touched here -- it lives entirely in Supabase-direct
    reads, per the hybrid architecture split.
    """
    run = (
        db.query(models.ProductionRun)
        .options(
            joinedload(models.ProductionRun.wastage_entries),
            joinedload(models.ProductionRun.sku_code),
            joinedload(models.ProductionRun.sku_version),
            joinedload(models.ProductionRun.material_consumptions)
            .joinedload(models.MaterialConsumption.machine_entries)
            .joinedload(models.MaterialConsumptionMachineEntry.pallets)
            .joinedload(models.MaterialConsumptionPallet.pallet),
        )
        .filter(models.ProductionRun.id == run_id)
        .first()
    )
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Production record not found.")

    # NOTE: Rejection Classification is intentionally NOT written onto the
    # flat run.rejection_* columns anymore (migration 0038 moved it to a
    # per-machine-entry column on MaterialConsumptionMachineEntry, see the
    # machine_entry_attributes loop below). payload.rejection_* is still
    # accepted for backward-compatible payload shape but ignored here.
    # NOTE: total_fg_pallets is intentionally NOT written from here anymore
    # (payload.total_fg_pallets is accepted but ignored, kept only for
    # backward-compatible payload shape). "Number of FG Pallets Generated"
    # moved to the top of the RQC form as of migration 0030 -- see
    # RqcRecord.fg_pallets_generated / api/rqc.py's save route. This column
    # is now legacy/display-only.

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

    # Section 12 -- per-machine-entry attribute overrides / new fields.
    # Only ever applies to a machine entry that actually belongs to THIS
    # run (via its Material Consumption records) -- never trusts a
    # machine_entry_id blindly, so one run's save can't reach into
    # another's data.
    own_entry_ids = {e.id for mc in run.material_consumptions for e in mc.machine_entries}
    entries_by_id = {e.id: e for mc in run.material_consumptions for e in mc.machine_entries}
    for attrs in payload.machine_entry_attributes:
        if attrs.machine_entry_id not in own_entry_ids:
            continue
        entry = entries_by_id[attrs.machine_entry_id]
        if attrs.weight is not None:
            entry.override_weight = attrs.weight or None
        if attrs.pcs_per_sleeve is not None:
            entry.override_pcs_per_sleeve = attrs.pcs_per_sleeve or None
        if attrs.sleeve_per_case is not None:
            entry.override_sleeve_per_case = attrs.sleeve_per_case or None
        if attrs.total_pcs_per_pallet is not None:
            entry.override_total_pcs_per_pallet = attrs.total_pcs_per_pallet or None
        if attrs.pad_type is not None:
            entry.override_pad_type = attrs.pad_type or None
        if attrs.pad_color is not None:
            entry.override_pad_color = attrs.pad_color or None
        if attrs.case_type is not None:
            entry.override_case_type = attrs.case_type or None
        if attrs.machine_no is not None:
            entry.machine_no = attrs.machine_no or None
        if attrs.auto_padding is not None:
            entry.auto_padding = attrs.auto_padding or None
        if attrs.container_order_no is not None:
            entry.container_order_no = attrs.container_order_no or None
        # Rejection Classification (migration 0038) -- unlike the override
        # fields above, an empty value means 0, not "fall back to a shared
        # reference value" (there is none for a rejection count).
        if attrs.rejection_damage is not None:
            entry.rejection_damage = Decimal(attrs.rejection_damage or "0")
        if attrs.rejection_misplaced_glue is not None:
            entry.rejection_misplaced_glue = Decimal(attrs.rejection_misplaced_glue or "0")
        if attrs.rejection_misplaced_pad is not None:
            entry.rejection_misplaced_pad = Decimal(attrs.rejection_misplaced_pad or "0")
        if attrs.rejection_glue_on_pad is not None:
            entry.rejection_glue_on_pad = Decimal(attrs.rejection_glue_on_pad or "0")
        if attrs.rejection_pad_placement_direction is not None:
            entry.rejection_pad_placement_direction = Decimal(attrs.rejection_pad_placement_direction or "0")
        if attrs.rejection_adhesion_issue is not None:
            entry.rejection_adhesion_issue = Decimal(attrs.rejection_adhesion_issue or "0")
        # Pallets Produced (migration 0039, task section 1) -- same
        # empty-means-0 convention as the rejection_* fields above.
        if attrs.pallets_produced is not None:
            entry.pallets_produced = int(Decimal(attrs.pallets_produced or "0"))

    if run.status == "pending":
        run.status = "saved"

    # Per explicit direction: saving this record IS the end of work for
    # every machine that fed it -- stamp end_time on every not-yet-ended
    # Material Consumption machine entry linked to this run instead of
    # requiring a separate manual "Record End Time" step there. Runs every
    # save (not just the pending->saved transition) so a machine that
    # started after the run was first saved still gets its end_time.
    mc_svc.stamp_end_times_for_production_run(db, run, client_time=payload.client_time)
    # Filling in Production also makes sure its Pending RQC exists (runs
    # created before RQC was auto-created get theirs here).
    for linked_mc in db.query(models.MaterialConsumption).filter(models.MaterialConsumption.production_run_id == run.id):
        if rqc_service.ensure_pending_rqc_for_run(db, run, mc_svc._derive_shipment_number(linked_mc)) is not None:
            break

    # 2026-09-24 -- item 7 of the operator feedback batch: saving Production
    # (which is what asks, via ConsumptionConfirmModal, whether each picked
    # pallet was fully consumed) should be the point a still-'draft' linked
    # Material Consumption record actually becomes 'saved', instead of
    # silently staying 'draft' forever. end_time was just stamped above, so
    # finalize()'s own "save the Production Run first" check is now
    # satisfied. Runs every save (idempotent -- finalize() is a no-op
    # target only for 'draft' records; an already-'saved' MC record is
    # skipped) so a machine consumption added after the run's first save
    # still gets finalized on a later save. A validation failure here
    # aborts the whole Production save (nothing has been committed yet)
    # rather than leaving Production 'saved' with its Material Consumption
    # silently stuck in 'draft'.
    for mc in run.material_consumptions:
        if mc.status == "draft":
            try:
                mc_svc.finalize(db, mc, actor_user_id=uuid.UUID(current_user.user_id))
            except MaterialConsumptionError as e:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    # NOTE: FG QR Generation is intentionally NOT triggered from here.
    # Saving Total FG Pallets Generated only records Production's own
    # output -- it is not the same as that output passing final QC. FG QR
    # Generation is now gated on RQC (the quality gate between IPQC and FG
    # QR Generation) reaching 'approved' -- see api/rqc.py's save route,
    # which calls the same get_or_create_fg_qr_for_production_run that used
    # to be called unconditionally here. (RQC's own record is created much
    # earlier -- the moment Material Consumption is finalized, see
    # rqc_service.find_or_create_rqc -- but it only reaches 'approved',
    # and only then triggers FG QR Generation, once its own inspection is
    # completed and saved.)

    # Records who actually filled in and saved this record's editable
    # fields -- every save re-stamps this, not just the first, so the
    # record always reflects whoever most recently completed it.
    run.completed_by = uuid.UUID(current_user.user_id)
    run.completed_at = datetime.utcnow()

    db.commit()
    db.refresh(run)
    return _serialize_save(run)


@router.delete("/{run_id}", status_code=204)
def delete_production_run(run_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("delete"))):
    """Delete a Production Run nothing depends on any more.

    A run is created automatically by Raw Material Consumption (the first
    scanned pallet), so it can only go once:
      - no RM Consumption record uses it (its scanned pallets ARE this run's
        consumption -- delete / correct that record first), and
      - no RQC record, FG QR batch or FG pallet comes from it.
    Its IPQC record (and that IPQC's inspection data / Hold & Release) is
    part of the run and is removed with it."""
    run = db.query(models.ProductionRun).filter(models.ProductionRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Production Run not found")

    mcs = db.query(models.MaterialConsumption.id).filter(models.MaterialConsumption.production_run_id == run.id).count()
    if mcs:
        raise HTTPException(
            status_code=409,
            detail=f"{run.run_number} is used by {mcs} RM Consumption record{'s' if mcs != 1 else ''}. "
                   "Delete or correct those first, then delete this Production record.",
        )
    rqcs = db.query(models.RqcRecord).filter(models.RqcRecord.production_run_id == run.id).all()
    if any(not rqc_service.is_untouched_auto_rqc(db, r) for r in rqcs):
        raise HTTPException(status_code=409, detail=f"{run.run_number} has RQC records with inspection data. Delete them first, then delete this Production record.")
    for r in rqcs:  # its untouched Pending RQC goes with it
        db.query(models.HoldReleaseRecord).filter(models.HoldReleaseRecord.module == "rqc", models.HoldReleaseRecord.record_id == r.id).delete(synchronize_session=False)
        db.delete(r)
    db.flush()  # the RQC rows reference the IPQC removed below
    if (
        db.query(models.QrGenerationRecord.id).filter(models.QrGenerationRecord.source_production_run_id == run.id).first()
        or db.query(models.Pallet.id).filter(models.Pallet.source_production_run_id == run.id).first()
    ):
        raise HTTPException(status_code=409, detail=f"FG QR codes already exist for {run.run_number}, so it can't be deleted.")

    ipqc_ids = [i.id for i in db.query(models.IpqcRecord.id).filter(models.IpqcRecord.production_run_id == run.id)]
    if ipqc_ids:
        db.query(models.HoldReleaseRecord).filter(
            models.HoldReleaseRecord.module == "ipqc", models.HoldReleaseRecord.record_id.in_(ipqc_ids)
        ).delete(synchronize_session=False)
        db.query(models.IpqcRecord).filter(models.IpqcRecord.id.in_(ipqc_ids)).delete(synchronize_session=False)
    db.delete(run)  # machines / wastage rows cascade (ON DELETE CASCADE)
    db.commit()
    return None
