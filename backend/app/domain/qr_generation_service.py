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
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db import models
from app.domain import pallet_service


class QrGenerationError(Exception):
    pass


def _resolve_qc_sku(qc: models.InwardQcRecord) -> tuple[str | None, str | None, uuid.UUID | None, uuid.UUID | None]:
    """
    Manual QC categories (Glue, Soaker Pad, Polybag, CFB) carry their single
    SKU directly on the InwardQcRecord row (sku_code_id/sku_code_snapshot).
    Tray / FG Non-Padded Tray QC — auto-created from an approved Vehicle
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

    The vendor lookup category is NOT always qc.category: a Tray / FG
    Non-Padded Tray QC is auto-created with qc.category == "fgtray", but the
    Vendor Name dropdown on the *source Vehicle Inspection* -- where this
    vendor_name was actually chosen -- is scoped to the inspection's own
    category, "tray" (the Vendors admin screen's managed category list is
    tray/pad/polybag/cfb/glue; "fgtray" is never a Vendor category). So for
    a QC with a linked vehicle inspection, look the vendor up under that
    inspection's category instead, or the vendor set up for this vendor
    name would never be found.
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


def get_or_create_fg_qr_for_production_run(db: Session, run: models.ProductionRun) -> models.QrGenerationRecord:
    """
    Called the moment a Production Run has FG Pallets Generated recorded on
    it (see app/api/production.py's save_production_run) -- the FG mirror
    of get_or_create_rm_qr_for_qc, called the moment an Inward QC is
    Accepted. Idempotent -- the partial unique index on
    source_production_run_id is the hard backstop against a duplicate
    batch; this find-first is what makes repeat calls (every time
    Production is re-saved) a no-op rather than raising.
    """
    sku_code = run.sku_code.code if run.sku_code else None
    sku_version = run.sku_version.version if run.sku_version else None
    shipment_number = _derive_run_shipment_number(run)

    existing = (
        db.query(models.QrGenerationRecord)
        .filter(models.QrGenerationRecord.source_production_run_id == run.id)
        .first()
    )
    if existing:
        # Only a still-pending (not yet generated) batch may be refreshed --
        # once pallets/QR codes exist the batch's data must never drift,
        # same rule RM QR Generation already follows. This lets a later
        # correction to Total FG Pallets Generated (before Generate QR is
        # clicked) actually reach the batch instead of leaving it stuck at
        # whatever was true the first time Production was saved.
        if existing.status == "pending":
            existing.shipment_number = shipment_number
            existing.sku_code_id = run.sku_code_id
            existing.sku_version_id = run.sku_version_id
            existing.sku_code_snapshot = sku_code
            existing.sku_version_snapshot = sku_version
            existing.quantity = int(run.total_fg_pallets or 0)
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
        quantity=int(run.total_fg_pallets or 0),
        status="pending",
    )
    db.add(rec)
    db.flush()
    return rec


def generate_pallets(db: Session, rec: models.QrGenerationRecord, actor_user_id=None) -> models.QrGenerationRecord:
    """
    Generate one individually-numbered, real-QR-backed pallet per unit of
    quantity, and immediately propagate all of them into pending_storage —
    matching qrGenerate() + qrPropagateToStorage() in the prototype exactly.
    Regenerating an already-generated batch is a no-op (never allowed).
    """
    if rec.status == "generated":
        return rec
    if rec.quantity <= 0:
        raise QrGenerationError("Enter a quantity greater than 0 before generating QR codes.")

    for _ in range(rec.quantity):
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
            lifecycle_status="generated",
        )
        db.add(pallet)
        db.flush()
        pallet_service.generate_pallet_qr(db, pallet)
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
