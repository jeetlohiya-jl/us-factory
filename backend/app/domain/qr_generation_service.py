"""
RM QR Generation (source: approved Inward QC) and FG QR Generation (source:
approved Production Run) — same fundamental design, parameterized by
qr_type, per the task's explicit instruction that FG QR Generation "follows
the same fundamental design as RM QR Generation, but the source is
Production."

Mirrors the prototype's qrGenerate()/qrPropagateToStorage()/QR_RECORDS
behaviour: one source record -> one QR batch (find-or-create, never
duplicated), and generating a batch creates N individually-numbered
pallets that immediately enter pending_storage.
"""
import concurrent.futures
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db import models
from app.domain import pallet_service
from app.domain import batch_code_service


class QrGenerationError(Exception):
    pass


def _resolve_qc_sku(qc: models.InwardQcRecord) -> tuple[str | None, str | None, uuid.UUID | None, uuid.UUID | None]:
    """
    Manual QC categories (Glue, Soaker Pad, Polybag, CFB) carry their single
    SKU directly on the InwardQcRecord row (sku_code_id/sku_code_snapshot).
    Base Tray / LNP Tray QC — auto-created from an approved Vehicle
    Inspection, which can list multiple SKU line items — carries its SKU(s)
    in the separate line_item_snapshots table instead; the top-level columns
    are never populated for that category. Fall back to the first line-item
    snapshot (sort_order 0) when the top-level fields are empty, so RM QR
    Generation shows real data for Tray-sourced batches instead of "-".
    """
    if qc.sku_code_snapshot or qc.sku_code_id:
        sku_code = qc.sku_code_snapshot or (qc.sku_code.code if qc.sku_code else None)
        sku_version = qc.sku_version_snapshot or (qc.sku_version.version if qc.sku_version else None)
        return sku_code, sku_version, qc.sku_code_id, qc.sku_version_id
    if qc.line_item_snapshots:
        li = qc.line_item_snapshots[0]
        sku_code = li.sku_code_snapshot or (li.sku_code.code if li.sku_code else None)
        sku_version = li.sku_version_snapshot or (li.sku_version.version if li.sku_version else None)
        return sku_code, sku_version, li.sku_code_id, li.sku_version_id
    return None, None, None, None


def _resolve_qc_country(db: Session, qc: models.InwardQcRecord) -> str:
    """
    The country an RM pallet was packed in is the country of the vendor
    named on the Inward QC. Since migration 0010, qc.vendor_id is a real
    foreign key resolved at write time (see app.domain.vendor_lookup) and
    is preferred here directly -- no lookup needed. Falls back to the
    original best-effort category+name text match only for a row that
    predates that column (never got a vendor_id backfilled, e.g. no
    matching vendor existed at the time). Falls back further to "US" when
    even that can't be matched, so a missing lookup can never block QR
    generation -- it only means the pallet gets the same "US-" prefix
    every pallet got before this feature existed.

    The vendor lookup category is NOT always qc.category: a Tray-family QC
    record's category now mirrors its source Inward Vehicle Inspection
    directly ("tray" or "lnp_tray" -- see vehicle_inspection_service.
    propagate_to_qc), so for a current record this already matches. This
    fallback exists for a QC record created before that passthrough existed
    (qc.category == "fgtray", a value the Vendors admin screen's managed
    category list has never included) -- for those, look the vendor up
    under the linked inspection's own category instead, or the vendor set
    up for this vendor name would never be found.
    """
    if qc.vendor_id and qc.vendor:
        return qc.vendor.country or "US"
    if not qc.vendor_name:
        return "US"
    lookup_category = qc.vehicle_inspection.category if qc.vehicle_inspection else qc.category
    vendor = (
        db.query(models.Vendor)
        .filter(models.Vendor.category == lookup_category, models.Vendor.name == qc.vendor_name)
        .first()
    )
    return (vendor.country if vendor and vendor.country else "US")


