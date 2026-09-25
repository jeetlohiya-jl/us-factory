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
'lnp_tray' (LNP Tray) -- the same tray-family RM categories the rest of the
app already treats as tray variants (see pallet_service.CATEGORY_SUFFIX,
where both map to the "PLT" suffix; 'fgtray' is also kept here for RM
pallets generated before the LNP Tray category existed). Pad / Polybag /
CFB / Glue are the *secondary* materials for a machine entry even though
they are ordinary RM pallets of their own, generated and stored exactly the
same way -- so secondary materials are scanned and validated through this
same service, never a free-text fallback.
"""
from decimal import Decimal

from sqlalchemy.orm import Session

from app.db import models
from app.domain import pallet_service
from app.domain.id_counters import next_seq

PRIMARY_CATEGORIES = ("tray", "lnp_tray", "fgtray")
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
    generic cross-record one.

    Scoped to still-DRAFT records only (as of migration 0032/Section 8):
    once a record is finalized, whether the pallet is available again is
    governed entirely by its own lifecycle_status (_assert_pallet_available)
    -- a partially-consumed pallet is left 'stored' precisely so it CAN be
    picked up by a later record. This check exists purely to stop two
    operators double-booking the same physical pallet into two
    simultaneously in-progress drafts before either has finalized."""
    q = (
        db.query(models.MaterialConsumptionPallet)
        .join(models.MaterialConsumption, models.MaterialConsumptionPallet.material_consumption_id == models.MaterialConsumption.id)
        .filter(
            models.MaterialConsumptionPallet.pallet_id == pallet.id,
            models.MaterialConsumption.status == "draft",
        )
    )
    if exclude_mc_id:
        q = q.filter(models.MaterialConsumptionPallet.material_consumption_id != exclude_mc_id)
    row = q.first()
    if row:
        raise MaterialConsumptionError(
            f"Pallet {pallet.display_id} is already scanned into another in-progress RM Requisition record."
        )


def _all_pallets(mc: models.MaterialConsumption) -> list[models.MaterialConsumptionPallet]:
    return [p for entry in mc.machine_entries for p in entry.pallets]


def _release_storage_location(db: Session, pallet: models.Pallet) -> "uuid.UUID | None":
    """2026-09-24: a pallet's RM Storage location becomes available again
    the instant it's physically picked for Material Consumption --
    unconditionally, regardless of whether it later ends up marked "fully
    consumed" or not (an operator has pulled it off the shelf either way).
    Previously, location release only ever happened at finalize()/lifecycle
    -consumed time (and only implicitly, never at all -- RM Storage's own
    occupancy listing is purely StorageRecord-row-driven, so a scanned-but-
    not-yet-finalized pallet used to still show as occupying its shelf).
    Mirrors shipment_picking_service.pick_pallet_for_request's exact
    pattern for FG pallets. Returns the freed location's id (or None if the
    pallet had no StorageRecord to begin with) so the caller can remember
    it on the MaterialConsumptionPallet row for a possible later restore
    (see remove_pallet)."""
    storage_record = db.query(models.StorageRecord).filter(models.StorageRecord.pallet_id == pallet.id).first()
    if not storage_record:
        return None
    location_id = storage_record.location_id
    db.delete(storage_record)
    db.flush()
    return location_id


def _restore_storage_location(db: Session, row: models.MaterialConsumptionPallet) -> None:
    """Reverse of _release_storage_location -- called when a scanned pallet
    is removed from a still-draft record before finalizing (a mistaken
    scan). Only restores when the pallet is still genuinely 'stored' (never
    actually consumed) and doesn't already have a StorageRecord (e.g. it
    was never released to begin with, or was already re-stored by some
    other path) -- both guards make this safe to call unconditionally."""
    if not row.released_location_id:
        return
    pallet = row.pallet
    if pallet.lifecycle_status != "stored":
        return
    exists = db.query(models.StorageRecord.id).filter(models.StorageRecord.pallet_id == pallet.id).first()
    if exists:
        return
    db.add(models.StorageRecord(
        storage_type="rm",
        pallet_id=pallet.id,
        location_id=row.released_location_id,
        source_qr_generation_id=pallet.source_qr_generation_id,
        source_inward_qc_id=pallet.source_inward_qc_id,
        source_goods_receipt_entry_id=pallet.source_goods_receipt_entry_id,
    ))


