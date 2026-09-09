"""
Shipment Picking -- receives its requirements exclusively from Customer
Shipment (one ShipmentPickingRequest per Customer Shipment line item, see
customer_shipment_service.create_customer_shipment). This module never
creates its own requests and never triggers RQC.

Picking is genuine QR-scan-driven, one scan per pallet -- deliberately NOT
the prototype's own spScanForRequest(), which auto-picks the first
available FG pallet by SKU with no real scan at all. That is exactly the
kind of "obvious implementation limitation" the spec (point 27) says not to
copy: this app already has a hard, explicit rule against FIFO/auto-
assignment (see material_consumption_service.py's own docstring --
"Explicit scan-driven selection only: NEVER FIFO, NEVER auto-assignment"),
and Shipment Picking must follow it too.

Reuses existing entities rather than duplicating them:
  - Pallet.lifecycle_status ("stored" -> "picked") + PalletLifecycleEvent,
    exactly like every other stage transition in this app
    (pallet_service.record_lifecycle_event).
  - StorageRecord IS "currently in FG Storage" -- picking a pallet deletes
    its StorageRecord (freeing the location), undoing a pick recreates one
    at the remembered prior location.
  - ShipmentPickingPick is the one genuinely new piece of information
    nothing existing tracks: which specific pallet was picked against
    which request, from which location (needed for undo).
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import models
from app.domain.pallet_service import record_lifecycle_event, resolve_pallet_from_scan


class PickError(Exception):
    """Raised for any pick validation failure; api/shipment_picking.py maps
    this to a 400 with the message as-is."""


def _recompute_status(request: models.ShipmentPickingRequest, picked_count: int) -> None:
    if picked_count <= 0:
        request.status = "pending"
    elif picked_count >= request.pallets_required:
        request.status = "complete"
    else:
        request.status = "partial"


def pick_pallet_for_request(
    db: Session,
    request: models.ShipmentPickingRequest,
    raw_scan: str,
    actor_user_id=None,
) -> models.ShipmentPickingPick:
    """Validates the scanned pallet against this request, then atomically:
    records the pick, frees its StorageRecord, and records the 'picked'
    lifecycle event. Never allows picking past pallets_required (spec point
    18's "cannot scan/pick more pallets than this quantity")."""
    if request.status == "complete":
        raise PickError("This shipment picking request is already complete.")

    pallet = resolve_pallet_from_scan(db, raw_scan, "fg")
    if pallet is None:
        raise PickError("Pallet not found for this scan.")

    if pallet.lifecycle_status != "stored":
        raise PickError(f"Pallet {pallet.display_id} is not currently in FG Storage.")

    if pallet.sku_code_id != request.sku_code_id or pallet.sku_version_id != request.sku_version_id:
        raise PickError(
            f"Pallet {pallet.display_id} does not match this request's SKU / Version."
        )

    already = (
        db.query(models.ShipmentPickingPick)
        .filter(models.ShipmentPickingPick.shipment_picking_request_id == request.id)
        .filter(models.ShipmentPickingPick.pallet_id == pallet.id)
        .first()
    )
    if already:
        raise PickError(f"Pallet {pallet.display_id} has already been picked for this request.")

    picked_count = (
        db.query(models.ShipmentPickingPick.id)
        .filter(models.ShipmentPickingPick.shipment_picking_request_id == request.id)
        .count()
    )
    if picked_count >= request.pallets_required:
        raise PickError("This request already has its required number of pallets picked.")

    storage_record = (
        db.query(models.StorageRecord).filter(models.StorageRecord.pallet_id == pallet.id).first()
    )
    location_id = storage_record.location_id if storage_record else None
    if storage_record:
        db.delete(storage_record)

    pick = models.ShipmentPickingPick(
        shipment_picking_request_id=request.id,
        pallet_id=pallet.id,
        location_id=location_id,
        picked_by=actor_user_id,
    )
    db.add(pick)

    record_lifecycle_event(db, pallet, "picked", actor_user_id=actor_user_id, shipment_picking_request_id=str(request.id))

    _recompute_status(request, picked_count + 1)
    db.flush()
    return pick


def remove_pick(db: Session, pick: models.ShipmentPickingPick, actor_user_id=None) -> None:
    """Undo: recreates a StorageRecord at the pallet's remembered prior
    location and records a 'stored' lifecycle event again, matching the
    exact reverse of pick_pallet_for_request. Blocked once the request is
    already 'complete' -- matches the prototype's own hidden-remove-link
    behavior, but enforced server-side rather than just hidden in the UI."""
    request = pick.request
    if request.status == "complete":
        raise PickError("Cannot remove a pick from an already-complete request.")

    pallet = pick.pallet
    if pick.location_id:
        db.add(models.StorageRecord(
            storage_type="fg",
            pallet_id=pallet.id,
            location_id=pick.location_id,
            source_qr_generation_id=pallet.source_qr_generation_id,
            source_production_run_id=pallet.source_production_run_id,
            stored_by=actor_user_id,
        ))
    record_lifecycle_event(db, pallet, "stored", actor_user_id=actor_user_id)

    remaining = (
        db.query(models.ShipmentPickingPick.id)
        .filter(models.ShipmentPickingPick.shipment_picking_request_id == request.id)
        .filter(models.ShipmentPickingPick.id != pick.id)
        .count()
    )
    db.delete(pick)
    _recompute_status(request, remaining)
    db.flush()