def get_or_create_rm_qr_for_qc(db: Session, qc: models.InwardQcRecord) -> models.QrGenerationRecord:
    """
    Called the moment an Inward QC is Accepted. Idempotent — the partial
    unique index on source_inward_qc_id is the hard backstop against a
    duplicate batch; this find-first is what makes repeat calls a no-op
    rather than raising.
    """
    sku_code, sku_version, sku_code_id, sku_version_id = _resolve_qc_sku(qc)
    country_code = _resolve_qc_country(db, qc)
    quantity = int(qc.quantity or 0)

    existing = (
        db.query(models.QrGenerationRecord)
        .filter(models.QrGenerationRecord.source_inward_qc_id == qc.id)
        .first()
    )
    if existing:
        # Only a still-pending (not yet generated) batch may be refreshed —
        # once pallets/QR codes exist the batch's data must never drift, per
        # "no data duplication that can drift". This lets a correction made
        # to the source QC/Vehicle Inspection *before* Generate QR is clicked
        # actually reach the batch, instead of being silently stuck with
        # whatever was true the instant the QC was first approved.
        if existing.status == "pending":
            existing.shipment_number = qc.shipment_number
            existing.sku_code_id = sku_code_id
            existing.sku_version_id = sku_version_id
            existing.sku_code_snapshot = sku_code
            existing.sku_version_snapshot = sku_version
            existing.country_code = country_code
            existing.quantity = quantity
            db.flush()
        return existing

    rec = models.QrGenerationRecord(
        batch_display_id=pallet_service.next_batch_display_id(db, "rm"),
        qr_type="rm",
        category=qc.category,
        source_inward_qc_id=qc.id,
        shipment_number=qc.shipment_number,
        sku_code_id=sku_code_id,
        sku_version_id=sku_version_id,
        sku_code_snapshot=sku_code,
        sku_version_snapshot=sku_version,
        country_code=country_code,
        quantity=quantity,
        status="pending",
    )
    db.add(rec)
    db.flush()
    return rec


def _derive_run_shipment_number(run: models.ProductionRun) -> str | None:
    """A Production Run's own shipment_number column is only ever populated
    by the dev/test-only direct-create endpoint -- a run spawned from
    Material Consumption (the normal path) never has one set directly, so
    fall back to the same derivation the frontend already uses for display
    (deriveShipmentNumberFromEntries): the first primary pallet's own
    shipment_number snapshot, walked in machine/pallet sort order across
    every Material Consumption record that feeds this run."""
    if run.shipment_number:
        return run.shipment_number
    for mc in sorted(run.material_consumptions, key=lambda m: m.created_at):
        for entry in sorted(mc.machine_entries, key=lambda e: e.sort_order):
            for row in sorted(entry.pallets, key=lambda p: p.sort_order):
                if row.role == "primary" and row.pallet and row.pallet.shipment_number:
                    return row.pallet.shipment_number
    return None


