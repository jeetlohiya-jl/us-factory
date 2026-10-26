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
# Tray-family categories are auto-created from an approved Inward Vehicle
# Inspection (see vehicle_inspection_service.propagate_to_qc) rather than
# created manually here, and skip the sampling-plan/attribute-definition
# flow every MANUAL_CATEGORIES record goes through in favour of the fixed
# fgtray_answers checklist -- "fgtray" was the only member of this set
# historically (from the Tray/"RM" IVI category); "lnp_tray" (LNP
# Tray) is the same kind of downstream QC record for the LNP Tray IVI
# category, added so its category is never silently remapped to something
# else. RM and LNP Tray are genuinely different materials (today
# only LNP Tray is an active workflow; RM is wired up for future
# use), each producing its own correctly-labeled QC record.
TRAY_FAMILY_CATEGORIES = {"tray", "lnp_tray", "fgtray"}
# India report forms (migration 0084). film / corner_protector exist only as
# Goods Receipt-created QC records (never created by hand); the rest of the
# India forms are additional "form keys" of existing categories -- see
# form_key().
REPORT_CATEGORIES = {"film", "corner_protector"}
ALL_CATEGORIES = MANUAL_CATEGORIES | TRAY_FAMILY_CATEGORIES | REPORT_CATEGORIES
INDIA_FORM_KEYS = {"rm_tray", "in_pad", "in_polybag", "in_cfb", "film", "corner_protector"}
# Every key that has field definitions (what /meta returns).
FORM_KEYS = MANUAL_CATEGORIES | INDIA_FORM_KEYS

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
    # India report forms -- the label each printed report uses.
    "rm_tray": "Conclusion",
    "in_pad": "Suggestions",
    "in_polybag": "Remarks",
    "in_cfb": "Conclusion",
    "film": "Conclusion",
    "corner_protector": "Suggestions",
}
QC_COUNT_LABEL.update({
    "rm_tray": "No. of Samples Checked",
    "in_pad": "No. of pads checked",
    "in_polybag": "No. of bags checked",
    "in_cfb": "No. of box checked",
    "film": "No. of rolls checked",
    "corner_protector": "No. of Corner Protector checked",
})


def form_key(qc: models.InwardQcRecord) -> str:
    """Which field-definition / sampling-plan set a QC record uses. A QC that
    came from a Goods Receipt entry (Falcon) uses the form built from
    that material's inward QC report; everything else keeps the original
    category-keyed forms, so Gainesville is untouched. LNP Tray and Glue have
    no report and keep their existing form."""
    if qc.source_goods_receipt_entry_id is not None:
        if qc.category == "tray":
            return "rm_tray"
        if qc.category in ("pad", "polybag", "cfb"):
            return "in_" + qc.category
    return qc.category


def uses_fgtray(qc: models.InwardQcRecord) -> bool:
    """True for the fixed OK / NOT OK checklist (LNP Tray, and tray QCs that
    did not come from a Goods Receipt entry); False for every attribute form,
    including the India RM Tray report form."""
    return qc.category in TRAY_FAMILY_CATEGORIES and form_key(qc) != "rm_tray"


def next_shipment_number(db: Session, category: str) -> tuple[str, bool]:
    if category in TRAY_FAMILY_CATEGORIES:
        return "", False  # fgtray shipment number always mirrors the source Vehicle Inspection
    prefix = QC_ID_PREFIX[category]
    yymm = datetime.now(timezone.utc).strftime("%y%m")
    seq = next_seq(db, f"qc_shipment:{category}")
    return f"{prefix}-{yymm}-{str(seq).zfill(4)}", True


def quantity_label_for(db: Session, category: str) -> str:
    if category in TRAY_FAMILY_CATEGORIES:
        return "No. of Pallets"
    tier = db.query(models.InwardQcSamplingPlanTier).filter(models.InwardQcSamplingPlanTier.category == category).first()
    return tier.qty_label if tier else "Quantity"


def tier_for(db: Session, category: str, qty: float, strict: bool = False) -> models.InwardQcSamplingPlanTier | None:
    """strict (India report forms): a lot size that falls in no printed tier
    has no plan -- nothing is guessed. The original forms keep falling back to
    the last tier."""
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
    return None if strict else tiers[-1]


def compute_sampling_plan(db: Session, category: str, qty: float | None, strict: bool = False) -> dict | None:
    """Mirrors qcComputeSamplingPlan(). Returns None while quantity/category
    are missing, exactly like the prototype leaves the callout blank."""
    if not category or qty is None or qty <= 0:
        return None
    if category in TRAY_FAMILY_CATEGORIES:
        return {"sample_size": "Full carton-box check", "upper_limit": "0", "note": None, "sampling_approach": "Fixed 3-point box check"}
    tier = tier_for(db, category, qty, strict)
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


def _num(value) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def lot_quantity(db: Session, qc: models.InwardQcRecord) -> float | None:
    """The quantity the sampling plan is looked up with. Original forms: the
    QC's own quantity. India report forms: the field that drives the plan --
    pieces / rolls received (lot_role 'lot_qty'), or, for the RM Tray report,
    Quantity/Pallet x pallets received (the plan counts pieces per container)."""
    key = form_key(qc)
    if key not in INDIA_FORM_KEYS:
        return float(qc.quantity) if qc.quantity else None
    values = {v.attribute_definition_id: v.value for v in qc.attribute_values}
    defs = get_attribute_definitions(db, key)
    if key == "rm_tray":
        per = next((_num(values.get(d.id)) for d in defs if d.lot_role == "qty_per_pallet"), None)
        pallets = float(qc.quantity) if qc.quantity else None
        return per * pallets if per and per > 0 and pallets else None
    lot = next((_num(values.get(d.id)) for d in defs if d.lot_role == "lot_qty"), None)
    return lot if lot and lot > 0 else None


