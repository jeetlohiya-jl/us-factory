"""
RQC (Final Quality Control) -- the quality gate between IPQC and FG QR
Generation.

RQC is created MANUALLY ONLY -- via "+ New Record" (see create_rqc below,
called from app/api/rqc.py's POST route). It is explicitly NOT auto-created
from Material Consumption/IPQC (an earlier design did this; that trigger has
been removed per updated requirements). Shipment Number is the required,
unique, user-entered key: create_rqc uses it to look up the IPQC record
already carrying that same shipment_number (IPQC's own shipment_number is
itself a locked-in snapshot from Material Consumption) and, when a match
exists, links to its real Production Run / IPQC UUIDs and snapshots its
SKU -- never creating a duplicate Production or IPQC record.

2026-09-17 -- IPQC is optional (a shipment can validly reach RQC without one
ever being filled in). When there is no IPQC match, create_rqc now falls
back one hop further upstream to the Production Run itself, via
find_linked_production_run_by_shipment_number: the same shipment number is
already reachable there too, carried on whichever primary RM pallet was
consumed into it (set back at Inward VI/QC time), with no new manual-entry
field needed anywhere -- see that function's docstring. This is what lets
Shift/Date/SKU Code/SKU Version populate for an RQC record even when IPQC
was skipped for its shipment.

No match at all (neither IPQC nor Production Run) is still not an error:
the RQC record is still created (Pending, unlinked), since the matching
upstream record may not exist yet.

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
# 2026-09-17: Manufacturer is no longer user-entered anywhere in RQC -- it's
# always this fixed value, matching the fact every RQC activity happens at
# this one Cirkla US factory. create_rqc below ignores any caller-supplied
# manufacturer and always uses this constant.
RQC_MANUFACTURER_PLACEHOLDER = "Cirkla INC"

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


class RqcError(Exception):
    pass


def _run_total_pallets_produced(run: models.ProductionRun) -> int:
    """Production's own count of FG pallets actually produced for this run,
    per machine + shift (migration 0039, task section 1) -- summed across
    every machine entry belonging to every Material Consumption record that
    feeds this run. This is the hard ceiling create_approval_entry checks
    RQC's approved pallets against; never total_fg_pallets (legacy/unused as
    of migration 0030) and never derived from RQC's own numbers."""
    total = 0
    for mc in run.material_consumptions:
        for e in mc.machine_entries:
            total += int(e.pallets_produced or 0)
    return total


BLOCKED_DELETE_MESSAGE = (
    "This RQC record can't be deleted because at least one of its approval entries has already "
    "generated FG QR codes/pallets. Deleting it would orphan real, already-issued pallets."
)


def blocked_delete_reason(db: Session, rqc: models.RqcRecord) -> str | None:
    """Returns a friendly block message if deleting this record would
    orphan a real, already-generated FG QR batch (source_rqc_approval_
    entry_id is ondelete=SET NULL, not CASCADE, so the batch and any real
    physical pallets under it would survive the delete but lose their link
    back to this record -- surfaced here as a block rather than letting
    that happen silently). A record whose entries only have still-pending
    (never-generated) batches, or no batches at all, deletes freely --
    cascade (approval_entries relationship, cascade='all, delete-orphan')
    removes those pending batches' links along with everything else."""
    exists = (
        db.query(models.QrGenerationRecord.id)
        .join(models.RqcApprovalEntry, models.QrGenerationRecord.source_rqc_approval_entry_id == models.RqcApprovalEntry.id)
        .filter(models.RqcApprovalEntry.rqc_record_id == rqc.id, models.QrGenerationRecord.status == "generated")
        .first()
    )
    if exists:
        return BLOCKED_DELETE_MESSAGE
    return None


BLOCKED_EDIT_MESSAGE = (
    "This record's FG QR batch has already been generated -- edit it via a new RQC "
    "activity instead of changing an approved record after the fact."
)


