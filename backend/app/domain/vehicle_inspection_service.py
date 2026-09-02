"""
Business logic for Inward Vehicle Inspection. Depends only on the DB
session and the OcrPort/StoragePort interfaces — never directly on
Tesseract, the filesystem, or Supabase, so those can be swapped without
touching this file.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session, joinedload

from app.db import models
from app.domain.id_counters import next_seq

CATEGORY_PREFIX = {
    "tray": None,  # manual shipment number for tray
    "pad": "US-PAD",
    "polybag": "US-PB",
    "cfb": "US-CFB",
    "glue": "US-GLUE",
}


def next_shipment_number(db: Session, category: str) -> tuple[str, bool]:
    """Returns (shipment_number, is_auto). Tray categories are entered manually
    by the user (is_auto False, caller must supply shipment_number)."""
    prefix = CATEGORY_PREFIX.get(category)
    if prefix is None:
        return "", False
    yymm = datetime.now(timezone.utc).strftime("%y%m")
    seq = next_seq(db, f"ivi_shipment:{category}")
    return f"{prefix}-{yymm}-{str(seq).zfill(4)}", True


def recompute_total_quantity(inspection: models.InwardVehicleInspection):
    total = sum((li.quantity or 0) for li in inspection.line_items)
    inspection.total_quantity = total


def required_checklist_ids(db: Session) -> list[uuid.UUID]:
    items = db.query(models.ChecklistItem).filter(models.ChecklistItem.is_active.is_(True)).all()
    return [i.id for i in items]


def checklist_is_complete(db: Session, inspection_id: uuid.UUID) -> bool:
    required = set(str(i) for i in required_checklist_ids(db))
    if not required:
        return False
    answers = (
        db.query(models.InwardVehicleInspectionChecklistAnswer)
        .filter(models.InwardVehicleInspectionChecklistAnswer.inspection_id == inspection_id)
        .all()
    )
    answered = {str(a.checklist_item_id): a.answer for a in answers if a.answer in ("ok", "not_ok")}
    return required.issubset(answered.keys())


def compute_status(db: Session, inspection_id: uuid.UUID) -> str:
    answers = (
        db.query(models.InwardVehicleInspectionChecklistAnswer)
        .filter(models.InwardVehicleInspectionChecklistAnswer.inspection_id == inspection_id)
        .all()
    )
    if any(a.answer == "not_ok" for a in answers):
        return "hold"
    return "approved"


def propagate_to_qc(db: Session, inspection: models.InwardVehicleInspection) -> models.InwardQcRecord | None:
    """When an approved Inward Vehicle Inspection for the Tray category (which
    feeds FG Non-Padded Tray Inward QC) reaches Approved, ensure exactly one
    linked Inward QC record exists. Never creates a duplicate."""
    if inspection.category != "tray" or inspection.status != "approved":
        return None
    existing = (
        db.query(models.InwardQcRecord)
        .filter(models.InwardQcRecord.linked_vehicle_inspection_id == inspection.id)
        .first()
    )
    if existing:
        return existing
    qc = models.InwardQcRecord(
        shipment_number=inspection.shipment_number,
        is_auto_shipment_number=False,  # mirrors the Vehicle Inspection's own shipment number, not QC's own sequence
        category="fgtray",
        status="pending",
        linked_vehicle_inspection_id=inspection.id,
        vendor_name=inspection.vendor_name,
        vendor_id=inspection.vendor_id,
        quantity=inspection.total_quantity,
        quantity_label="No. of Pallets",
    )
    db.add(qc)
    db.flush()
    # Historical snapshot of the Vehicle Inspection's SKU/Version/Quantity
    # line items at the moment the Tray QC is created — the QC's own display
    # must not change later if the Vehicle Inspection is subsequently edited.
    for i, li in enumerate(inspection.line_items):
        db.add(models.InwardQcLineItemSnapshot(
            inward_qc_id=qc.id,
            sku_code_id=li.sku_code_id,
            sku_version_id=li.sku_version_id,
            sku_code_snapshot=li.sku_code.code if li.sku_code else None,
            sku_version_snapshot=li.sku_version.version if li.sku_version else None,
            quantity=li.quantity,
            sort_order=i,
        ))
    db.flush()
    return qc


def find_dependent_qc(db: Session, inspection_id: uuid.UUID) -> models.InwardQcRecord | None:
    return (
        db.query(models.InwardQcRecord)
        .filter(models.InwardQcRecord.linked_vehicle_inspection_id == inspection_id)
        .first()
    )


def is_inspection_blank(inspection: models.InwardVehicleInspection) -> bool:
    """Used to silently discard an auto-created draft the user opened but
    never actually filled in (e.g. opened the wizard, then hit Cancel)."""
    fields = [
        inspection.shipment_number, inspection.truck_number, inspection.container_number,
        inspection.vendor_name, inspection.invoice_number, inspection.transporter_name,
        inspection.seal_number, inspection.remarks,
    ]
    if any(f for f in fields):
        return False
    if inspection.line_items:
        return False
    if inspection.images:
        return False
    answered = [a for a in inspection.checklist_answers if a.answer]
    if answered:
        return False
    return True