def sampling_plan_for(db: Session, qc: models.InwardQcRecord) -> dict | None:
    if uses_fgtray(qc):
        return compute_sampling_plan(db, qc.category, float(qc.quantity) if qc.quantity else None)
    key = form_key(qc)
    return compute_sampling_plan(db, key, lot_quantity(db, qc), strict=key in INDIA_FORM_KEYS)


def evaluate(db: Session, qc: models.InwardQcRecord) -> dict:
    """The one place a QC's completeness and outcome are decided. Returns
    {complete, outcome, missing, messages, failed_count, upper_limit,
    lot_quantity, sampling}; outcome is pending / accepted / onhold.

    Original forms (Gainesville) behave exactly as before. India report forms
    add: numeric fields must be valid non-negative numbers, dropdown fields
    must hold one of their options, and the outcome follows the report --
      * RM Tray: defects found across the sample > the sampling plan's upper
        limit (6 / 8), or a defect over its own printed limit (Metal burrs 1,
        Uneven thickness 2, Holes 1)  ->  On Hold (100% inspection);
      * RM Film: "Accept / Reject" = Reject  ->  On Hold;
      * Soaker Pad / Polybag / CFB / Corner Protector: their reports have no
        failed-count field, so a complete inspection is Accepted.
    """
    key = form_key(qc)
    if uses_fgtray(qc):
        status = compute_fgtray_status(db, qc)
        answers = {a.criteria_id: a.answer for a in qc.fgtray_answers}
        unanswered = [c.label for c in get_fgtray_criteria(db) if answers.get(c.id) not in ("ok", "not_ok")]
        return {"complete": status != "pending", "outcome": status, "missing": unanswered, "messages": [],
                "failed_count": sum(1 for a in answers.values() if a == "not_ok"), "upper_limit": 0,
                "lot_quantity": None, "sampling": sampling_plan_for(db, qc)}

    defs = get_attribute_definitions(db, key)
    values = {v.attribute_definition_id: v.value for v in qc.attribute_values}
    india = key in INDIA_FORM_KEYS
    missing: list[str] = []
    messages: list[str] = []
    for d in defs:
        val = values.get(d.id)
        blank = val in (None, "") or not str(val).strip()
        if blank:
            # A defect count left empty means none found (0): never "missing".
            if d.is_required and not (india and d.section == "defect"):
                missing.append(d.label)
            continue
        if not india:
            continue
        if d.field_type == "number":
            n = _num(val)
            if n is None or n < 0:
                missing.append(f"{d.label} (enter a number, 0 or more)")
            elif d.section == "defect" and n != int(n):
                missing.append(f"{d.label} (enter a whole number)")
        elif d.field_type == "dropdown" and d.options_json and val not in d.options_json:
            missing.append(f"{d.label} (choose one of the options)")
    # The Falcon report forms' Suggestions / Conclusion box is optional; the
    # original (Gainesville) forms still need it.
    if not india and not (qc.conclusion_or_suggestions or "").strip():
        missing.append(CONCLUSION_LABEL.get(key, "Conclusion"))

    lot = lot_quantity(db, qc)
    plan = sampling_plan_for(db, qc)
    if india and lot and plan is None:
        messages.append(f"The report's sampling plan has no entry for a lot of {lot:g}; confirm the sample size with QA.")

    failed = None
    upper = None
    outcome = "pending" if missing else "accepted"
    if india and not missing:
        if key == "rm_tray":
            upper = int(plan["upper_limit"]) if plan and plan.get("upper_limit") is not None else None
            if upper is None:
                missing.append("Sampling plan (enter Quantity/Pallet within the report's plan)")
                outcome = "pending"
            else:
                failed = 0
                over = []
                for d in defs:
                    if d.section != "defect":
                        continue
                    n = int(_num(values.get(d.id)) or 0)
                    failed += n
                    lim = _num(d.acceptable_limit)
                    if lim is not None and n > lim:
                        over.append(f"{d.label} {n} > limit {int(lim)}")
                if failed > upper:
                    messages.append(f"{failed} failed products exceeds the upper limit of {upper}: 100% inspection to be followed.")
                if over:
                    messages.append("Over a defect's acceptable limit: " + "; ".join(over) + ".")
                outcome = "onhold" if (failed > upper or over) else "accepted"
        elif key == "film":
            decision = next((values.get(d.id) for d in defs if d.label == "Accept / Reject"), None)
            if decision == "Reject":
                outcome = "onhold"
                messages.append("Rejected: failed rolls to be kept separate in the quarantine area.")
    return {"complete": not missing, "outcome": outcome, "missing": missing, "messages": messages,
            "failed_count": failed, "upper_limit": upper, "lot_quantity": lot, "sampling": plan}


def compute_status(db: Session, qc: models.InwardQcRecord) -> str:
    return evaluate(db, qc)["outcome"]


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
