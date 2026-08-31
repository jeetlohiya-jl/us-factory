"""
Material Consumption — the actual RM pallets an operator physically picked
from RM Storage and consumed for production. Explicit scan-driven selection
only: NEVER FIFO, NEVER auto-assignment. SKU Code, SKU Version, and Category
are never manually entered here -- they come exclusively from the scanned
pallet (the pallet record is the single source of truth), matching the
RM/FG Storage scan-then-resolve-server-side pattern in storage_service.py.

Primary categories consumed into production: 'tray' (Base Tray) and
'fgtray' (FG Non-Padded Tray) -- the same two RM categories the rest of the
app already treats as tray variants (see pallet_service.RM_QR_PREFIX, where
both map to the US-PLT prefix). Pad / Polybag / CFB / Glue are the
*secondary* materials for a Material Consumption record even though they
are ordinary RM pallets of their own, generated and stored exactly the same
way -- so secondary materials are scanned and validated through this same
service, never a free-text fallback.
"""
from decimal import Decimal

from sqlalchemy.orm import Session

from app.db import models
from app.domain import pallet_service

PRIMARY_CATEGORIES = ("tray", "fgtray")
SECONDARY_ROLES = ("cfb", "pad", "glue", "polybag")


class MaterialConsumptionError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _resolve_scanned_pallet(db: Session, raw_scan: str) -> models.Pallet:
    """
    Resolve a scanned QR payload to a pallet, raising a specific,
    operator-facing error for every wrong-QR-type case the task calls out:
    a location QR, an FG pallet QR, or a payload that matches nothing.
    Never trusts the raw scan as fact -- always re-looked-up in the DB.
    """
    pallet = pallet_service.resolve_pallet_from_scan(db, raw_scan, "rm")
    if pallet:
        return pallet
    location = pallet_service.resolve_location_from_scan(db, raw_scan)
    if location:
        raise MaterialConsumptionError("Invalid scan. Please scan an RM pallet QR, not a storage location.")
    fg_pallet = pallet_service.resolve_pallet_from_scan(db, raw_scan, "fg")
    if fg_pallet:
        raise MaterialConsumptionError("Invalid QR. Please scan an RM pallet QR.")
    raise MaterialConsumptionError("Unrecognized QR. Please scan a valid RM pallet QR.")


def _assert_pallet_available(pallet: models.Pallet) -> None:
    if pallet.lifecycle_status == "consumed":
        raise MaterialConsumptionError(f"Pallet {pallet.display_id} has already been consumed and is not available.")
    if pallet.lifecycle_status in ("picked", "shipped"):
        raise MaterialConsumptionError(f"Pallet {pallet.display_id} has already been {pallet.lifecycle_status} and is not available.")
    if pallet.lifecycle_status != "stored":
        raise MaterialConsumptionError(
            f"Pallet {pallet.display_id} is not currently available in RM Storage (status: {pallet.lifecycle_status})."
        )


def _assert_not_already_allocated(db: Session, pallet: models.Pallet, exclude_mc_id=None) -> None:
    """Cross-record check only -- a duplicate scan within the SAME record is
    checked separately (by the caller, before this) so it gets the more
    specific 'already scanned into this record' message instead of this
    generic cross-record one."""
    q = db.query(models.MaterialConsumptionPallet).filter(models.MaterialConsumptionPallet.pallet_id == pallet.id)
    if exclude_mc_id:
        q = q.filter(models.MaterialConsumptionPallet.material_consumption_id != exclude_mc_id)
    row = q.first()
    if row:
        raise MaterialConsumptionError(
            f"Pallet {pallet.display_id} has already been scanned into another Material Consumption record."
        )


