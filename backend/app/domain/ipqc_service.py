"""
IPQC (In-Process Quality Control) -- manual-creation half of a hybrid path.

IPQC records are still, primarily, auto-created the moment a Material
Consumption record is finalized (material_consumption_service.find_or_create_ipqc,
unchanged) -- that remains the dominant, expected way an IPQC record comes
into existence for a real production shift, and this module does not touch
that path at all.

This module adds the ONE thing that was missing per updated requirements:
a manual "+ New Record" creation option (create_ipqc below, called from
app/api/ipqc.py's POST route), for the case where an inspector needs to
start an IPQC record before/without a matching Material Consumption
finalize -- e.g. entering it directly against a Shipment Number. This
deliberately mirrors rqc_service.create_rqc's shape (same Shipment Number
-> Production Run lookup, same "no match is not an error" behavior) since
IPQC and RQC are adjacent modules in the same traceability chain and should
not diverge in how their manual-creation flow works.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import models

# Same rationale as rqc_service.RQC_MANUFACTURER_PLACEHOLDER -- there is no
# real upstream source for Manufacturer on a manually created record.
IPQC_MANUFACTURER_PLACEHOLDER = "Cirkla Manufacturing (placeholder)"


def find_linked_production_run_by_shipment_number(db: Session, shipment_number: str) -> models.ProductionRun | None:
    """Manual creation has no Material Consumption record to derive a
    Production Run from, so it looks one up the same way RQC does: by
    matching Shipment Number against an existing record that already
    carries one. Prefers another IPQC record's own shipment_number (the
    auto-created path's derivation, _derive_shipment_number in
    material_consumption_service), falling back to Production Run's own
    shipment_number column directly. Most-recent match wins, same
    convention as rqc_service.find_linked_ipqc_by_shipment_number."""
    ipqc = (
        db.query(models.IpqcRecord)
        .filter(models.IpqcRecord.shipment_number == shipment_number, models.IpqcRecord.production_run_id.isnot(None))
        .order_by(models.IpqcRecord.created_at.desc())
        .first()
    )
    if ipqc and ipqc.production_run:
        return ipqc.production_run
    return (
        db.query(models.ProductionRun)
        .filter(models.ProductionRun.shipment_number == shipment_number)
        .order_by(models.ProductionRun.created_at.desc())
        .first()
    )


def create_ipqc(db: Session, shipment_number: str | None = None, manufacturer: str | None = None) -> models.IpqcRecord:
    """Manual "+ New Record" creation. Shipment Number is optional here
    (unlike RQC, where it's the required unique business key) -- IPQC has
    never had a uniqueness constraint on shipment_number (it can be shared,
    e.g. by more than one shift-level record referencing the same inbound
    shipment), so this stays permissive rather than inventing a new
    constraint the rest of the module doesn't have.

    When a Shipment Number is given and resolves to an existing Production
    Run, the new record links to it and snapshots its SKU -- never creating
    a duplicate Production Run. No match (or no shipment number at all) is
    not an error: the record is still created, Pending and unlinked, so an
    inspector can start filling it in before the matching production data
    exists.

    ProductionRun.ipqc_record is a one-to-one relationship (uselist=False)
    -- if the resolved run already has an IPQC record (from the normal
    auto-created path, or an earlier manual one), this new record does NOT
    also set production_run_id to it: doing so would put two IpqcRecord
    rows behind that one-to-one relationship, which is exactly the kind of
    duplicate/ambiguous linkage the app's "no duplicates" rule (see the
    18-section spec's Database/Duplicate Protection section) exists to
    prevent. SKU/traceability fields are still copied over for convenience;
    only the FK link itself is withheld.
    """
    shipment_number = (shipment_number or "").strip() or None
    run = find_linked_production_run_by_shipment_number(db, shipment_number) if shipment_number else None
    run_already_linked = bool(run and run.ipqc_record is not None)

    sku_code = db.query(models.SkuCode).filter(models.SkuCode.id == run.sku_code_id).first() if run and run.sku_code_id else None
    sku_version = db.query(models.SkuVersion).filter(models.SkuVersion.id == run.sku_version_id).first() if run and run.sku_version_id else None

    rec = models.IpqcRecord(
        production_run_id=run.id if run and not run_already_linked else None,
        sku_code_id=run.sku_code_id if run else None,
        sku_version_id=run.sku_version_id if run else None,
        sku_code_snapshot=sku_code.code if sku_code else None,
        sku_version_snapshot=sku_version.version if sku_version else None,
        shift=run.shift if run else None,
        production_date=run.production_date if run else None,
        shipment_number=shipment_number,
        manufacturer=manufacturer or IPQC_MANUFACTURER_PLACEHOLDER,
        pad_color=sku_version.prod_pad_color if sku_version else None,
        weight=sku_version.prod_weight if sku_version else None,
        dimensions=sku_version.prod_dimensions if sku_version else None,
        absorption_rate=sku_version.prod_absorption_rate if sku_version else None,
        status="pending",
    )
    db.add(rec)
    db.flush()
    return rec
