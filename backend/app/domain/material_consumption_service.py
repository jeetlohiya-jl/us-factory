"""
Material Consumption — the actual RM pallets an operator physically picked
from RM Storage and consumed for production. Explicit scan-driven selection
only: NEVER FIFO, NEVER auto-assignment. SKU Code, SKU Version, and Category
are never manually entered here -- they come exclusively from the scanned
pallet (the pallet record is the single source of truth), matching the
RM/FG Storage scan-then-resolve-server-side pattern in storage_service.py.

One record spans one or more MACHINES (MaterialConsumptionMachineEntry) --
each machine has its own pallet set, its own Category/SKU/SKU Version, and
its own start_time/end_time. Shift is shared across the whole record.

Primary categories consumed into production: 'tray' (Base Tray) and
'fgtray' (FG Non-Padded Tray) -- the same two RM categories the rest of the
app already treats as tray variants (see pallet_service.CATEGORY_SUFFIX,
where both map to the "PLT" suffix). Pad / Polybag / CFB / Glue are the
*secondary* materials for a machine entry even though they are ordinary RM
pallets of their own, generated and stored exactly the same way -- so
secondary materials are scanned and validated through this same service,
never a free-text fallback.
"""
from decimal import Decimal

from sqlalchemy.orm import Session

from app.db import models
from app.domain import pallet_service
from app.domain.id_counters import next_seq

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
    """Cross-record check only -- a duplicate scan within the SAME record
    (on this machine entry or any other machine entry of the same record)
    is checked separately (by the caller, before this) so it gets the more
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


def _all_pallets(mc: models.MaterialConsumption) -> list[models.MaterialConsumptionPallet]:
    return [p for entry in mc.machine_entries for p in entry.pallets]


def machine_label(entry: models.MaterialConsumptionMachineEntry, index: int) -> str:
    return entry.machine.code if entry.machine else f"Machine #{index + 1}"


def add_machine_entry(db: Session, mc: models.MaterialConsumption, machine_id=None) -> models.MaterialConsumptionMachineEntry:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")
    entry = models.MaterialConsumptionMachineEntry(
        material_consumption_id=mc.id, machine_id=machine_id, sort_order=len(mc.machine_entries),
    )
    db.add(entry)
    db.flush()
    return entry


def remove_machine_entry(db: Session, mc: models.MaterialConsumption, entry_id) -> None:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")
    entry = next((e for e in mc.machine_entries if e.id == entry_id), None)
    if not entry:
        raise MaterialConsumptionError("Machine entry not found on this record.")
    if len(mc.machine_entries) <= 1:
        raise MaterialConsumptionError("A record needs at least one machine -- remove the whole record instead if it's not needed.")
    db.delete(entry)
    db.flush()


def set_machine_entry_machine(db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry, machine_id) -> None:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")
    entry.machine_id = machine_id
    db.flush()


def add_primary_pallet(
    db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry,
    raw_scan: str, client_time: str | None = None,
) -> models.MaterialConsumptionPallet:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")

    pallet = _resolve_scanned_pallet(db, raw_scan)

    if pallet.category not in PRIMARY_CATEGORIES:
        raise MaterialConsumptionError(
            f"Pallet {pallet.display_id} is category '{pallet.category or 'unknown'}', not a primary Tray pallet. "
            "Use the matching Secondary Material section instead."
        )
    _assert_pallet_available(pallet)
    already_scanned = {p.pallet_id for p in _all_pallets(mc) if p.role == "primary"}
    if pallet.id in already_scanned:
        raise MaterialConsumptionError(f"Pallet {pallet.display_id} has already been scanned into this record.")
    _assert_not_already_allocated(db, pallet, exclude_mc_id=mc.id)

    existing_primary = [p for p in entry.pallets if p.role == "primary"]
    if existing_primary:
        if (
            pallet.category != entry.category
            or pallet.sku_code_id != entry.sku_code_id
            or pallet.sku_version_id != entry.sku_version_id
        ):
            raise MaterialConsumptionError(
                "Pallet cannot be added. SKU Code / Version does not match the pallets already selected for this machine."
            )
    else:
        # First pallet on this machine entry establishes Category + SKU
        # Code + SKU Version for it -- and, per the user's explicit
        # direction, this first scan IS the start of work: stamp
        # entry.start_time right now, atomically with this same scan,
        # using the scanning device's own clock (client_time, sent by the
        # frontend) rather than the backend server's clock -- the
        # workstation is what's physically on the US factory floor. Falls
        # back to the server's own clock only if the frontend didn't send
        # one, so an entry is never left without a start_time at all.
        entry.category = pallet.category
        entry.sku_code_id = pallet.sku_code_id
        entry.sku_version_id = pallet.sku_version_id
        entry.sku_code_snapshot = pallet.sku_code_snapshot
        entry.sku_version_snapshot = pallet.sku_version_snapshot
        if not entry.start_time:
            if client_time:
                entry.start_time = client_time
            else:
                import datetime as _dt
                now = _dt.datetime.now()
                entry.start_time = f"{now.hour:02d}:{now.minute:02d}"

    row = models.MaterialConsumptionPallet(
        material_consumption_id=mc.id, machine_entry_id=entry.id, role="primary", pallet_id=pallet.id,
        quantity=Decimal("1"), sort_order=len(entry.pallets),
    )
    db.add(row)
    db.flush()
    return row


def add_secondary_pallet(
    db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry,
    raw_scan: str, category: str,
) -> models.MaterialConsumptionPallet:
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
    already_scanned = {p.pallet_id for p in _all_pallets(mc) if p.role == category}
    if pallet.id in already_scanned:
        raise MaterialConsumptionError(f"Pallet {pallet.display_id} has already been scanned into this record.")
    _assert_not_already_allocated(db, pallet, exclude_mc_id=mc.id)

    row = models.MaterialConsumptionPallet(
        material_consumption_id=mc.id, machine_entry_id=entry.id, role=category, pallet_id=pallet.id,
        quantity=Decimal("1"), sort_order=len(entry.pallets),
    )
    db.add(row)
    db.flush()
    return row


def remove_pallet(db: Session, mc: models.MaterialConsumption, row_id) -> None:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")
    row = next((p for p in _all_pallets(mc) if p.id == row_id), None)
    if not row:
        raise MaterialConsumptionError("Pallet not found on this record.")
    entry = row.machine_entry
    was_primary = row.role == "primary"
    db.delete(row)
    db.flush()
    # If the removed pallet was the last primary pallet on this machine
    # entry, release the category/SKU lock established by it so a
    # differently-SKU'd pallet can be scanned next -- the entry hasn't
    # consumed anything yet (draft).
    remaining_primary = [p for p in entry.pallets if p.role == "primary" and p.id != row_id]
    if was_primary and not remaining_primary:
        entry.category = None
        entry.sku_code_id = None
        entry.sku_version_id = None
        entry.sku_code_snapshot = None
        entry.sku_version_snapshot = None


def set_secondary_quantity(db: Session, mc: models.MaterialConsumption, row_id, quantity: Decimal) -> models.MaterialConsumptionPallet:
    row = next((p for p in _all_pallets(mc) if p.id == row_id), None)
    if not row:
        raise MaterialConsumptionError("Pallet not found on this record.")
    if row.role == "primary":
        raise MaterialConsumptionError("Primary pallet quantity is fixed and cannot be edited.")
    row.quantity = quantity
    db.flush()
    return row


def record_entry_end_time(db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry, end_time: str) -> None:
    if mc.status != "draft":
        raise MaterialConsumptionError("This Material Consumption record has already been saved and cannot be changed.")
    if not entry.start_time:
        raise MaterialConsumptionError("Scan at least one pallet on this machine first -- Start Time is recorded automatically.")
    entry.end_time = end_time
    db.flush()


def is_blank(mc: models.MaterialConsumption) -> bool:
    return not mc.shift and not any(
        e.machine_id or e.start_time or e.end_time or e.pallets for e in mc.machine_entries
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
    seq = next_seq(db, "production_run")
    return f"PR-{str(seq).zfill(4)}"


def find_or_create_production_run(db: Session, mc: models.MaterialConsumption, actor_user_id=None) -> models.ProductionRun:
    """Idempotent find-or-create keyed by (date, shift) -- NOT machine --
    so multiple Material Consumption records (or multiple machine entries
    within one record) on different machines for the same date+shift all
    attach to the same run. category/SKU snapshot onto the run come from
    the record's first machine entry that has them set. `created_by` is
    only set the first time the run is created (by whichever Material
    Consumption finalize first spawns it) -- this is what the Production
    module surfaces as "Operator", since there is no separate manual
    Production entry step to collect one."""
    run = (
        db.query(models.ProductionRun)
        .filter(models.ProductionRun.production_date == mc.consumption_date, models.ProductionRun.shift == mc.shift)
        .first()
    )
    first_with_sku = next((e for e in mc.machine_entries if e.category), None)
    if not run:
        run = models.ProductionRun(
            run_number=_next_run_number(db),
            production_date=mc.consumption_date,
            shift=mc.shift,
            category=(first_with_sku.category if first_with_sku else "fgtray"),
            sku_code_id=first_with_sku.sku_code_id if first_with_sku else None,
            sku_version_id=first_with_sku.sku_version_id if first_with_sku else None,
            total_fg_pallets=0,
            status="pending",
            created_by=actor_user_id,
        )
        db.add(run)
        db.flush()
    for entry in mc.machine_entries:
        if not entry.machine_id:
            continue
        has_machine = (
            db.query(models.ProductionRunMachine)
            .filter(models.ProductionRunMachine.production_run_id == run.id, models.ProductionRunMachine.machine_id == entry.machine_id)
            .first()
        )
        if not has_machine:
            db.add(models.ProductionRunMachine(production_run_id=run.id, machine_id=entry.machine_id))
            db.flush()
    return run


def find_or_create_ipqc(db: Session, run: models.ProductionRun, mc: models.MaterialConsumption) -> models.IpqcRecord:
    """One IPQC record per Production Run (unique constraint on
    production_run_id backstops this) -- dedup falls straight out of the
    Production Run being itself found-or-created by (date, shift)."""
    existing = db.query(models.IpqcRecord).filter(models.IpqcRecord.production_run_id == run.id).first()
    if existing:
        return existing
    first_with_sku = next((e for e in mc.machine_entries if e.category), None)
    rec = models.IpqcRecord(
        production_run_id=run.id,
        sku_code_id=first_with_sku.sku_code_id if first_with_sku else None,
        sku_version_id=first_with_sku.sku_version_id if first_with_sku else None,
        sku_code_snapshot=first_with_sku.sku_code_snapshot if first_with_sku else None,
        sku_version_snapshot=first_with_sku.sku_version_snapshot if first_with_sku else None,
        shift=mc.shift, production_date=mc.consumption_date, status="pending",
    )
    db.add(rec)
    db.flush()
    return rec


def finalize(db: Session, mc: models.MaterialConsumption, actor_user_id=None) -> models.MaterialConsumption:
    """
    Final Save: validate every machine entry first (nothing is written if
    validation fails), then atomically consume every attached pallet across
    every machine entry, find-or-create the Production Run and IPQC record,
    and mark this record 'saved'. Re-validates every pallet's live
    lifecycle_status inside this same transaction (never trusting the
    scan-time snapshot), exactly like storage_service.confirm_storage --
    either everything commits, or (on any validation failure) the caller
    rolls back and nothing is consumed.
    """
    if not mc.machine_entries:
        raise MaterialConsumptionError("Add at least one machine before saving.")
    if not mc.shift:
        raise MaterialConsumptionError("Select a Shift before saving.")

    for i, entry in enumerate(mc.machine_entries):
        label = machine_label(entry, i)
        if not entry.machine_id:
            raise MaterialConsumptionError(f"Select a Machine for {label}.")
        primary_pallets = [p for p in entry.pallets if p.role == "primary"]
        if not primary_pallets:
            raise MaterialConsumptionError(f"Scan at least one RM pallet for {label} before saving.")
        if not entry.start_time:
            raise MaterialConsumptionError(f"Start Time is missing for {label} -- scan at least one pallet first, it's recorded automatically.")
        if not entry.end_time:
            raise MaterialConsumptionError(f"Record the End Time for {label} before this record can be saved.")

    all_pallets = _all_pallets(mc)
    for row in all_pallets:
        db.refresh(row.pallet)
        if row.pallet.lifecycle_status != "stored":
            raise MaterialConsumptionError(
                f"Pallet {row.pallet.display_id} is no longer available in RM Storage "
                f"(status: {row.pallet.lifecycle_status}) and cannot be consumed. Remove it and re-scan."
            )

    for row in all_pallets:
        pallet_service.record_lifecycle_event(
            db, row.pallet, "consumed", actor_user_id=actor_user_id,
            consumed_by_module="material_consumption", consumed_by_record=str(mc.id),
        )

    run = find_or_create_production_run(db, mc, actor_user_id=actor_user_id)
    find_or_create_ipqc(db, run, mc)
    mc.production_run_id = run.id
    mc.status = "saved"
    mc.updated_by = actor_user_id
    db.flush()
    return mc
