"""
Customer Shipment -- the manual, Admin-only record downstream of FG Storage:
  FG Storage -> Customer Shipment -> Shipment Picking

Customer Shipment is create-once: no edit flow, no status workflow of its
own (per spec point 20 -- creation IS the completion event). Saving is one
atomic business transaction (spec point 14/16): allocate Shipment Number +
Container Number, create the shipment + its line items, and fan out exactly
one ShipmentPickingRequest per line item -- all inside the one FastAPI
request/SQLAlchemy transaction that api/customer_shipment.py's create route
opens, mirroring the same "single FastAPI endpoint wraps one transaction"
pattern every other multi-table atomic write in this app already uses
(Material Consumption's finalize(), IPQC/RQC/Production saves, Storage's
confirm_storage) -- not a new Postgres RPC/PL-pgSQL function, per the
spec's own point-16 escape clause: introducing an untested RPC here would
be strictly riskier and inconsistent with the rest of the codebase.

Numbering uses the same `%y%m`-based convention (see pallet_service /
inward_qc_service / vehicle_inspection_service's own next_*_number
functions) rather than the prototype's illustrative 4-digit-year example --
the existing app numbering logic is the actual source of truth (spec point
8). New counter key "cs_container" (see id_counters.py's namespacing
convention). Shipment Number is user-entered (see create_customer_shipment
below), so it has no counter of its own.

Explicitly does NOT create, touch, or reference RQC in any way -- RQC is
fully upstream (Material Consumption -> Production -> IPQC -> RQC -> FG QR
Generation -> FG Storage) and this module must never regress that.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db import models
from app.domain.id_counters import next_seq
from app.domain import ovi_service

# Exact prototype wording (spec point 21) -- must match verbatim.
BLOCKED_DELETE_MESSAGE = (
    "This Customer Shipment record has linked Shipment Picking requests and cannot be deleted."
)


def next_container_number(db: Session) -> str:
    yymm = datetime.now(timezone.utc).strftime("%y%m")
    seq = next_seq(db, "cs_container")
    return f"US-CTN-{yymm}-{str(seq).zfill(4)}"


def create_customer_shipment(
    db: Session,
    *,
    customer: str,
    shipment_number: str,
    line_items: list[dict],
    actor_user_id=None,
) -> models.CustomerShipment:
    """
    One atomic transaction: allocates the Container Number, creates the
    shipment, its line items (only ones with sku_code_id set and
    pallets_required > 0 -- matching the prototype's own csSave()
    validation), and exactly one ShipmentPickingRequest per valid line
    item, snapshotting every field Shipment Picking needs (spec point 18)
    so it never has to re-join back through Customer Shipment / SKU master
    on every read.

    Shipment Number is user-entered, not system-generated (corrected per
    explicit user feedback: the prototype's auto-numbered Shipment Number
    was wrong for the real workflow -- the Shipment Number is a real-world
    identifier the customer/forwarder supplies, unlike Container Number,
    which stays a genuine internal auto-allocation). The unique constraint
    on customer_shipments.shipment_number (migration 0020) is the backstop
    against duplicates -- see the 23505 handling in api/customer_shipment.py.

    Caller (api/customer_shipment.py) is responsible for the actual
    db.commit() -- this function only adds/flushes within the caller's
    existing transaction, matching every other *_service.py save function
    in this codebase.
    """
    container_number = next_container_number(db)

    shipment = models.CustomerShipment(
        shipment_number=shipment_number,
        container_number=container_number,
        customer=customer,
        created_by=actor_user_id,
    )
    db.add(shipment)
    db.flush()

    # Batch the snapshot lookups up front (one query per table, not one per
    # line item -- this used to be up to 2 queries per line item inside the
    # loop, i.e. an N+1 on every Customer Shipment create/save).
    valid_line_items = [
        li for li in line_items
        if li.get("sku_code_id") and int(li.get("pallets_required") or 0) > 0
    ]
    sku_code_ids = {li["sku_code_id"] for li in valid_line_items}
    sku_version_ids = {li["sku_version_id"] for li in valid_line_items if li.get("sku_version_id")}
    sku_codes_by_id = {
        s.id: s for s in db.query(models.SkuCode).filter(models.SkuCode.id.in_(sku_code_ids))
    } if sku_code_ids else {}
    sku_versions_by_id = {
        v.id: v for v in db.query(models.SkuVersion).filter(models.SkuVersion.id.in_(sku_version_ids))
    } if sku_version_ids else {}

    for li in valid_line_items:
        sku_code_id = li.get("sku_code_id")
        pallets_required = int(li.get("pallets_required") or 0)
        sku_version_id = li.get("sku_version_id")

        sku_code = sku_codes_by_id.get(sku_code_id)
        sku_version = sku_versions_by_id.get(sku_version_id) if sku_version_id else None

        line_item = models.CustomerShipmentLineItem(
            customer_shipment_id=shipment.id,
            sku_code_id=sku_code_id,
            sku_version_id=sku_version_id,
            sku_code_snapshot=sku_code.code if sku_code else None,
            sku_version_snapshot=sku_version.version if sku_version else None,
            pallets_required=pallets_required,
        )
        db.add(line_item)
        db.flush()

        db.add(models.ShipmentPickingRequest(
            customer_shipment_id=shipment.id,
            customer_shipment_line_item_id=line_item.id,
            shipment_number=shipment_number,
            container_number=container_number,
            customer=customer,
            sku_code_id=sku_code_id,
            sku_version_id=sku_version_id,
            sku_code_snapshot=line_item.sku_code_snapshot,
            sku_version_snapshot=line_item.sku_version_snapshot,
            pallets_required=pallets_required,
            status="pending",
        ))

    db.flush()

    # Auto-create the linked Outward Vehicle Inspection record, Pending,
    # in the SAME transaction -- per explicit clarification this is keyed
    # off Customer Shipment (not RQC): the instant a Customer Shipment is
    # recorded, its Outward Vehicle Inspection should already be Pending.
    # Idempotent structurally (CS itself is create-once) and backstopped by
    # the unique constraint on outward_vehicle_inspections.customer_shipment_id.
    ovi_service.create_pending_for_shipment(db, shipment)

    db.flush()
    return shipment


def blocked_delete_reason(db: Session, shipment: models.CustomerShipment) -> str | None:
    """Returns the exact prototype delete-block wording if any Shipment
    Picking request references this shipment, else None. The DB's own FK
    (default RESTRICT, no cascade -- see migration 0020) backstops this at
    the schema level; this check exists purely to surface the friendly
    message before that constraint would otherwise raise an IntegrityError."""
    exists = (
        db.query(models.ShipmentPickingRequest.id)
        .filter(models.ShipmentPickingRequest.customer_shipment_id == shipment.id)
        .first()
    )
    if exists:
        return BLOCKED_DELETE_MESSAGE
    return None
