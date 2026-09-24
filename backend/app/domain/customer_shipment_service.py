"""
Customer Shipment -- the manual, Admin-only record downstream of FG Storage:
  FG Storage -> Customer Shipment -> Shipment Picking

Customer Shipment has no separate status workflow of its own (per spec
point 20 -- creation IS the completion event for Goods Outward as a whole).
Saving is one atomic business transaction (spec point 14/16): allocate
Shipment Number + Container Number, create the shipment + its line items,
and fan out exactly one ShipmentPickingRequest per line item -- all inside
the one FastAPI request/SQLAlchemy transaction that api/customer_shipment.py's
create route opens, mirroring the same "single FastAPI endpoint wraps one
transaction" pattern every other multi-table atomic write in this app
already uses (Material Consumption's finalize(), IPQC/RQC/Production saves,
Storage's confirm_storage) -- not a new Postgres RPC/PL-pgSQL function, per
the spec's own point-16 escape clause: introducing an untested RPC here
would be strictly riskier and inconsistent with the rest of the codebase.

2026-09-24 -- Customer Shipment / Goods Outward was originally create-once
by design (no edit flow at all); update_customer_shipment below adds one,
narrowly: a line item that already has real picks against it can't have
its SKU/Version/Quantity changed or be removed (blocked_line_item_edit_
reason), but everything else -- Customer, Shipment Number, un-picked line
items, and adding brand-new ones -- is editable after creation.

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
            pcs=li.get("pcs"),
            pcs_per_sleeve=li.get("pcs_per_sleeve"),
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


BLOCKED_LINE_ITEM_EDIT_MESSAGE = (
    "This line item already has picked Finished Goods pallets against it and can't have its "
    "SKU, Version, or Quantity changed, or be removed. Remove the existing picks first."
)


def blocked_line_item_edit_reason(db: Session, line_item: models.CustomerShipmentLineItem) -> str | None:
    """Whether editing (SKU/Version/Quantity change) or removing this
    existing line item is safe. Real picks (ShipmentPickingPick rows)
    against its 1:1 ShipmentPickingRequest are the actual physical
    fact -- an FG pallet has already been pulled from Storage and matched
    to this line item's SKU/Version -- so changing what SKU/Version/
    Quantity this line item represents, or deleting it outright, out from
    under those picks would silently strand or misattribute them. A line
    item with no picks yet (request still fully 'pending') is free to
    change or remove, same as before anything was ever picked against it."""
    request = (
        db.query(models.ShipmentPickingRequest)
        .filter(models.ShipmentPickingRequest.customer_shipment_line_item_id == line_item.id)
        .first()
    )
    if not request:
        return None
    has_picks = (
        db.query(models.ShipmentPickingPick.id)
        .filter(models.ShipmentPickingPick.shipment_picking_request_id == request.id)
        .first()
    )
    if has_picks:
        return BLOCKED_LINE_ITEM_EDIT_MESSAGE
    return None


def update_customer_shipment(
    db: Session,
    shipment: models.CustomerShipment,
    *,
    customer: str,
    shipment_number: str,
    line_items: list[dict],
) -> models.CustomerShipment:
    """
    The one atomic edit transaction for an already-created Customer
    Shipment / Goods Outward record (2026-09-24 -- Goods Outward previously
    had no edit at all, by original create-once design; this adds one,
    scoped narrowly enough not to disturb anything already picked).

    Diffs `line_items` by id against the shipment's existing line items
    (same "id present = keep/update, id absent = brand-new" convention as
    CustomerShipmentLineItemUpdateIn's own docstring):
      - Existing line items NOT present in the payload are deleted --
        blocked (blocked_line_item_edit_reason) if any pallet has already
        been picked against them.
      - Existing line items present but with a changed SKU Code, SKU
        Version, or Quantity (pallets_required) are likewise blocked if
        already picked; otherwise updated in place, including a re-sync of
        their 1:1 ShipmentPickingRequest's own snapshot columns (sku_code_
        snapshot/sku_version_snapshot/pallets_required) and Requested-
        pallets-lowered-below-picked-count is impossible here anyway, since
        any picks at all already block the whole change.
      - New line items (no id) are created exactly like create_customer_
        shipment's own loop -- including fanning out their own brand-new
        ShipmentPickingRequest, 'pending'.

    Customer and Shipment Number are free to change (re-synced onto every
    surviving/new ShipmentPickingRequest row, since those snapshot columns
    exist purely so Shipment Picking never has to re-join back to Customer
    Shipment). Container Number is never editable -- it's a genuine
    internal auto-allocation from creation time, not a business fact
    anyone corrects after the fact.

    Caller (api/customer_shipment.py) commits, same convention as every
    other *_service.py save function here.

    Raises CustomerShipmentEditBlocked (a plain ValueError subclass) with
    the friendly message the instant a blocked change is found -- checked
    BEFORE any row is touched, so a blocked edit never leaves a partial
    write for the caller to roll back from.
    """
    existing_by_id = {str(li.id): li for li in shipment.line_items}
    payload_ids = {str(li["id"]) for li in line_items if li.get("id")}

    # Pass 1 -- validate every change against blocked_line_item_edit_reason
    # BEFORE mutating anything, so a blocked payload fails atomically with
    # nothing already applied.
    for existing_id, existing in existing_by_id.items():
        if existing_id not in payload_ids:
            reason = blocked_line_item_edit_reason(db, existing)
            if reason:
                raise CustomerShipmentEditBlocked(reason)
    for li in line_items:
        li_id = li.get("id")
        if not li_id:
            continue
        existing = existing_by_id.get(str(li_id))
        if not existing:
            continue
        changed = (
            str(existing.sku_code_id) != str(li.get("sku_code_id"))
            or str(existing.sku_version_id) != str(li.get("sku_version_id"))
            or int(existing.pallets_required) != int(li.get("pallets_required") or 0)
        )
        if changed:
            reason = blocked_line_item_edit_reason(db, existing)
            if reason:
                raise CustomerShipmentEditBlocked(reason)

    # Pass 2 -- apply. Shipment-level fields + re-sync onto every surviving
    # ShipmentPickingRequest (new ones get these values at creation below).
    shipment.customer = customer
    shipment.shipment_number = shipment_number

    sku_code_ids = {li["sku_code_id"] for li in line_items if li.get("sku_code_id")}
    sku_version_ids = {li["sku_version_id"] for li in line_items if li.get("sku_version_id")}
    sku_codes_by_id = {
        s.id: s for s in db.query(models.SkuCode).filter(models.SkuCode.id.in_(sku_code_ids))
    } if sku_code_ids else {}
    sku_versions_by_id = {
        v.id: v for v in db.query(models.SkuVersion).filter(models.SkuVersion.id.in_(sku_version_ids))
    } if sku_version_ids else {}

    # Removals -- anything existing not present in the payload (already
    # confirmed unblocked above). ShipmentPickingRequest cascades via its
    # own FK? No -- deleting the line item cascades via
    # CustomerShipmentLineItem's own relationship isn't declared cascade,
    # so remove the (pick-less, already-verified) request explicitly first.
    for existing_id, existing in existing_by_id.items():
        if existing_id not in payload_ids:
            request = (
                db.query(models.ShipmentPickingRequest)
                .filter(models.ShipmentPickingRequest.customer_shipment_line_item_id == existing.id)
                .first()
            )
            if request:
                db.delete(request)
            db.delete(existing)
    db.flush()

    for li in line_items:
        li_id = li.get("id")
        sku_code_id = li.get("sku_code_id")
        sku_version_id = li.get("sku_version_id")
        pallets_required = int(li.get("pallets_required") or 0)
        sku_code = sku_codes_by_id.get(sku_code_id)
        sku_version = sku_versions_by_id.get(sku_version_id) if sku_version_id else None

        if li_id and str(li_id) in existing_by_id:
            existing = existing_by_id[str(li_id)]
            existing.sku_code_id = sku_code_id
            existing.sku_version_id = sku_version_id
            existing.sku_code_snapshot = sku_code.code if sku_code else None
            existing.sku_version_snapshot = sku_version.version if sku_version else None
            existing.pallets_required = pallets_required
            existing.pcs = li.get("pcs")
            existing.pcs_per_sleeve = li.get("pcs_per_sleeve")

            request = (
                db.query(models.ShipmentPickingRequest)
                .filter(models.ShipmentPickingRequest.customer_shipment_line_item_id == existing.id)
                .first()
            )
            if request:
                request.shipment_number = shipment_number
                request.container_number = shipment.container_number
                request.customer = customer
                request.sku_code_id = sku_code_id
                request.sku_version_id = sku_version_id
                request.sku_code_snapshot = existing.sku_code_snapshot
                request.sku_version_snapshot = existing.sku_version_snapshot
                request.pallets_required = pallets_required
        else:
            new_item = models.CustomerShipmentLineItem(
                customer_shipment_id=shipment.id,
                sku_code_id=sku_code_id,
                sku_version_id=sku_version_id,
                sku_code_snapshot=sku_code.code if sku_code else None,
                sku_version_snapshot=sku_version.version if sku_version else None,
                pallets_required=pallets_required,
                pcs=li.get("pcs"),
                pcs_per_sleeve=li.get("pcs_per_sleeve"),
            )
            db.add(new_item)
            db.flush()
            db.add(models.ShipmentPickingRequest(
                customer_shipment_id=shipment.id,
                customer_shipment_line_item_id=new_item.id,
                shipment_number=shipment_number,
                container_number=shipment.container_number,
                customer=customer,
                sku_code_id=sku_code_id,
                sku_version_id=sku_version_id,
                sku_code_snapshot=new_item.sku_code_snapshot,
                sku_version_snapshot=new_item.sku_version_snapshot,
                pallets_required=pallets_required,
                status="pending",
            ))

    db.flush()
    return shipment


class CustomerShipmentEditBlocked(ValueError):
    """Raised by update_customer_shipment the moment a blocked line-item
    change is found -- api/customer_shipment.py's PUT route catches this
    and turns it into the same friendly 409 shape as blocked_delete_reason
    already gets for DELETE."""


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