def blocked_edit_reason(db: Session, rqc: models.RqcRecord) -> str | None:
    """Same spirit as blocked_delete_reason, but for editing (the RQC PUT
    save route) rather than deleting: once real, physical FG QR
    pallets/labels have been GENERATED off this record's approval, silently
    letting an edit change the defect grid/Approved Pallets/Overall Result
    underneath that already-printed batch would make the record and the
    physical pallets disagree. A record whose batch is still 'pending' (not
    yet generated) or has no batch at all edits freely -- re-saving before
    generation is exactly the normal draft-then-finalize flow.

    Checked via BOTH of RQC's two FG QR trigger paths, since either one may
    be the one actually in use for a given record:
    - source_rqc_record_id: the per-activity path (get_or_create_fg_qr_for_
      rqc_record), used by both the RqcWizard/FactoryRqcWizard create flow
      and this same PUT route's own "approved -> auto-generate" call.
    - source_rqc_approval_entry_id (via RqcApprovalEntry): the older
      incremental-ledger path (get_or_create_fg_qr_for_rqc_approval_entry),
      still live for legacy records / the ledger UI in RqcDetailPanel.
    """
    direct = (
        db.query(models.QrGenerationRecord.id)
        .filter(models.QrGenerationRecord.source_rqc_record_id == rqc.id, models.QrGenerationRecord.status == "generated")
        .first()
    )
    if direct:
        return BLOCKED_EDIT_MESSAGE
    via_entries = (
        db.query(models.QrGenerationRecord.id)
        .join(models.RqcApprovalEntry, models.QrGenerationRecord.source_rqc_approval_entry_id == models.RqcApprovalEntry.id)
        .filter(models.RqcApprovalEntry.rqc_record_id == rqc.id, models.QrGenerationRecord.status == "generated")
        .first()
    )
    if via_entries:
        return BLOCKED_EDIT_MESSAGE
    return None


def find_linked_ipqc_by_shipment_number(db: Session, shipment_number: str) -> models.IpqcRecord | None:
    """The Shipment Number -> Production -> IPQC lookup used both at RQC
    creation and (read-only) whenever an RQC record is opened, so the same
    "what does this shipment number resolve to" logic is never duplicated.
    Most-recent match wins on the rare chance more than one IPQC record
    shares a shipment_number (IPQC has no uniqueness constraint on it,
    unlike Inward QC / Inward Vehicle Inspection)."""
    return (
        db.query(models.IpqcRecord)
        .filter(models.IpqcRecord.shipment_number == shipment_number)
        .order_by(models.IpqcRecord.created_at.desc())
        .first()
    )


def find_linked_production_run_by_shipment_number(db: Session, shipment_number: str) -> models.ProductionRun | None:
    """Fallback used only when no IPQC record matches (IPQC is optional --
    see find_linked_ipqc_by_shipment_number above and create_rqc's
    docstring). The same shipment number is reachable one hop further
    upstream without IPQC at all: every primary RM pallet consumed by a
    Material Consumption record carries its own shipment_number (set back
    at Inward VI/QC time -- the exact same field
    material_consumption_service._derive_shipment_number already reads),
    and each Material Consumption record is attached to exactly one
    Production Run (MaterialConsumption.production_run_id). Most-recently-
    consumed match wins, same tie-break convention as the IPQC lookup."""
    return (
        db.query(models.ProductionRun)
        .join(models.MaterialConsumption, models.MaterialConsumption.production_run_id == models.ProductionRun.id)
        .join(
            models.MaterialConsumptionPallet,
            models.MaterialConsumptionPallet.material_consumption_id == models.MaterialConsumption.id,
        )
        .join(models.Pallet, models.MaterialConsumptionPallet.pallet_id == models.Pallet.id)
        .filter(
            models.MaterialConsumptionPallet.role == "primary",
            models.Pallet.shipment_number == shipment_number,
        )
        .order_by(models.MaterialConsumptionPallet.created_at.desc())
        .first()
    )


