"""
RQC (Final Quality Control) -- the quality gate between IPQC and FG QR
Generation, per the corrected workflow:
  Material Consumption -> Production -> IPQC -> RQC -> FG QR Generation -> FG Storage

Auto-created (never duplicated) the moment the relevant Material Consumption
record is finalized -- see find_or_create_rqc, called from
material_consumption_service.finalize() immediately after find_or_create_ipqc
-- extending the existing Material Consumption -> Production -> IPQC
relationship one step further rather than inventing an unrelated trigger.
RQC's *creation* is therefore independent of IPQC's status: it exists as
Pending the moment Material Consumption is saved, and stays Pending until
its own inspection is completed and saved via api/rqc.py -- IPQC reaching
'approved' is never what creates or approves an RQC record.

RQC does not touch pallets at all: it reuses Production's own
total_fg_pallets count. Once an RQC record is saved as Approved,
api/rqc.py's save route calls the existing, unchanged
qr_generation_service.get_or_create_fg_qr_for_production_run -- the same
function Production's save route used to call unconditionally -- so the
only behavioral change is *when* that call happens, not what it does.

The 15-item defect grid (4 classification groups, each with its own AQL
accept/reject numbers) and the 4 COA parameter tables below are transcribed
verbatim from the HTML prototype's RQC_DEFECT_GROUPS / RQC_COA_* arrays --
fixed reference data, not stored per record, exactly like IPQC_DEFECTS.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import models

# No real upstream source for Manufacturer on RQC (same as IPQC) -- the
# prototype's own RQC form treats it as a plain, user-editable text field
# seeded with a placeholder. Matches IPQC_MANUFACTURER_PLACEHOLDER's pattern.
RQC_MANUFACTURER_PLACEHOLDER = "Cirkla Manufacturing (placeholder)"

# Transcribed verbatim from the prototype's RQC_DEFECT_GROUPS. Independent
# sr numbering space from IPQC_DEFECTS (1-15, not reused/shared) -- this was
# verified directly against the uploaded prototype HTML, not assumed.
RQC_DEFECT_GROUPS = [
    {
        "classification": "Unacceptable", "sampleSize": 800, "accept": 0, "reject": 1,
        "items": [
            {"sr": 1, "type": "Foreign Material (Insects , Hair and Dust)"},
            {"sr": 2, "type": "Metal Particles"},
            {"sr": 3, "type": "Lamination black spots (due to metal pieces)"},
        ],
    },
    {
        "classification": "Critical", "sampleSize": 800, "accept": 14, "reject": 15,
        "items": [
            {"sr": 4, "type": "Surface Cracks and Cuts"},
            {"sr": 5, "type": "Lamination bubbles on tray"},
            {"sr": 6, "type": "Stickiness of the Pad"},
            {"sr": 7, "type": "Placement Side of the Pad"},
        ],
    },
    {
        "classification": "Major", "sampleSize": 800, "accept": 21, "reject": 22,
        "items": [
            {"sr": 8, "type": "Direction of the Pad"},
            {"sr": 9, "type": "Lamination peel off"},
            {"sr": 10, "type": "Trimming burs"},
            {"sr": 11, "type": "Lamination film darkening"},
            {"sr": 12, "type": "Flange damage or bend"},
        ],
    },
    {
        "classification": "Minor", "sampleSize": 800, "accept": 53, "reject": 54,
        "items": [
            {"sr": 13, "type": "Color spots (Black, yellow etc)"},
            {"sr": 14, "type": "Watermarks or mold marks"},
            {"sr": 15, "type": "Lamination fold"},
        ],
    },
]

# sr -> reject threshold, flattened for cheap lookup when computing overall
# status (mirrors rqcRecalcResult's per-defect group lookup).
_REJECT_BY_SR: dict[int, int] = {
    item["sr"]: group["reject"] for group in RQC_DEFECT_GROUPS for item in group["items"]
}

RQC_COA_BASE = [
    {"sr": 1, "param": "Tray Colour", "spec": "Natural"},
    {"sr": 2, "param": "Tray Dimensions (L x W x H) mm", "spec": "As per specs"},
    {"sr": 3, "param": "Tray Weight with liner (g)", "spec": "As per specs"},
    {"sr": 4, "param": "Pad color", "spec": "As per specs"},
    {"sr": 5, "param": "Base material of Pad", "spec": "As per specs"},
    {"sr": 6, "param": "Dimensions of Pad", "spec": "As per specs"},
    {"sr": 7, "param": "Weight of pad with Base material", "spec": "As per specs"},
    {"sr": 8, "param": "Absorption Rate", "spec": "As per specs"},
]

RQC_COA_FUNCTIONAL = [
    {"sr": 1, "param": "Air gap (AB Stacking)", "spec": "1 sample set of 10 trays/pallet (Test procedure)"},
    {"sr": 2, "param": "Gravity fall (AB stacking)", "spec": "1 sample set of 10 trays/pallet (Test procedure)"},
]

RQC_COA_PACKING = [
    {"sr": 1, "param": "Pallet Box Dimensions", "spec": "As per specifications (Pallet Box need to be having 1500 Kgf)"},
    {"sr": 2, "param": "Trays/Bag", "spec": "As per specifications"},
    {"sr": 3, "param": "Bags/Pallet", "spec": "As per specifications"},
    {"sr": 4, "param": "Trays/Pallet", "spec": "As per specifications"},
    {"sr": 5, "param": "Tray Packing Direction in bags", "spec": "As per specifications"},
    {"sr": 6, "param": "Strapping & Angle Boards", "spec": "As per specifications"},
    {"sr": 7, "param": "Stretch wrapping of pallet boxes", "spec": "As per specifications"},
    {"sr": 8, "param": "Pallet Material and Quality", "spec": "As per specs - Plywood pallets"},
]

RQC_COA_PRINTING = [
    {"sr": 1, "param": "Artwork", "spec": "As per approved artwork"},
    {"sr": 2, "param": "Print shade", "spec": "As per approved artwork"},
    {"sr": 3, "param": "Barcode", "spec": "As per approved artwork"},
    {"sr": 4, "param": "Packing Label", "spec": "As per approved artwork"},
    {"sr": 5, "param": "Special Label", "spec": "As per approved artwork"},
]


def has_any_reject(defect_results) -> bool:
    """This IS the sampling plan's approval logic -- not a stand-in for it,
    and not a generic "any defect found = Hold" shortcut. Each defect_sr
    belongs to exactly one of the 4 RQC_DEFECT_GROUPS above, and each group
    carries its own independent accept/reject numbers (Unacceptable:
    reject at 1, Critical: reject at 15, Major: reject at 22, Minor:
    reject at 54) -- the same predefined thresholds the HTML prototype
    hardcodes in RQC_DEFECT_GROUPS. A row is NOT OK only once its own
    Found value reaches *that row's own group's* reject number
    (found >= threshold via _REJECT_BY_SR, a flattened sr -> group.reject
    lookup) -- exactly matching the prototype's rqcRecalcResult
    (`defectsFound >= group.reject`). The overall record is Hold if any one
    row is NOT OK, Approved otherwise -- exactly matching the prototype's
    rqcOverallStatus (`Object.keys(rqcResults).some(...notok...)`). Do not
    replace this with `any(d.found for d in defect_results)` or any other
    simplification that ignores each group's own threshold -- that would
    silently diverge from the prototype's actual sampling plan.
    """
    for d in defect_results:
        threshold = _REJECT_BY_SR.get(d.defect_sr)
        if threshold is not None and d.found is not None and d.found >= threshold:
            return True
    return False


def find_or_create_rqc(db: Session, ipqc: models.IpqcRecord) -> models.RqcRecord:
    """One RQC record per Production Run (unique constraint on
    production_run_id backstops this), auto-created the moment the relevant
    Material Consumption record is finalized -- called from
    material_consumption_service.finalize() immediately after
    find_or_create_ipqc, passing it the IPQC record just found-or-created
    (so ipqc_record_id and every upstream snapshot field are always
    available, regardless of that IPQC record's own status).

    Deliberately takes the *IpqcRecord*, not just the Production Run: this
    is what reuses the existing Material Consumption -> Production -> IPQC
    relationship (and its already-resolved UUID FKs / snapshot fields)
    instead of re-deriving Shipment Number / SKU Code / SKU Version from
    scratch a second time.

    IMPORTANT: this only ever creates RQC as Pending. It does not depend on,
    and must never be gated on, ipqc.status -- IPQC being 'approved' plays
    no role in RQC's creation, and it certainly does not approve RQC.
    RQC's own status only ever changes via its own save route
    (api/rqc.py), when its own inspection requirements are completed.

    Every upstream field (SKU Code/Version, Shipment Number) is copied from
    the IPQC record -- itself already a locked-in snapshot from Material
    Consumption -- so RQC never re-derives or re-queries further upstream.
    Manufacturer has no real upstream source (same as IPQC) so it's seeded
    with a placeholder and left genuinely user-editable.
    """
    existing = db.query(models.RqcRecord).filter(
        models.RqcRecord.production_run_id == ipqc.production_run_id
    ).first()
    if existing:
        return existing
    rec = models.RqcRecord(
        production_run_id=ipqc.production_run_id,
        ipqc_record_id=ipqc.id,
        sku_code_id=ipqc.sku_code_id,
        sku_version_id=ipqc.sku_version_id,
        sku_code_snapshot=ipqc.sku_code_snapshot,
        sku_version_snapshot=ipqc.sku_version_snapshot,
        shipment_number=ipqc.shipment_number,
        manufacturer=RQC_MANUFACTURER_PLACEHOLDER,
        status="pending",
    )
    db.add(rec)
    db.flush()
    return rec
