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


# Process-lifetime caches -- both of these are fixed reference data with no
# admin UI or API route that ever mutates them (only migrations seed
# attribute definitions/fgtray criteria), yet _serialize_detail re-queried
# one of them on every single inward-qc read/write (basic update, COA
# upload, attribute save, submit, save-draft -- every round trip). Rows are
# expunged so they're safe to reuse across unrelated DB sessions; nothing
# lazy-loads on them afterward (callers only read plain columns already
# selected by the query). A fresh deploy/restart naturally picks up any
# future migration change.
_attribute_definitions_cache: dict[str, list[models.InwardQcAttributeDefinition]] = {}
_fgtray_criteria_cache: list[models.InwardQcFgtrayCriterion] | None = None


def get_attribute_definitions(db: Session, category: str) -> list[models.InwardQcAttributeDefinition]:
    cached = _attribute_definitions_cache.get(category)
    if cached is None:
        cached = (
            db.query(models.InwardQcAttributeDefinition)
            .filter(models.InwardQcAttributeDefinition.category == category, models.InwardQcAttributeDefinition.is_active.is_(True))
            .order_by(models.InwardQcAttributeDefinition.sort_order)
            .all()
        )
        for d in cached:
            db.expunge(d)
        _attribute_definitions_cache[category] = cached
    return cached


def get_fgtray_criteria(db: Session) -> list[models.InwardQcFgtrayCriterion]:
    global _fgtray_criteria_cache
    if _fgtray_criteria_cache is None:
        items = (
            db.query(models.InwardQcFgtrayCriterion)
            .filter(models.InwardQcFgtrayCriterion.is_active.is_(True))
            .order_by(models.InwardQcFgtrayCriterion.sort_order)
            .all()
        )
        for i in items:
            db.expunge(i)
        _fgtray_criteria_cache = items
    return _fgtray_criteria_cache


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


def find_dependent_qr(db: Session, qc_id: uuid.UUID) -> models.QrGenerationRecord | None:
    """Delete-safety check mirroring vehicle_inspection_service.find_dependent_qc:
    QrGenerationRecord.source_inward_qc_id, Pallet.source_inward_qc_id, and
    StorageRecord.source_inward_qc_id all reference this table with no ON
    DELETE clause, so deleting a QC record that's already generated RM QR
    pallets would otherwise hit a raw, unhandled IntegrityError instead of
    a clean message -- this is the one delete route that was missing this
    check (see the database audit)."""
    return (
        db.query(models.QrGenerationRecord)
        .filter(models.QrGenerationRecord.source_inward_qc_id == qc_id)
        .first()
    )


def is_qc_blank(qc: models.InwardQcRecord) -> bool:
    if qc.vendor_name or qc.quantity or qc.sku_code_id or qc.coa_storage_path or qc.conclusion_or_suggestions:
        return False
    if any(v.value for v in qc.attribute_values):
        return False
    if any(a.answer for a in qc.fgtray_answers):
        return False
    return True