def create_rqc(db: Session, shipment_number: str, manufacturer: str | None = None) -> models.RqcRecord:
    """Manual creation (the "+ New Record" flow) -- the only way an RQC
    record is created; there is no auto-creation from Material Consumption
    or IPQC anymore.

    2026-09-17: shipment_number is required but is NO LONGER unique across
    RQC records -- each call creates a brand-new activity record, and the
    same shipment legitimately gets many of these over time (a fresh batch
    of pallets tested/approved on a new date). It is the business key used
    to identify the linked Production Run / IPQC record: first via the
    already-existing IPQC.shipment_number snapshot
    (find_linked_ipqc_by_shipment_number), and -- since IPQC is optional --
    falling back to the Production Run directly
    (find_linked_production_run_by_shipment_number) when no IPQC record
    matches. Never re-derives Shipment Number / SKU Code / SKU Version from
    scratch, and never creates a duplicate Production/IPQC record. No match
    at all is not an error: the RQC record still gets created, simply
    unlinked (Production Run / IPQC UUIDs null) until a matching upstream
    record exists.
    """
    shipment_number = (shipment_number or "").strip()
    if not shipment_number:
        raise RqcError("Shipment Number is required.")

    ipqc = find_linked_ipqc_by_shipment_number(db, shipment_number)
    # IPQC is optional -- when there's no IPQC match, fall back one hop
    # further upstream to the Production Run itself (see
    # find_linked_production_run_by_shipment_number's docstring). When
    # ipqc does match, ipqc.production_run is exactly the same run its own
    # shipment_number snapshot was derived from, so this stays a single
    # "run" variable either way.
    run = ipqc.production_run if ipqc else find_linked_production_run_by_shipment_number(db, shipment_number)

    # Best-effort default only, for continuity with whatever Production had
    # already recorded (back when it still collected this input) -- not a
    # live link. Once saved here, this record's own fg_pallets_generated is
    # what every downstream reader (FG QR Generation) uses; Production's
    # own total_fg_pallets is never read again after this one seed.
    default_fg_pallets = run.total_fg_pallets if run and run.total_fg_pallets else None

    rec = models.RqcRecord(
        shipment_number=shipment_number,
        production_run_id=run.id if run else None,
        ipqc_record_id=ipqc.id if ipqc else None,
        # IPQC's own snapshot wins when IPQC exists (it's the locked-in
        # source of truth once filled in); the Production-Run fallback only
        # kicks in when there's no IPQC record to defer to.
        sku_code_id=(ipqc.sku_code_id if ipqc else (run.sku_code_id if run else None)),
        sku_version_id=(ipqc.sku_version_id if ipqc else (run.sku_version_id if run else None)),
        sku_code_snapshot=(
            ipqc.sku_code_snapshot if ipqc else (run.sku_code.code if run and run.sku_code else None)
        ),
        sku_version_snapshot=(
            ipqc.sku_version_snapshot if ipqc else (run.sku_version.version if run and run.sku_version else None)
        ),
        # manufacturer param is accepted for API-payload-shape backward
        # compatibility only -- ignored. Always the fixed constant now.
        manufacturer=RQC_MANUFACTURER_PLACEHOLDER,
        fg_pallets_generated=default_fg_pallets,
        status="pending",
    )
    db.add(rec)
    db.flush()
    return rec