def get_or_create_fg_qr_for_production_run(
    db: Session, run: models.ProductionRun, fg_pallets_generated: int | None = None,
) -> models.QrGenerationRecord:
    """
    Called the moment a Production Run's RQC record reaches 'approved' (see
    app/api/rqc.py's save route) -- the FG mirror of get_or_create_rm_qr_for_qc,
    called the moment an Inward QC is Accepted. Idempotent -- the partial
    unique index on source_production_run_id is the hard backstop against a
    duplicate batch; this find-first is what makes repeat calls (e.g.
    re-saving an already-approved RQC record) a no-op rather than raising.

    fg_pallets_generated is the caller's own "Number of FG Pallets
    Generated" value -- as of migration 0030 this is RqcRecord.fg_pallets_generated,
    entered at the top of the RQC form (see api/rqc.py), NOT
    run.total_fg_pallets (Production no longer collects that input). The
    parameter defaults to None, in which case run.total_fg_pallets is used
    as a fallback -- only relevant for the dev/test-only direct-create
    endpoint (api/production.py's POST route) and any other caller that
    doesn't have an RQC record to read from.
    """
    sku_code = run.sku_code.code if run.sku_code else None
    sku_version = run.sku_version.version if run.sku_version else None
    shipment_number = _derive_run_shipment_number(run)
    quantity = int(fg_pallets_generated) if fg_pallets_generated is not None else int(run.total_fg_pallets or 0)

    # Migration 0039: excludes entry-driven batches from this lookup -- this
    # function now only ever finds/manages the legacy "one batch for the
    # whole run" row (still used by the dev/test manual endpoint and Hold &
    # Release's Release action, both unrelated to the new incremental RQC
    # Approval Entry flow below). Without this filter, calling this
    # function after entries already exist for the run would find the
    # FIRST entry's own batch and "refresh" it with this whole-run
    # quantity -- corrupting entry-driven data it has no business touching.
    existing = (
        db.query(models.QrGenerationRecord)
        .filter(
            models.QrGenerationRecord.source_production_run_id == run.id,
            models.QrGenerationRecord.source_rqc_approval_entry_id.is_(None),
        )
        .first()
    )
    if existing:
        # Only a still-pending (not yet generated) batch may be refreshed --
        # once pallets/QR codes exist the batch's data must never drift,
        # same rule RM QR Generation already follows. This lets a later
        # correction to Number of FG Pallets Generated (before Generate QR
        # is clicked) actually reach the batch instead of leaving it stuck
        # at whatever was true the first time RQC was approved.
        if existing.status == "pending":
            existing.shipment_number = shipment_number
            existing.sku_code_id = run.sku_code_id
            existing.sku_version_id = run.sku_version_id
            existing.sku_code_snapshot = sku_code
            existing.sku_version_snapshot = sku_version
            existing.quantity = quantity
            db.flush()
        return existing

    rec = models.QrGenerationRecord(
        batch_display_id=pallet_service.next_batch_display_id(db, "fg"),
        qr_type="fg",
        category=run.category,
        source_production_run_id=run.id,
        shipment_number=shipment_number,
        sku_code_id=run.sku_code_id,
        sku_version_id=run.sku_version_id,
        sku_code_snapshot=sku_code,
        sku_version_snapshot=sku_version,
        # Always "US": finished goods are packed at this US factory
        # regardless of which country any upstream RM component shipped
        # from -- unlike RM, FG's country is never vendor-dependent.
        country_code="US",
        quantity=quantity,
        status="pending",
    )
    db.add(rec)
    db.flush()
    return rec


def get_or_create_fg_qr_for_rqc_approval_entry(
    db: Session, entry: models.RqcApprovalEntry,
) -> models.QrGenerationRecord:
    """
    Migration 0039 -- the FG QR trigger for the current RQC workflow: each
    RQC Approval Entry (one date + operator + approved-pallets event, see
    api/rqc.py's POST .../approval-entries route) gets its own FG QR batch
    the moment it's recorded, sized to exactly that entry's own
    approved_pallets -- never the whole shipment's running total, never
    Production's total_fg_pallets/pallets_produced. Idempotent the same way
    get_or_create_fg_qr_for_production_run is: the partial unique index on
    source_rqc_approval_entry_id is the hard backstop; this find-first
    makes a retried/duplicate POST for the same entry a no-op. Unlike the
    legacy function, there is no "refresh while pending" branch -- an
    approval entry is immutable once created (no edit route), so there is
    nothing to refresh; a found existing batch is returned exactly as-is.

    2026-09-17 update: a Production Run link is no longer required. RQC
    records can legitimately be created before (or without ever getting) a
    matching IPQC/Production Run -- see rqc_service.create_rqc's "no match
    is not an error" behavior -- and the task requirement is that approved
    pallets flow to FG QR Generation regardless. When no run is linked,
    this falls back to the RqcRecord's own SKU snapshot/shipment_number
    (still real, user-visible data -- never fabricated), and
    batch_code_service.resolve_machine_allocations_for_entry likewise falls
    back to an unattributed machine (batch code gets the placeholder
    machine segment) instead of raising.
    """
    rqc = entry.rqc_record
    run = rqc.production_run if rqc else None

    existing = (
        db.query(models.QrGenerationRecord)
        .filter(models.QrGenerationRecord.source_rqc_approval_entry_id == entry.id)
        .first()
    )
    if existing:
        return existing

    if run:
        sku_code = run.sku_code.code if run.sku_code else None
        sku_version = run.sku_version.version if run.sku_version else None
        shipment_number = _derive_run_shipment_number(run) or (rqc.shipment_number if rqc else None)
        category = run.category
        sku_code_id = run.sku_code_id
        sku_version_id = run.sku_version_id
    else:
        sku_code = rqc.sku_code_snapshot if rqc else None
        sku_version = rqc.sku_version_snapshot if rqc else None
        shipment_number = rqc.shipment_number if rqc else None
        category = None
        sku_code_id = rqc.sku_code_id if rqc else None
        sku_version_id = rqc.sku_version_id if rqc else None

    rec = models.QrGenerationRecord(
        batch_display_id=pallet_service.next_batch_display_id(db, "fg"),
        qr_type="fg",
        category=category,
        source_production_run_id=run.id if run else None,
        source_rqc_approval_entry_id=entry.id,
        shipment_number=shipment_number,
        sku_code_id=sku_code_id,
        sku_version_id=sku_version_id,
        sku_code_snapshot=sku_code,
        sku_version_snapshot=sku_version,
        country_code="US",
        quantity=int(entry.approved_pallets),
        status="pending",
    )
    db.add(rec)
    db.flush()
    return rec