def machine_label(entry: models.MaterialConsumptionMachineEntry, index: int) -> str:
    return entry.machine.code if entry.machine else f"Machine #{index + 1}"


def add_machine_entry(db: Session, mc: models.MaterialConsumption, machine_id=None) -> models.MaterialConsumptionMachineEntry:
    if mc.status != "draft":
        raise MaterialConsumptionError("This RM Requisition record has already been saved and cannot be changed.")
    entry = models.MaterialConsumptionMachineEntry(
        material_consumption_id=mc.id, machine_id=machine_id, sort_order=len(mc.machine_entries),
    )
    db.add(entry)
    db.flush()
    return entry


def remove_machine_entry(db: Session, mc: models.MaterialConsumption, entry_id) -> None:
    if mc.status != "draft":
        raise MaterialConsumptionError("This RM Requisition record has already been saved and cannot be changed.")
    entry = next((e for e in mc.machine_entries if e.id == entry_id), None)
    if not entry:
        raise MaterialConsumptionError("Machine entry not found on this record.")
    if len(mc.machine_entries) <= 1:
        raise MaterialConsumptionError("A record needs at least one machine -- remove the whole record instead if it's not needed.")
    db.delete(entry)
    db.flush()


def set_machine_entry_machine(db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry, machine_id) -> None:
    if mc.status != "draft":
        raise MaterialConsumptionError("This RM Requisition record has already been saved and cannot be changed.")
    entry.machine_id = machine_id
    db.flush()


def _first_primary_shipment_number(mc: models.MaterialConsumption, exclude_row_id=None) -> str | None:
    for row in sorted(_all_pallets(mc), key=lambda r: (r.machine_entry.sort_order, r.sort_order)):
        if row.id != exclude_row_id and row.role == "primary" and row.pallet and row.pallet.shipment_number:
            return row.pallet.shipment_number
    return None


def _sync_ipqc_shipment_number(db: Session, mc: models.MaterialConsumption, old: str | None, new: str | None) -> None:
    """Keep the auto-created IPQC in step while it's still being filled in.
    Only touches an IPQC whose shipment number was blank or came from this
    record (a run spans every MC record on the same date+shift), and never
    one already on Hold/Approved."""
    if not mc.production_run_id or old == new:
        return
    ipqc = (
        db.query(models.IpqcRecord)
        .filter(models.IpqcRecord.production_run_id == mc.production_run_id)
        .first()
    )
    if ipqc and ipqc.status in ("pending", "draft") and (ipqc.shipment_number is None or ipqc.shipment_number == old):
        ipqc.shipment_number = new