def add_primary_pallet(db: Session, mc: models.MaterialConsumption, raw_scan: str) -> models.MaterialConsumptionPallet:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")

    pallet = _resolve_scanned_pallet(db, raw_scan)

    if pallet.category not in PRIMARY_CATEGORIES:
        raise MaterialConsumptionError(
            f"Pallet {pallet.display_id} is category '{pallet.category or 'unknown'}', not a primary Tray pallet. "
            "Use the matching Secondary Material section instead."
        )
    _assert_pallet_available(pallet)
    already_scanned = {p.pallet_id for p in mc.pallets if p.role == "primary"}
    if pallet.id in already_scanned:
        raise MaterialConsumptionError(f"Pallet {pallet.display_id} has already been scanned into this record.")
    _assert_not_already_allocated(db, pallet, exclude_mc_id=mc.id)

    existing_primary = [p for p in mc.pallets if p.role == "primary"]
    if existing_primary:
        first = existing_primary[0]
        if (
            pallet.category != mc.category
            or pallet.sku_code_id != mc.sku_code_id
            or pallet.sku_version_id != mc.sku_version_id
        ):
            raise MaterialConsumptionError(
                "Pallet cannot be added. SKU Code / Version does not match the pallets already selected for this Material Consumption record."
            )
    else:
        # First pallet establishes Category + SKU Code + SKU Version for the whole record.
        mc.category = pallet.category
        mc.sku_code_id = pallet.sku_code_id
        mc.sku_version_id = pallet.sku_version_id
        mc.sku_code_snapshot = pallet.sku_code_snapshot
        mc.sku_version_snapshot = pallet.sku_version_snapshot
        if not mc.start_time:
            import datetime as _dt
            now = _dt.datetime.now()
            mc.start_time = f"{now.hour:02d}:{now.minute:02d}"

    sort_order = len(mc.pallets)
    row = models.MaterialConsumptionPallet(
        material_consumption_id=mc.id, role="primary", pallet_id=pallet.id,
        quantity=Decimal("1"), sort_order=sort_order,
    )
    db.add(row)
    db.flush()
    return row


def add_secondary_pallet(db: Session, mc: models.MaterialConsumption, raw_scan: str, category: str) -> models.MaterialConsumptionPallet:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")
    if category not in SECONDARY_ROLES:
        raise MaterialConsumptionError(f"Unknown secondary material category '{category}'.")

    pallet = _resolve_scanned_pallet(db, raw_scan)

    if pallet.category != category:
        raise MaterialConsumptionError(
            f"Pallet {pallet.display_id} is category '{pallet.category or 'unknown'}', not {category.upper()}."
        )
    _assert_pallet_available(pallet)
    already_scanned = {p.pallet_id for p in mc.pallets if p.role == category}
    if pallet.id in already_scanned:
        raise MaterialConsumptionError(f"Pallet {pallet.display_id} has already been scanned into this record.")
    _assert_not_already_allocated(db, pallet, exclude_mc_id=mc.id)

    sort_order = len(mc.pallets)
    row = models.MaterialConsumptionPallet(
        material_consumption_id=mc.id, role=category, pallet_id=pallet.id,
        quantity=Decimal("1"), sort_order=sort_order,
    )
    db.add(row)
    db.flush()
    return row


def remove_pallet(db: Session, mc: models.MaterialConsumption, row_id) -> None:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")
    row = next((p for p in mc.pallets if p.id == row_id), None)
    if not row:
        raise MaterialConsumptionError("Pallet not found on this record.")
    was_primary = row.role == "primary"
    db.delete(row)
    db.flush()
    # If the removed pallet was the last primary pallet, release the
    # category/SKU lock established by it so a differently-SKU'd pallet can
    # be scanned next -- the record hasn't consumed anything yet (draft).
    remaining_primary = [p for p in mc.pallets if p.role == "primary" and p.id != row_id]
    if was_primary and not remaining_primary:
        mc.category = None
        mc.sku_code_id = None
        mc.sku_version_id = None
        mc.sku_code_snapshot = None
        mc.sku_version_snapshot = None


def set_secondary_quantity(db: Session, mc: models.MaterialConsumption, row_id, quantity: Decimal) -> models.MaterialConsumptionPallet:
    row = next((p for p in mc.pallets if p.id == row_id), None)
    if not row:
        raise MaterialConsumptionError("Pallet not found on this record.")
    if row.role == "primary":
        raise MaterialConsumptionError("Primary pallet quantity is fixed and cannot be edited.")
    row.quantity = quantity
    db.flush()
    return row


def is_blank(mc: models.MaterialConsumption) -> bool:
    return (
        not mc.pallets
        and not mc.machine_id
        and not mc.shift
        and not mc.start_time
        and not mc.end_time
    )


def find_dependent_summary(mc: models.MaterialConsumption) -> str | None:
    """Delete-safety per the task: a record that has already consumed
    pallets / has a Production Run / has an IPQC record must be protected.
    A 'saved' record always has exactly these (see finalize below), so
    status alone is the reliable, cheap guard."""
    if mc.status == "saved":
        return (
            "This Material Consumption record has already consumed pallets and is linked to a "
            "Production Run" + (" and IPQC record" if mc.production_run and mc.production_run.ipqc_record else "")
            + "; it cannot be deleted."
        )
    return None


