"""
Outward Vehicle Inspection (OVI) -- downstream of Customer Shipment:
  Customer Shipment -> (Shipment Picking) -> Outward Vehicle Inspection

Auto-created (never manually) the instant a Customer Shipment is recorded
-- see create_pending_for_shipment, called from customer_shipment_service.
create_customer_shipment() in the same atomic transaction. NOT linked to
RQC in any way (explicit clarification: RQC and OVI are separate chains in
this app). Idempotency is guaranteed structurally: Customer Shipment is
itself create-once (no retry path creates a second CS row), and the unique
constraint on outward_vehicle_inspections.customer_shipment_id (migration
0021) is the hard backstop against ever having two OVI rows for one CS.

The 7 vehicle-condition checks are fixed reference data -- hardcoded here
exactly like RQC_DEFECT_GROUPS/IPQC's 8-item grid, not stored in a
checklist_items table (see migration 0021's header notes). Answers are
keyed by this plain integer `sr`, never by the label text, so the wording
below can be edited freely without touching any stored per-record answer.

2026-09-28 -- reworded to match the "Vehicle is clean & dry / No
objectionable odour / ..." reference checklist (the same 7-item list
Factory's own Inward Vehicle Inspection checklist was seeded with in
migration 0066), at the user's request for Goods Outward's new
"pick pallets -> Outward Vehicle Inspection" flow. This list is shared by
both products (OVI has no per-unit checklist mechanism, unlike Inward
Vehicle Inspection's real `inward_vehicle_inspection_checklist_items`
table) -- US Factory's existing OVI records are unaffected since only the
label text changed, not the `sr` values their answers are keyed by.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import models

OVI_QUESTIONS = [
    {"sr": 1, "label": "Vehicle is clean & dry"},
    {"sr": 2, "label": "No objectionable odour"},
    {"sr": 3, "label": "No insects, rodents or signs of pest activity"},
    {"sr": 4, "label": "No floor damage or contamination risk"},
    {"sr": 5, "label": "No water leakage"},
    {"sr": 6, "label": "No rust inside the container / trailer"},
    {"sr": 7, "label": "No damaged boxes/packages observed"},
]

_REQUIRED_SRS = {q["sr"] for q in OVI_QUESTIONS}

# Fixed loading-photo slots, transcribed from the "Loading Container
# Process" template (D69-1.7C) -- one named slot per row/photo, same
# "hardcoded reference data" convention as OVI_QUESTIONS above rather than
# a configurable checklist table (the row count/labels are a fixed company
# form, not something operators define per-shipment). Each slot holds at
# most one photo at a time (replace, not add-more) -- same UI convention as
# Inward Vehicle Inspection's single-image fields (container/truck/seal/
# condition/empty_container).
OVI_IMAGE_TYPES: list[dict[str, str]] = [
    {"key": "license_plate", "label": "License Plate"},
    {"key": "container_number", "label": "Container Number"},
    {"key": "before_loading", "label": "Before Loading"},
    {"key": "row_1", "label": "First Row"},
    {"key": "row_2", "label": "Second Row"},
    {"key": "row_3", "label": "Third Row"},
    {"key": "row_4", "label": "Fourth Row"},
    {"key": "row_5", "label": "Fifth Row"},
    {"key": "row_6", "label": "Sixth Row"},
    {"key": "row_7", "label": "Seventh Row"},
    {"key": "row_8", "label": "Eighth Row"},
    {"key": "row_9", "label": "Ninth Row"},
    {"key": "row_10", "label": "Tenth Row"},
    {"key": "row_11", "label": "Eleventh Row"},
    {"key": "seal_half", "label": "Seal Half of the Container"},
    {"key": "seal_entire", "label": "Seal the Entire Container"},
    {"key": "lead_seal", "label": "Lead Seal"},
    {"key": "weighbridge_record", "label": "Weigh Bridge Record"},
]

ALL_OVI_IMAGE_TYPES = {t["key"] for t in OVI_IMAGE_TYPES}


def create_pending_for_shipment(db: Session, shipment: models.CustomerShipment) -> models.OutwardVehicleInspection:
    """
    Called from customer_shipment_service.create_customer_shipment() inside
    its own transaction/flush -- not committed here. Shipment Number,
    Customer Name, and Quantity (total required pallets across every line
    item) are snapshotted from the Customer Shipment at creation time so
    the OVI form never re-asks for information the system already knows
    (spec: "Do not ask the user to manually re-enter information that the
    system already knows"). Everything else (Truck, Invoice, Transporter,
    Seal) has no upstream source and is left for manual entry, same as
    RQC's Manufacturer field.
    """
    total_pallets = sum(li.pallets_required for li in shipment.line_items)
    ovi = models.OutwardVehicleInspection(
        customer_shipment_id=shipment.id,
        shipment_number=shipment.shipment_number,
        customer_name=shipment.customer,
        quantity=str(total_pallets) if total_pallets else None,
        status="pending",
    )
    db.add(ovi)
    db.flush()
    return ovi


def compute_status(save_mode: str, answers: dict[int, str | None]) -> str:
    """
    - save_mode == 'draft' -> 'draft' unconditionally (Save Draft), same
      convention as RQC/IPQC.
    - save_mode == 'final' (the Step 2 "Save" button):
        - any of the 7 required questions unanswered -> 'pending' (spec:
          "Do not allow an incomplete inspection to become Approved" /
          "status remains Pending"). This is NOT a simplistic "at least one
          answer exists" check -- every required sr must be present with a
          non-null answer.
        - all 7 answered and any is 'not_ok' -> 'hold'.
        - all 7 answered and every one is 'ok' -> 'approved'.
    """
    if save_mode == "draft":
        return "draft"
    all_answered = all(answers.get(sr) in ("ok", "not_ok") for sr in _REQUIRED_SRS)
    if not all_answered:
        return "pending"
    if any(answers.get(sr) == "not_ok" for sr in _REQUIRED_SRS):
        return "hold"
    return "approved"