def add_primary_pallet(
    db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry,
    raw_scan: str, client_time: str | None = None, actor_user_id=None,
    quantity: Decimal | None = None, unit: str = "Pallets", fully_consumed: bool = True,
) -> models.MaterialConsumptionPallet:
    """
    quantity/unit/fully_consumed (Section 8): how much of THIS scan the
    operator is drawing, and whether that finishes the pallet off. Defaults
    (quantity=1 "Pallets", fully_consumed=True) reproduce the pre-Section-8
    behaviour exactly for a caller that doesn't pass them. A pallet scanned
    with fully_consumed=False is left at lifecycle_status='stored' by
    finalize() (never flipped to 'consumed'), which is what makes it
    eligible to be scanned again into a later record -- see
    _assert_not_already_allocated and _assert_pallet_available.
    """
    if mc.status != "draft":
        raise MaterialConsumptionError("This RM Requisition record has already been saved and cannot be changed.")

    pallet = _resolve_scanned_pallet(db, raw_scan)

    if pallet.category not in PRIMARY_CATEGORIES:
        raise MaterialConsumptionError(
            f"Pallet {pallet.display_id} is category '{pallet.category or 'unknown'}', not a primary Tray pallet. "
            "Use the matching Secondary Material section instead."
        )
    _assert_pallet_available(pallet)

    # Shipment Number is never typed in -- it comes from the RM pallet
    # itself (the Goods Receipt container / Inward shipment the pallet was
    # received on). Set it BEFORE the Production Run / IPQC find-or-create
    # below, so the IPQC created by this very first scan already carries
    # it (RQC later matches IPQC by Shipment Number).
    #
    # One container (Shipment Number, e.g. HA1 = 44 pallets) is consumed
    # over several shifts, so several RM Requisition records share it until
    # every pallet of that container has been scanned -- which limits itself:
    # a pallet can only be scanned while it is in storage. (Replaces the
    # 2026-09-24 "distinct Shipment Number per record" rule, which blocked
    # the second shift of the same container.)
    if not mc.shipment_number and pallet.shipment_number:
        mc.shipment_number = pallet.shipment_number
        _sync_ipqc_shipment_number(db, mc, None, mc.shipment_number)
    already_scanned = {p.pallet_id for p in _all_pallets(mc) if p.role == "primary"}
    if pallet.id in already_scanned:
        raise MaterialConsumptionError(f"Pallet {pallet.display_id} has already been scanned into this record.")
    _assert_not_already_allocated(db, pallet, exclude_mc_id=mc.id)

    # 2026-09-24: free this pallet's RM Storage location immediately on
    # scan, regardless of whether it ends up marked fully-consumed or not
    # -- see _release_storage_location's own docstring for why this used
    # to not happen at all.
    released_location_id = _release_storage_location(db, pallet)

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

        # Per explicit direction: a draft record's data should be visible on
        # Production and IPQC as soon as it exists, not only once the whole
        # record is finalized. The very first primary-pallet scan is the
        # earliest point a Production Run has anything real to show (a
        # Category/SKU + a machine), so find-or-create it (and its IPQC
        # record) right here, exactly like finalize() already does -- this
        # call is idempotent (found by date+shift), so finalize()'s own
        # find-or-create later is just a no-op safety net, not a duplicate.
        if not mc.production_run_id:
            run = find_or_create_production_run(db, mc, actor_user_id=actor_user_id)
            find_or_create_ipqc(db, run, mc)
            mc.production_run_id = run.id
            # Factory: the run gets its Pending RQC record right away,
            # linked to the run and its IPQC (idempotent).
            from app.domain import rqc_service
            rqc_service.ensure_pending_rqc_for_run(db, run, _derive_shipment_number(mc))

    row = models.MaterialConsumptionPallet(
        material_consumption_id=mc.id, machine_entry_id=entry.id, role="primary", pallet_id=pallet.id,
        quantity=quantity if quantity is not None else Decimal("1"), unit=unit or "Pallets",
        fully_consumed=fully_consumed, sort_order=len(entry.pallets),
        released_location_id=released_location_id,
    )
    db.add(row)
    db.flush()
    return row


def add_secondary_pallet(
    db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry,
    raw_scan: str, category: str,
) -> models.MaterialConsumptionPallet:
    """
    Section 9: a secondary material category (cfb/pad/glue/polybag) is NOT
    capped at one pallet per machine entry -- the only de-dup check below is
    "this exact pallet was already scanned into this record" (already_scanned),
    never "a pallet of this category already exists here". Call this as many
    times as the operator scans distinct CFB/Pad/Glue/Polybag pallets; each
    call adds its own row (serialize_mc_machine_entry groups them into
    secondary_materials.<category> as a list, not a single slot). Selection
    is always the operator's own explicit scan -- never FIFO, never
    auto-picked from RM Storage -- matching this module's own docstring.
    """
    if mc.status != "draft":
        raise MaterialConsumptionError("This RM Requisition record has already been saved and cannot be changed.")
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

    # 2026-09-24: same immediate location-release as add_primary_pallet.
    released_location_id = _release_storage_location(db, pallet)

    row = models.MaterialConsumptionPallet(
        material_consumption_id=mc.id, machine_entry_id=entry.id, role=category, pallet_id=pallet.id,
        quantity=Decimal("1"), sort_order=len(entry.pallets),
        released_location_id=released_location_id,
    )
    db.add(row)
    db.flush()
    return row