def get_or_create_fg_qr_for_rqc_record(db: Session, rqc: models.RqcRecord) -> models.QrGenerationRecord:
    """
    2026-09-17 -- the FG QR trigger for the current (per-activity) RQC
    workflow: RQC moved from "one record per Shipment Number, many approval
    entries underneath" to "one record per activity" (see RqcRecord's class
    docstring). This is the direct successor to
    get_or_create_fg_qr_for_rqc_approval_entry above, one level up -- same
    shape, same idempotency pattern (a partial unique index on
    source_rqc_record_id, migration 0042, is the hard backstop; this
    find-first makes a retried/duplicate final-save a no-op), same
    Production-Run-optional fallback (a standalone RQC record with no
    linked run still gets a real batch, sourced from its own SKU snapshot/
    shipment_number).

    Called from api/rqc.py's save route the moment THIS record's own status
    reaches 'approved', sized to exactly this record's own
    fg_pallets_generated (= "Approved Pallets", entered on Page 3 of the
    RQC wizard) -- never any other record's count, never a shipment-wide
    running total. The approval-entry ledger's own trigger function above
    is untouched and keeps serving already-existing historical records.
    """
    run = rqc.production_run

    existing = (
        db.query(models.QrGenerationRecord)
        .filter(models.QrGenerationRecord.source_rqc_record_id == rqc.id)
        .first()
    )
    if existing:
        return existing

    if run:
        sku_code = run.sku_code.code if run.sku_code else None
        sku_version = run.sku_version.version if run.sku_version else None
        shipment_number = _derive_run_shipment_number(run) or rqc.shipment_number
        category = run.category
        sku_code_id = run.sku_code_id
        sku_version_id = run.sku_version_id
    else:
        sku_code = rqc.sku_code_snapshot
        sku_version = rqc.sku_version_snapshot
        shipment_number = rqc.shipment_number
        category = None
        sku_code_id = rqc.sku_code_id
        sku_version_id = rqc.sku_version_id

    rec = models.QrGenerationRecord(
        batch_display_id=pallet_service.next_batch_display_id(db, "fg"),
        qr_type="fg",
        category=category,
        source_production_run_id=run.id if run else None,
        source_rqc_record_id=rqc.id,
        shipment_number=shipment_number,
        sku_code_id=sku_code_id,
        sku_version_id=sku_version_id,
        sku_code_snapshot=sku_code,
        sku_version_snapshot=sku_version,
        country_code="US",
        quantity=int(rqc.fg_pallets_generated or 0),
        status="pending",
    )
    db.add(rec)
    db.flush()
    return rec


def _create_pallet_row(
    db: Session, rec: models.QrGenerationRecord,
    source_machine_id=None, batch_code: str | None = None,
) -> models.Pallet:
    """DB-only, no network -- just the row. QR image generation/upload and
    lifecycle events are handled separately by generate_pallets so the
    (slow, network-bound) QR upload for every pallet in the batch can run
    concurrently instead of one at a time -- see build_pallet_qr's
    docstring."""
    display_id = pallet_service.next_pallet_display_id(db, rec.category, rec.country_code)
    pallet = models.Pallet(
        display_id=display_id,
        pallet_type=rec.qr_type,
        category=rec.category,
        sku_code_id=rec.sku_code_id,
        sku_version_id=rec.sku_version_id,
        sku_code_snapshot=rec.sku_code_snapshot,
        sku_version_snapshot=rec.sku_version_snapshot,
        shipment_number=rec.shipment_number,
        source_qr_generation_id=rec.id,
        source_inward_qc_id=rec.source_inward_qc_id,
        source_production_run_id=rec.source_production_run_id,
        source_goods_receipt_entry_id=rec.source_goods_receipt_entry_id,
        source_machine_id=source_machine_id,
        batch_code=batch_code,
        lifecycle_status="generated",
    )
    db.add(pallet)
    db.flush()
    return pallet


