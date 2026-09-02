"""
Business logic for Inward QC. Faithfully reproduces the approved HTML
prototype's rules (QC_ATTRS, SAMPLING_PLANS, qcRecalcStatus) rather than any
invented simplification — see the migration seed data for the exact
reference values these functions look up.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.db import models
from app.domain.id_counters import next_seq

MANUAL_CATEGORIES = {"pad", "polybag", "cfb", "glue"}
ALL_CATEGORIES = MANUAL_CATEGORIES | {"fgtray"}

QC_ID_PREFIX = {"pad": "US-PAD", "polybag": "US-PB", "cfb": "US-CFB", "glue": "US-GLUE"}

QC_COUNT_LABEL = {
    "pad": "Number of pads to be checked",
    "polybag": "Number of bags to be checked",
    "cfb": "Number of bags to be checked",
    "glue": "Number of units to be checked",
}

CONCLUSION_LABEL = {
    "pad": "Suggestions",
    "polybag": "Conclusion",
    "cfb": "Conclusion",
    "glue": "Conclusion",
}


def next_shipment_number(db: Session, category: str) -> tuple[str, bool]:
    if category == "fgtray":
        return "", False  # fgtray shipment number always mirrors the source Vehicle Inspection
    prefix = QC_ID_PREFIX[category]
    yymm = datetime.now(timezone.utc).strftime("%y%m")
    seq = next_seq(db, f"qc_shipment:{category}")
    return f"{prefix}-{yymm}-{str(seq).zfill(4)}", True


def quantity_label_for(db: Session, category: str) -> str:
    if category == "fgtray":
        return "No. of Pallets"
    tier = db.query(models.InwardQcSamplingPlanTier).filter(models.InwardQcSamplingPlanTier.category == category).first()
    return tier.qty_label if tier else "Quantity"


def tier_for(db: Session, category: str, qty: float) -> models.InwardQcSamplingPlanTier | None:
    tiers = (
        db.query(models.InwardQcSamplingPlanTier)
        .filter(models.InwardQcSamplingPlanTier.category == category)
        .order_by(models.InwardQcSamplingPlanTier.sort_order)
        .all()
    )
    if not tiers:
        return None
    for t in tiers:
        min_q = float(t.min_qty or 0)
        max_q = float(t.max_qty) if t.max_qty is not None else float("inf")
        if min_q <= qty <= max_q:
            return t
    return tiers[-1]


def compute_sampling_plan(db: Session, category: str, qty: float | None) -> dict | None:
    """Mirrors qcComputeSamplingPlan(). Returns None while quantity/category
    are missing, exactly like the prototype leaves the callout blank."""
    if not category or qty is None or qty <= 0:
        return None
    if category == "fgtray":
        return {"sample_size": "Full carton-box check", "upper_limit": "0", "note": None, "sampling_approach": "Fixed 3-point box check"}
    tier = tier_for(db, category, qty)
    if not tier:
        return None
    return {
        "sample_size": str(tier.sample_size),
        "upper_limit": (str(tier.upper_limit) if tier.upper_limit is not None else None),
        "note": tier.note,
    }


def get_attribute_definitions(db: Session, category: str) -> list[models.InwardQcAttributeDefinition]:
    return (
        db.query(models.InwardQcAttributeDefinition)
        .filter(models.InwardQcAttributeDefinition.category == category, models.InwardQcAttributeDefinition.is_active.is_(True))
        .order_by(models.InwardQcAttributeDefinition.sort_order)
        .all()
    )


def get_fgtray_criteria(db: Session) -> list[models.InwardQcFgtrayCriterion]:
    return (
        db.query(models.InwardQcFgtrayCriterion)
        .filter(models.InwardQcFgtrayCriterion.is_active.is_(True))
        .order_by(models.InwardQcFgtrayCriterion.sort_order)
        .all()
    )


def compute_fgtray_status(db: Session, qc: models.InwardQcRecord) -> str:
    """Mirrors qcRecalcStatus() for category === 'fgtray': incomplete stays
    Pending; once every criterion is answered, NOT OK count > upper limit
    (0 for fgtray) means On Hold, otherwise Accepted."""
    criteria = get_fgtray_criteria(db)
    if not criteria:
        return "pending"
    answers = {a.criteria_id: a.answer for a in qc.fgtray_answers}
    answered = [answers.get(c.id) for c in criteria]
    complete = all(a in ("ok", "not_ok") for a in answered)
    if not complete:
        return "pending"
    failed = sum(1 for a in answered if a == "not_ok")
    upper = 0  # fgtray's fixed upper limit for acceptance, per the prototype
    return "onhold" if failed > upper else "accepted"


def compute_manual_status(db: Session, qc: models.InwardQcRecord) -> str:
    """Mirrors qcRecalcStatus() for pad/polybag/cfb/glue: complete once every
    required attribute is filled AND the conclusion/suggestions field is
    non-empty; the prototype has no On Hold branch for these categories."""
    defs = get_attribute_definitions(db, qc.category)
    values = {v.attribute_definition_id: v.value for v in qc.attribute_values}
    all_required_filled = all(
        (values.get(d.id) not in (None, "")) for d in defs if d.is_required
    )
    conclusion_filled = bool((qc.conclusion_or_suggestions or "").strip())
    return "accepted" if (all_required_filled and conclusion_filled) else "pending"


def compute_status(db: Session, qc: models.InwardQcRecord) -> str:
    if qc.category == "fgtray":
        return compute_fgtray_status(db, qc)
    return compute_manual_status(db, qc)


def is_qc_blank(qc: models.InwardQcRecord) -> bool:
    if qc.vendor_name or qc.quantity or qc.sku_code_id or qc.coa_storage_path or qc.conclusion_or_suggestions:
        return False
    if any(v.value for v in qc.attribute_values):
        return False
    if any(a.answer for a in qc.fgtray_answers):
        return False
    return True