def _resolved_role(pallet: models.Pallet) -> str:
    """One generic scanner replaces the old up-front 'Associated Pallet' vs
    'Secondary Material' choice (2026-09-25): the operator no longer tells
    the app what they're about to scan -- the scanned pallet's own category
    says it. 'primary' for the tray-family categories add_primary_pallet
    already accepts; the pallet's own category (one of SECONDARY_ROLES)
    otherwise. Anything else is a pallet this module was never meant to
    handle (an FG pallet is already rejected earlier, in
    _resolve_scanned_pallet, with a clearer message)."""
    if pallet.category in PRIMARY_CATEGORIES:
        return "primary"
    if pallet.category in SECONDARY_ROLES:
        return pallet.category
    raise MaterialConsumptionError(
        f"Pallet {pallet.display_id} is category '{pallet.category or 'unknown'}', which isn't consumed here."
    )


def preview_scanned_pallet(db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry, raw_scan: str) -> dict:
    """Read-only: resolve + run every check add_primary_pallet/
    add_secondary_pallet would run, WITHOUT writing anything (no row
    insert, no storage-location release, no Production Run/IPQC creation)
    -- so the scan UI can show the operator what they scanned and let them
    OK or Cancel it before it's actually added. Raises the exact same
    MaterialConsumptionError a real add would, so cancel-worthy problems
    (wrong category, already consumed, already scanned elsewhere, SKU
    mismatch with this machine's other pallets) surface at preview time
    too, not just on commit.
    """
    if mc.status != "draft":
        raise MaterialConsumptionError("This RM Requisition record has already been saved and cannot be changed.")

    pallet = _resolve_scanned_pallet(db, raw_scan)
    role = _resolved_role(pallet)
    _assert_pallet_available(pallet)
    already_scanned = {p.pallet_id for p in _all_pallets(mc) if p.role == role}
    if pallet.id in already_scanned:
        raise MaterialConsumptionError(f"Pallet {pallet.display_id} has already been scanned into this record.")
    _assert_not_already_allocated(db, pallet, exclude_mc_id=mc.id)

    if role == "primary":
        existing_primary = [p for p in entry.pallets if p.role == "primary"]
        if existing_primary and (
            pallet.category != entry.category
            or pallet.sku_code_id != entry.sku_code_id
            or pallet.sku_version_id != entry.sku_version_id
        ):
            raise MaterialConsumptionError(
                "Pallet cannot be added. SKU Code / Version does not match the pallets already selected for this machine."
            )

    return {
        "role": role,
        "category": pallet.category,
        "sku_code": pallet.sku_code_snapshot,
        "sku_version": pallet.sku_version_snapshot,
        "pallet_display_id": pallet.display_id,
    }


def add_scanned_pallet(
    db: Session, mc: models.MaterialConsumption, entry: models.MaterialConsumptionMachineEntry,
    raw_scan: str, client_time: str | None = None, actor_user_id=None,
) -> models.MaterialConsumptionPallet:
    """The single generic scanner's commit step (called once the operator
    has OK'd the preview above): resolve the pallet and delegate to
    add_primary_pallet or add_secondary_pallet based on its own category,
    same auto-detection as preview_scanned_pallet. Re-resolves rather than
    trusting the preview's result, so anything that changed between preview
    and OK (another operator took the pallet, etc.) is caught here with the
    same error either existing function would already raise."""
    pallet = _resolve_scanned_pallet(db, raw_scan)
    role = _resolved_role(pallet)
    if role == "primary":
        return add_primary_pallet(db, mc, entry, raw_scan, client_time=client_time, actor_user_id=actor_user_id)
    return add_secondary_pallet(db, mc, entry, raw_scan, role)