def create_approval_entry(
    db: Session,
    rqc: models.RqcRecord,
    *,
    entry_date: str,
    approved_pallets: int,
    operator_user_id: str | None,
    table_person_number: str | None = None,
    machine_allocations: list[tuple[str, int]] | None = None,
) -> models.RqcApprovalEntry:
    """
    Migration 0039 -- records ONE incremental RQC approval activity (see
    RqcApprovalEntry's own docstring for the full reasoning). This function
    only creates the entry row and its own machine-allocation split, and
    keeps rqc.fg_pallets_generated in sync as a running SUM of every entry
    (denormalized display/backward-compat total -- entries remain the real
    source of truth). It deliberately does NOT touch FG QR Generation --
    that's a separate, explicit call to
    qr_generation_service.get_or_create_fg_qr_for_rqc_approval_entry from
    the route, keeping "record an approval" and "trigger FG QR" as two
    distinct, independently-testable steps, same separation of concerns
    create_rqc/the RQC save route already have.

    entry_date, approved_pallets are required. approved_pallets must be
    positive (also a DB check constraint, backstop). table_person_number
    defaults to the RqcRecord's own last-used value when not given, and is
    also written back onto the record afterward so the RQC form's Batch
    Code Details card shows "last used" as the default for the next entry.
    machine_allocations is [(machine_id, count), ...]; validated for
    sum == approved_pallets only later, at actual QR-generation time
    (batch_code_service.resolve_machine_allocations_for_entry) -- same
    "don't block recording the approval itself" reasoning the legacy
    whole-record allocation always used.
    """
    entry_date = (entry_date or "").strip()
    if not entry_date:
        raise RqcError("Date is required.")
    approved_pallets = int(approved_pallets or 0)
    if approved_pallets <= 0:
        raise RqcError("Approved Pallets must be greater than 0.")

    # Task requirement (2026-09-17): RQC may only approve pallets that
    # Production actually produced -- never more. Production's own count
    # (MaterialConsumptionMachineEntry.pallets_produced, summed across every
    # machine entry that fed this run) is the hard ceiling; the sum of every
    # approval entry ever recorded for this shipment (this one included)
    # must never exceed it. Only enforced when a Production Run is actually
    # linked -- an unlinked RQC record (no match found at create_rqc time)
    # has no produced count to compare against, so it isn't blocked here.
    run = rqc.production_run
    if run is not None:
        total_produced = _run_total_pallets_produced(run)
        already_approved = sum(int(e.approved_pallets or 0) for e in rqc.approval_entries)
        if already_approved + approved_pallets > total_produced:
            remaining = max(total_produced - already_approved, 0)
            raise RqcError(
                f"Only {remaining} pallet(s) remain unapproved for this Production Run "
                f"({total_produced} produced, {already_approved} already approved). "
                f"Reduce Approved Pallets for this entry, or check Production's FG Pallets Generated."
            )

    table_person_number = (table_person_number or rqc.table_person_number or "").strip() or None

    entry = models.RqcApprovalEntry(
        rqc_record_id=rqc.id,
        entry_date=entry_date,
        operator_user_id=operator_user_id,
        approved_pallets=approved_pallets,
        table_person_number=table_person_number,
    )
    db.add(entry)
    db.flush()

    for machine_id, count in (machine_allocations or []):
        if count and count > 0:
            db.add(models.RqcMachineAllocation(
                rqc_record_id=rqc.id, rqc_approval_entry_id=entry.id,
                machine_id=machine_id, fg_pallets_count=count,
            ))

    # Keep the record-level fields in sync: total = sum of every entry ever
    # recorded (this one included -- rqc.approval_entries re-reads from the
    # DB here since it's already flushed above), table_person_number =
    # this entry's own value as the new "last used" default.
    db.expire(rqc, ["approval_entries"])
    rqc.fg_pallets_generated = sum(int(e.approved_pallets or 0) for e in rqc.approval_entries)
    rqc.table_person_number = table_person_number or rqc.table_person_number
    db.flush()
    return entry


def relink_to_run_for_activity(db: Session, rqc: models.RqcRecord) -> None:
    """Point the RQC record at the Production Run (and its IPQC) whose
    Shipment Number, production date and shift match this activity. Several
    RM Consumption records -- and so several runs -- legitimately share one
    Shipment Number while a container's pallets are consumed over several
    shifts; create_rqc can only guess (most recent). No exact match -> the
    current link is kept."""
    if not rqc.shipment_number or not rqc.activity_date or not rqc.shift:
        return
    run = (
        db.query(models.ProductionRun)
        .join(models.MaterialConsumption, models.MaterialConsumption.production_run_id == models.ProductionRun.id)
        .filter(
            models.MaterialConsumption.shipment_number == rqc.shipment_number,
            models.ProductionRun.production_date == rqc.activity_date,
            models.ProductionRun.shift == rqc.shift,
        )
        .order_by(models.ProductionRun.created_at.desc())
        .first()
    )
    if not run or run.id == rqc.production_run_id:
        return
    ipqc = db.query(models.IpqcRecord).filter(models.IpqcRecord.production_run_id == run.id).first()
    rqc.production_run_id = run.id
    rqc.ipqc_record_id = ipqc.id if ipqc else None