def generate_pallets(db: Session, rec: models.QrGenerationRecord, actor_user_id=None) -> models.QrGenerationRecord:
    """
    Generate one individually-numbered, real-QR-backed pallet per unit of
    quantity, and immediately propagate all of them into pending_storage —
    matching qrGenerate() + qrPropagateToStorage() in the prototype exactly.
    Regenerating an already-generated batch is a no-op (never allowed).

    FG batches (Section 11) additionally compute a Batch Code per pallet and
    attribute each pallet to a specific machine, per
    batch_code_service.resolve_machine_allocations — this is why FG pallets
    are generated machine-by-machine below instead of one flat loop.
    """
    # Lock this row for the rest of the transaction before checking status.
    # Without this, two overlapping "Generate QR" requests (a genuine
    # double-click, a slow request the user retried, or a network hiccup
    # that made the frontend re-send) can both read status="pending" before
    # either has committed its own status="generated" write, and both then
    # run the pallet-creation loop below -- silently doubling every pallet
    # (and every physical QR label) for the batch. Locking here makes the
    # second request's SELECT block until the first request's transaction
    # commits (see the route's db.commit() right after this call returns),
    # so by the time it re-reads status it correctly sees "generated" and
    # returns early instead of generating a second time.
    #
    # populate_existing() is required for that lock to actually help: every
    # caller has already loaded this row into the Session (the route's own
    # _get_or_404), so without it SQLAlchemy's identity map hands back the
    # SAME cached object after the lock is granted -- still showing the
    # stale status="pending" read before the first request committed --
    # and the second request generates a full duplicate set anyway.
    # Reproduced before this fix: three concurrent Generate clicks on a
    # 44-pallet batch created 132 pallets.
    rec = (
        db.query(models.QrGenerationRecord)
        .filter(models.QrGenerationRecord.id == rec.id)
        .with_for_update()
        .populate_existing()
        .one()
    )
    if rec.status == "generated":
        return rec
    if rec.quantity <= 0:
        raise QrGenerationError("Enter a quantity greater than 0 before generating QR codes.")

    pallets: list[models.Pallet] = []
    if rec.qr_type == "fg" and rec.source_rqc_approval_entry:
        # Migration 0039 -- current flow: this batch belongs to exactly one
        # RQC Approval Entry, and its own machine split/table-person number
        # are what determine each pallet's Batch Code, never the parent
        # RqcRecord's (possibly since-changed) values.
        entry = rec.source_rqc_approval_entry
        run = entry.rqc_record.production_run if entry.rqc_record else None
        try:
            allocations = batch_code_service.resolve_machine_allocations_for_entry(db, entry)
        except batch_code_service.BatchCodeError as e:
            raise QrGenerationError(e.message)
        combo_number = batch_code_service.next_combo_number(db, rec.shipment_number)
        rec.combo_number = combo_number
        sku_number = rec.sku_code.batch_number if rec.sku_code else None
        table_person_number = entry.table_person_number or (entry.rqc_record.table_person_number if entry.rqc_record else None)
        for machine, count in allocations:
            batch_code = batch_code_service.build_batch_code(
                sku_number=sku_number, shipment_number=rec.shipment_number, combo_number=combo_number,
                production_date=(run.production_date if run else None), shift=(run.shift if run else None),
                table_person_number=table_person_number,
                machine_number=(machine.batch_number if machine else None),
            )
            for _ in range(count):
                pallets.append(_create_pallet_row(
                    db, rec, source_machine_id=machine.id if machine else None, batch_code=batch_code,
                ))
    elif rec.qr_type == "fg" and rec.source_rqc_record:
        # 2026-09-17 -- current per-activity flow: this batch belongs to
        # exactly one RqcRecord, which directly carries the one Machine
        # this activity's pallets came from (Page 3 of the RQC wizard) --
        # no allocation-splitting needed, unlike the approval-entry
        # ledger's own branch above, since one activity = one machine by
        # design. machine may still be None for a standalone record with
        # no linked Production Run to choose a machine from at all --
        # build_batch_code already renders the placeholder machine segment
        # for that case, same as the approval-entry path does.
        rqc = rec.source_rqc_record
        run = rqc.production_run
        machine = rqc.machine
        combo_number = batch_code_service.next_combo_number(db, rec.shipment_number)
        rec.combo_number = combo_number
        sku_number = rec.sku_code.batch_number if rec.sku_code else None
        batch_code = batch_code_service.build_batch_code(
            sku_number=sku_number, shipment_number=rec.shipment_number, combo_number=combo_number,
            production_date=rqc.activity_date or (run.production_date if run else None),
            shift=rqc.shift or (run.shift if run else None),
            table_person_number=rqc.table_person_number,
            machine_number=(machine.batch_number if machine else None),
        )
        for _ in range(rec.quantity):
            pallets.append(_create_pallet_row(
                db, rec, source_machine_id=machine.id if machine else None, batch_code=batch_code,
            ))
    elif rec.qr_type == "fg" and rec.source_production_run and rec.source_production_run.rqc_records:
        # Legacy whole-run path -- pre-migration-0039 batches, and the
        # dev/test manual "from Production Run" endpoint / Hold & Release's
        # Release action, which still use the RqcRecord-wide total/split.
        # 2026-09-17: a run can now have many RQC activity records (see
        # RqcRecord's class docstring) -- this legacy path takes the most
        # recently created one as its best-effort "the" record, same
        # convention as api/fg_qr.py's manual escape hatch.
        rqc = rec.source_production_run.rqc_records[-1]
        try:
            allocations = batch_code_service.resolve_machine_allocations(db, rqc)
        except batch_code_service.BatchCodeError as e:
            raise QrGenerationError(e.message)
        combo_number = batch_code_service.next_combo_number(db, rec.shipment_number)
        rec.combo_number = combo_number
        sku_number = rec.sku_code.batch_number if rec.sku_code else None
        for machine, count in allocations:
            batch_code = batch_code_service.build_batch_code(
                sku_number=sku_number, shipment_number=rec.shipment_number, combo_number=combo_number,
                production_date=rec.source_production_run.production_date, shift=rec.source_production_run.shift,
                table_person_number=rqc.table_person_number,
                machine_number=(machine.batch_number if machine else None),
            )
            for _ in range(count):
                pallets.append(_create_pallet_row(
                    db, rec, source_machine_id=machine.id if machine else None, batch_code=batch_code,
                ))
    else:
        for _ in range(rec.quantity):
            pallets.append(_create_pallet_row(db, rec))

    # Every pallet row now exists (fast -- local DB only). Building each
    # QR PNG and uploading it to storage is the slow, network-bound part
    # (one Supabase Storage round-trip per pallet -- this is what made a
    # 44-pallet batch take ~8s when done one at a time, back to back).
    # Do that concurrently across the whole batch instead: build_pallet_qr
    # is pure (no DB/network), and storage.save() for different pallets is
    # fully independent, so a small thread pool cuts wall-clock time
    # roughly by the worker count. The SQLAlchemy Session itself is never
    # touched from a worker thread -- only plain bytes go in/out.
    storage = pallet_service.get_storage_adapter()
    jobs = [(p, *pallet_service.build_pallet_qr(p)) for p in pallets]

    def _upload(job):
        pallet, path, payload, png = job
        stored = storage.save(path, png, "image/png")
        return pallet, payload, stored

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        uploaded = list(pool.map(_upload, jobs))

    for pallet, payload, stored in uploaded:
        pallet.qr_storage_path = stored.storage_path
        pallet.qr_public_url = stored.public_url
        pallet.qr_payload = payload
        pallet_service.record_lifecycle_event(
            db, pallet, "generated", actor_user_id=actor_user_id,
            source_batch=rec.batch_display_id, sku=rec.sku_code_snapshot, version=rec.sku_version_snapshot,
        )
        # Immediately propagate to pending storage, per the prototype.
        pallet_service.record_lifecycle_event(
            db, pallet, "pending_storage", actor_user_id=actor_user_id, sku=rec.sku_code_snapshot,
        )

    rec.status = "generated"
    rec.generated_at = datetime.now(timezone.utc)
    db.flush()
    return rec