def remove_pallet(db: Session, mc: models.MaterialConsumption, row_id) -> None:
    if mc.status != "draft":
        raise MaterialConsumptionError("This RM Requisition record has already been saved and cannot be changed.")
    row = next((p for p in _all_pallets(mc) if p.id == row_id), None)
    if not row:
        raise MaterialConsumptionError("Pallet not found on this record.")
    entry = row.machine_entry
    was_primary = row.role == "primary"
    if was_primary:
        # Re-derive from what's still scanned, so removing a wrongly
        # scanned pallet doesn't leave its shipment number behind.
        old_shipment = mc.shipment_number
        mc.shipment_number = _first_primary_shipment_number(mc, exclude_row_id=row.id)
        _sync_ipqc_shipment_number(db, mc, old_shipment, mc.shipment_number)
    # Removing a mistakenly-scanned pallet from a still-draft record should
    # give the operator their RM Storage location back -- it was released
    # unconditionally at scan time (see add_primary_pallet/add_secondary_pallet),
    # so undo that release here before the row (and its released_location_id)
    # is gone.
    _restore_storage_location(db, row)
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


def update_pallet_consumption(
    db: Session, mc: models.MaterialConsumption, row_id,
    quantity: Decimal | None = None, unit: str | None = None, fully_consumed: bool | None = None,
    actor_user_id=None,
) -> models.MaterialConsumptionPallet:
    """
    Edits an already-scanned pallet row's Quantity/Unit/"Fully Consumed"
    flag -- used both for secondary materials (which have always been
    editable this way) and, as of Section 8, for primary pallets too, since
    the whole point of partial consumption is that the operator can say
    "actually only used half of this" after the initial scan.

    2026-09-17: Quantity/Unit are still draft-only -- once mc.status is
    'saved', those numbers are locked in exactly as before. But
    fully_consumed may now still be flipped after save too (per the user's
    explicit direction: saving a Production record does not mean the whole
    of the raw material picked for it was consumed -- that's decided
    separately, by this toggle, whenever it's actually known). This is
    surfaced as a confirmation step when Production itself is saved (see
    ProductionDetailPanel.tsx's save-confirmation modal), but the same
    route/toggle works standalone too.

    Flipping fully_consumed after save also has to keep the pallet's own
    live lifecycle_status in sync with reality, since finalize() already
    moved every originally-fully-consumed pallet to lifecycle_status
    'consumed' (see finalize()'s own pallet loop) and left every partial
    draw at 'stored':
    - True -> False ("actually not fully consumed after all"): reverse the
      'consumed' event -- lifecycle_status goes back to 'stored' and a new
      'reopened_for_consumption' event is logged, so the pallet becomes
      scannable again on a later Material Consumption record. Only
      meaningful when the pallet is *currently* 'consumed' (its own prior
      finalize/toggle) -- skipped otherwise (e.g. it was already a partial
      draw, still 'stored', nothing to reverse).
    - False -> True ("actually it was fully consumed"): record the
      'consumed' lifecycle event now, same as finalize() does for a
      pallet that was fully consumed from the start.
    No cumulative/remaining-quantity tracking is introduced here -- the
    user explicitly simplified this to just the Yes/No toggle plus
    rescanning ("let's just ask if fully consumed or not... that's it").
    """
    row = next((p for p in _all_pallets(mc) if p.id == row_id), None)
    if not row:
        raise MaterialConsumptionError("Pallet not found on this record.")

    if mc.status != "draft":
        if quantity is not None or unit is not None:
            raise MaterialConsumptionError(
                "Quantity/Unit can only be changed while this record is still a draft."
            )
        if fully_consumed is None:
            raise MaterialConsumptionError("This RM Requisition record has already been saved and cannot be changed.")
        if fully_consumed != row.fully_consumed:
            if fully_consumed:
                pallet_service.record_lifecycle_event(
                    db, row.pallet, "consumed", actor_user_id=actor_user_id,
                    consumed_by_module="material_consumption", consumed_by_record=str(mc.id),
                )
            elif row.pallet.lifecycle_status == "consumed":
                # Same shape as finalize()'s own partial-draw branch: log
                # the event under its own descriptive stage name WITHOUT
                # going through record_lifecycle_event (which would stamp
                # lifecycle_status to match the event's own stage,
                # "reopened_for_consumption", instead of the real target
                # status "stored") -- set lifecycle_status directly instead.
                db.add(models.PalletLifecycleEvent(
                    pallet_id=row.pallet.id, stage="reopened_for_consumption", actor_user_id=actor_user_id,
                    event_metadata={"consumed_by_module": "material_consumption", "consumed_by_record": str(mc.id)},
                ))
                row.pallet.lifecycle_status = "stored"
            row.fully_consumed = fully_consumed
        db.flush()
        return row

    if quantity is not None:
        row.quantity = quantity
    if unit is not None:
        row.unit = unit
    if fully_consumed is not None:
        row.fully_consumed = fully_consumed
    db.flush()
    return row