def _next_run_number(db: Session) -> str:
    count = db.query(models.ProductionRun).count()
    return f"PR-{str(count + 1).zfill(4)}"


def find_or_create_production_run(db: Session, mc: models.MaterialConsumption) -> models.ProductionRun:
    """Idempotent find-or-create keyed by (date, shift) -- NOT machine --
    so multiple Material Consumption records on different machines for the
    same date+shift all attach to the same run."""
    run = (
        db.query(models.ProductionRun)
        .filter(models.ProductionRun.production_date == mc.consumption_date, models.ProductionRun.shift == mc.shift)
        .first()
    )
    if not run:
        run = models.ProductionRun(
            run_number=_next_run_number(db),
            production_date=mc.consumption_date,
            shift=mc.shift,
            category=mc.category or "fgtray",
            sku_code_id=mc.sku_code_id,
            sku_version_id=mc.sku_version_id,
            total_fg_pallets=0,
            status="pending",
        )
        db.add(run)
        db.flush()
    if mc.machine_id:
        has_machine = (
            db.query(models.ProductionRunMachine)
            .filter(models.ProductionRunMachine.production_run_id == run.id, models.ProductionRunMachine.machine_id == mc.machine_id)
            .first()
        )
        if not has_machine:
            db.add(models.ProductionRunMachine(production_run_id=run.id, machine_id=mc.machine_id))
            db.flush()
    return run


def find_or_create_ipqc(db: Session, run: models.ProductionRun, mc: models.MaterialConsumption) -> models.IpqcRecord:
    """One IPQC record per Production Run (unique constraint on
    production_run_id backstops this) -- dedup falls straight out of the
    Production Run being itself found-or-created by (date, shift)."""
    existing = db.query(models.IpqcRecord).filter(models.IpqcRecord.production_run_id == run.id).first()
    if existing:
        return existing
    rec = models.IpqcRecord(
        production_run_id=run.id,
        sku_code_id=mc.sku_code_id, sku_version_id=mc.sku_version_id,
        sku_code_snapshot=mc.sku_code_snapshot, sku_version_snapshot=mc.sku_version_snapshot,
        shift=mc.shift, production_date=mc.consumption_date, status="pending",
    )
    db.add(rec)
    db.flush()
    return rec


def finalize(db: Session, mc: models.MaterialConsumption, actor_user_id=None) -> models.MaterialConsumption:
    """
    Final Save: validate everything first (nothing is written if validation
    fails), then atomically consume every attached pallet, find-or-create
    the Production Run and IPQC record, and mark this record 'saved'.
    Re-validates every pallet's live lifecycle_status inside this same
    transaction (never trusting the scan-time snapshot), exactly like
    storage_service.confirm_storage -- either everything commits, or (on
    any validation failure) the caller rolls back and nothing is consumed.
    """
    primary_pallets = [p for p in mc.pallets if p.role == "primary"]
    if not primary_pallets:
        raise MaterialConsumptionError("Scan at least one RM pallet before saving.")
    if not mc.machine_id:
        raise MaterialConsumptionError("Select a Machine before saving.")
    if not mc.shift:
        raise MaterialConsumptionError("Select a Shift before saving.")
    if not mc.start_time:
        raise MaterialConsumptionError("Enter a Start Time before saving.")

    for row in mc.pallets:
        db.refresh(row.pallet)
        if row.pallet.lifecycle_status != "stored":
            raise MaterialConsumptionError(
                f"Pallet {row.pallet.display_id} is no longer available in RM Storage "
                f"(status: {row.pallet.lifecycle_status}) and cannot be consumed. Remove it and re-scan."
            )

    for row in mc.pallets:
        pallet_service.record_lifecycle_event(
            db, row.pallet, "consumed", actor_user_id=actor_user_id,
            consumed_by_module="material_consumption", consumed_by_record=str(mc.id),
        )

    run = find_or_create_production_run(db, mc)
    find_or_create_ipqc(db, run, mc)
    mc.production_run_id = run.id
    mc.status = "saved"
    mc.updated_by = actor_user_id
    db.flush()
    return mc