def stamp_end_times_for_production_run(db: Session, run: models.ProductionRun, client_time: str | None = None) -> int:
    """
    Per explicit direction: saving the Production Run (Rejection
    Classification / Wastage / FG Pallets Generated -- see
    app/api/production.py's save_production_run) IS the end of work for
    every machine that fed it -- there is no separate manual "Record End
    Time" step in Material Consumption any more. Stamps end_time (this same
    HH:MM convention as start_time -- the saving device's own clock,
    falling back to the server's if none was sent) onto every machine entry,
    across every Material Consumption record linked to this run, that has a
    start_time but no end_time yet. Idempotent and safe to call on every
    save -- entries that already have an end_time (or never started) are
    left untouched. Returns how many entries were stamped.
    """
    if client_time:
        stamp = client_time
    else:
        import datetime as _dt
        now = _dt.datetime.now()
        stamp = f"{now.hour:02d}:{now.minute:02d}"
    count = 0
    for mc in run.material_consumptions:
        for entry in mc.machine_entries:
            if entry.start_time and not entry.end_time:
                entry.end_time = stamp
                count += 1
    if count:
        db.flush()
    return count


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
            "This RM Requisition record has already consumed pallets and is linked to a "
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
    Consumption record's first primary-pallet scan spawns it -- see
    add_primary_pallet, which calls this as soon as the record has enough
    to show, well before it's finalized) -- this is what the Production
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
    # Batched instead of one existence-check query + one conditional
    # flush per machine entry (N+1 on every finalize -- the exact save
    # path users report as slow, and the one that immediately precedes
    # opening the just-created IPQC/RQC record).
    wanted_machine_ids = {entry.machine_id for entry in mc.machine_entries if entry.machine_id}
    if wanted_machine_ids:
        existing_machine_ids = {
            m.machine_id for m in db.query(models.ProductionRunMachine.machine_id)
            .filter(models.ProductionRunMachine.production_run_id == run.id, models.ProductionRunMachine.machine_id.in_(wanted_machine_ids))
        }
        for machine_id in wanted_machine_ids - existing_machine_ids:
            db.add(models.ProductionRunMachine(production_run_id=run.id, machine_id=machine_id))
        if wanted_machine_ids - existing_machine_ids:
            db.flush()
    return run


IPQC_MANUFACTURER_PLACEHOLDER = "Cirkla Manufacturing (placeholder)"


def _derive_shipment_number(mc: models.MaterialConsumption) -> str | None:
    """mc.shipment_number is auto-filled from the first scanned primary RM
    pallet (see add_primary_pallet / remove_pallet) -- no longer typed in on
    Page 1. The pallet walk below is the fallback for any older record
    saved before that, so they don't regress."""
    return mc.shipment_number or _first_primary_shipment_number(mc)


def find_or_create_ipqc(db: Session, run: models.ProductionRun, mc: models.MaterialConsumption) -> models.IpqcRecord:
    """One IPQC record per Production Run on this (auto-creation) path --
    enforced by the find-before-create query below, not a DB constraint
    (migration 0029 dropped the unique constraint on production_run_id so
    that IPQC's separate manual "+ New Record" path, see
    ipqc_service.create_ipqc, can also create records). Dedup still falls
    straight out of the Production Run being itself found-or-created by
    (date, shift), matching maFindOrCreateIpqc's own linkId of
    'ma-run:'+date+'|'+shift exactly.

    Autopopulates every field the prototype's maFindOrCreateIpqc fills in:
    Shipment Number (derived from the consumed primary pallet, same as
    Production), Batch Code ("<date> / <shift>"), Manufacturer (the same
    fixed placeholder string the prototype uses), and Pad Color / Weight /
    Dimensions / Absorption Rate from the SKU Version's Production Details
    lookup (SKU_PRODUCTION_DETAILS in the prototype -- sku_versions.prod_*
    here). Shift Incharge is left blank, same as the prototype
    (incharge:'') -- it's filled in by whoever completes the inspection.
    """
    existing = db.query(models.IpqcRecord).filter(models.IpqcRecord.production_run_id == run.id).first()
    if existing:
        return existing
    first_with_sku = next((e for e in mc.machine_entries if e.category), None)
    sku_version = first_with_sku.sku_version if first_with_sku else None
    rec = models.IpqcRecord(
        production_run_id=run.id,
        sku_code_id=first_with_sku.sku_code_id if first_with_sku else None,
        sku_version_id=first_with_sku.sku_version_id if first_with_sku else None,
        sku_code_snapshot=first_with_sku.sku_code_snapshot if first_with_sku else None,
        sku_version_snapshot=first_with_sku.sku_version_snapshot if first_with_sku else None,
        shift=mc.shift, production_date=mc.consumption_date, status="pending",
        shipment_number=_derive_shipment_number(mc),
        batch_code=f"{mc.consumption_date} / {mc.shift}" if mc.consumption_date and mc.shift else None,
        manufacturer=IPQC_MANUFACTURER_PLACEHOLDER,
        pad_color=sku_version.prod_pad_color if sku_version else None,
        weight=sku_version.prod_weight if sku_version else None,
        dimensions=sku_version.prod_dimensions if sku_version else None,
        absorption_rate=sku_version.prod_absorption_rate if sku_version else None,
        shift_incharge=None,
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
            raise MaterialConsumptionError(
                f"{label}'s End Time is set automatically once its Production Run is saved -- "
                "save the Production Run for this shift before finalizing this record."
            )

    all_pallets = _all_pallets(mc)
    # Re-check every pallet's *live* lifecycle_status inside this same
    # transaction (never trusting the scan-time snapshot already held on
    # the loaded objects) -- same guarantee as before, but as one batched
    # query instead of one db.refresh() round trip per pallet.
    if all_pallets:
        live_status_by_id = dict(
            db.query(models.Pallet.id, models.Pallet.lifecycle_status)
            .filter(models.Pallet.id.in_([row.pallet_id for row in all_pallets]))
            .all()
        )
        for row in all_pallets:
            live_status = live_status_by_id.get(row.pallet_id)
            if live_status != "stored":
                raise MaterialConsumptionError(
                    f"Pallet {row.pallet.display_id} is no longer available in RM Storage "
                    f"(status: {live_status}) and cannot be consumed. Remove it and re-scan."
                )

    for row in all_pallets:
        if row.fully_consumed:
            pallet_service.record_lifecycle_event(
                db, row.pallet, "consumed", actor_user_id=actor_user_id,
                consumed_by_module="material_consumption", consumed_by_record=str(mc.id),
            )
        else:
            # Partial draw (Section 8): log the event for traceability
            # WITHOUT flipping lifecycle_status away from 'stored' --
            # record_lifecycle_event always overwrites lifecycle_status to
            # match its `stage` argument, which is exactly what must NOT
            # happen here, so this constructs the event row directly
            # instead. Leaving the pallet 'stored' is what makes it
            # eligible for _assert_pallet_available on a later record.
            db.add(models.PalletLifecycleEvent(
                pallet_id=row.pallet.id, stage="partial_consumption", actor_user_id=actor_user_id,
                event_metadata={
                    "consumed_by_module": "material_consumption", "consumed_by_record": str(mc.id),
                    "quantity": str(row.quantity), "unit": row.unit,
                },
            ))

    run = find_or_create_production_run(db, mc, actor_user_id=actor_user_id)
    find_or_create_ipqc(db, run, mc)
    from app.domain import rqc_service
    rqc_service.ensure_pending_rqc_for_run(db, run, _derive_shipment_number(mc))
    # RQC is no longer auto-created here -- it is created manually only,
    # via "+ New Record" on the RQC screen (see app/api/rqc.py's POST route
    # / rqc_service.create_rqc), keyed on Shipment Number rather than this
    # Production Run's id.
    mc.production_run_id = run.id
    mc.status = "saved"
    mc.updated_by = actor_user_id
    db.flush()
    return mc
