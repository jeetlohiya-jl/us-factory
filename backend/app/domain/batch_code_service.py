"""
Section 11 -- FG Storage Batch Code generation.

Target format (from the task): 03170-D401-200725-A-T1-M01

  03170   SKU number             sku_codes.batch_number (admin-supplied,
                                  "to be supplied later" per the task --
                                  falls back to PLACEHOLDER_SKU_NUMBER)
  D401    Shipment Number ("D4") + 2-digit Combo Number ("01"),
          concatenated with NO separating hyphen -- the Shipment Number is
          used verbatim (confirmed), the Combo Number wraps 01->44->01,
          scoped per Shipment Number (see next_combo_number)
  200725  Production Date as DDMMYY
  A       Shift, first letter (Shift A -> "A")
  T1      RQC Table/Person Number, "T" + the operator-entered value
  M01     Machine number         machines.batch_number (admin-supplied,
                                  falls back to PLACEHOLDER_MACHINE_NUMBER)

Every segment is computed ONCE, at the moment pallets are actually
generated (qr_generation_service.generate_pallets), and frozen onto the
QrGenerationRecord (combo_number) and each Pallet (batch_code) -- never
recomputed later, so a subsequent edit to the SKU/Machine number mapping
never silently rewrites a Batch Code that's already been printed.
"""
import datetime as _dt

from sqlalchemy.orm import Session

from app.db import models

PLACEHOLDER_SKU_NUMBER = "00000"
PLACEHOLDER_MACHINE_NUMBER = "00"
MAX_COMBO = 44


class BatchCodeError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def format_ddmmyy(production_date: str | None) -> str:
    """production_date is stored as ISO 'YYYY-MM-DD' text everywhere else
    in this app (see material_consumption_service.create_draft). Falls back
    to today's date, formatted the same way, if the run somehow has none --
    a Batch Code segment must never be blank."""
    if production_date:
        try:
            d = _dt.date.fromisoformat(production_date)
            return d.strftime("%d%m%y")
        except ValueError:
            pass
    return _dt.date.today().strftime("%d%m%y")


def shift_letter(shift: str | None) -> str:
    """'Shift A' -> 'A'. Falls back to '?' rather than raising -- a missing
    Shift should never block Batch Code generation outright; it's visibly
    flagged in the resulting string instead."""
    s = (shift or "").strip()
    return s[-1].upper() if s else "?"


def next_combo_number(db: Session, shipment_number: str | None) -> int:
    """
    01 -> 44, then wraps back to 01 (never 45) -- scoped per Shipment
    Number. Counts how many previous FG batches (QrGenerationRecord rows,
    qr_type='fg', status='generated' -- i.e. already frozen, never a still-
    pending draft) already used this same shipment_number, so the Nth
    batch for a given shipment number gets combo N, wrapping via modulo.
    """
    shipment_number = (shipment_number or "").strip()
    if not shipment_number:
        return 1
    count = (
        db.query(models.QrGenerationRecord)
        .filter(
            models.QrGenerationRecord.qr_type == "fg",
            models.QrGenerationRecord.status == "generated",
            models.QrGenerationRecord.shipment_number == shipment_number,
        )
        .count()
    )
    return (count % MAX_COMBO) + 1


def build_batch_code(
    *, sku_number: str | None, shipment_number: str | None, combo_number: int,
    production_date: str | None, shift: str | None, table_person_number: str | None,
    machine_number: str | None,
) -> str:
    sku = (sku_number or "").strip() or PLACEHOLDER_SKU_NUMBER
    shipment = (shipment_number or "").strip() or "NA"
    ddmmyy = format_ddmmyy(production_date)
    shift_code = shift_letter(shift)
    table_person = (table_person_number or "").strip()
    # "T1" -- if the operator already typed a "T"-prefixed value, don't
    # double it up; otherwise prefix "T" onto whatever they entered.
    table_segment = table_person if table_person[:1].upper() == "T" else f"T{table_person or '?'}"
    machine = (machine_number or "").strip() or PLACEHOLDER_MACHINE_NUMBER
    return f"{sku}-{shipment}{combo_number:02d}-{ddmmyy}-{shift_code}-{table_segment}-M{machine}"


def resolve_machine_allocations(db: Session, rqc: models.RqcRecord) -> list[tuple[models.Machine, int]]:
    """
    Returns [(machine, pallet_count), ...] describing how the RQC's own
    fg_pallets_generated is split across the machines that fed its
    Production Run. If the operator has explicitly allocated (RqcMachine
    Allocation rows with a non-zero count), that split is used and MUST sum
    to fg_pallets_generated -- otherwise raises, since generating pallets
    with an unresolved split would silently mis-attribute some of them.
    For the common case of a single-machine run with no explicit
    allocation, the whole count is auto-assigned to that one machine.
    """
    total = int(rqc.fg_pallets_generated or 0)
    if total <= 0:
        raise BatchCodeError("Enter Number of Finished Goods Pallets Generated on the RQC record before generating QR codes.")

    explicit = [(a.machine, a.fg_pallets_count) for a in rqc.machine_allocations if a.fg_pallets_count > 0]
    if explicit:
        allocated_total = sum(count for _, count in explicit)
        if allocated_total != total:
            raise BatchCodeError(
                f"Machine allocation for Finished Goods Pallets Generated adds up to {allocated_total}, "
                f"but Number of Finished Goods Pallets Generated is {total}. Correct the per-machine split on the RQC record."
            )
        return explicit

    run = rqc.production_run
    run_machines = [rm.machine for rm in run.machines] if run else []
    if len(run_machines) == 1:
        return [(run_machines[0], total)]
    if not run_machines:
        raise BatchCodeError(
            "This Production Run has no machine on record -- add a Machine Allocation on the RQC record before generating QR codes."
        )
    raise BatchCodeError(
        "This Production Run spans multiple machines -- split Number of Finished Goods Pallets Generated across "
        "them in the RQC record's Machine Allocation section before generating QR codes."
    )


def resolve_machine_allocations_for_entry(db: Session, entry: models.RqcApprovalEntry) -> list[tuple[models.Machine | None, int]]:
    """
    Migration 0039 -- same shape/purpose as resolve_machine_allocations
    above, but scoped to ONE RQC Approval Entry's own approved_pallets
    instead of a whole RqcRecord's single fg_pallets_generated total. Each
    entry's own machine_allocations rows (RqcMachineAllocation.
    rqc_approval_entry_id) must fully account for THAT entry's count --
    never mixed with any other entry's split, since different approval
    activities for the same shipment can legitimately have come off
    different machines.
    """
    total = int(entry.approved_pallets or 0)
    if total <= 0:
        raise BatchCodeError("Approved Pallets must be greater than 0 before generating QR codes for this entry.")

    explicit = [(a.machine, a.fg_pallets_count) for a in entry.machine_allocations if a.fg_pallets_count > 0]
    if explicit:
        allocated_total = sum(count for _, count in explicit)
        if allocated_total != total:
            raise BatchCodeError(
                f"Machine allocation for this RQC approval entry adds up to {allocated_total}, "
                f"but Approved Pallets is {total}. Correct the per-machine split before generating QR codes."
            )
        return explicit

    run = entry.rqc_record.production_run if entry.rqc_record else None
    # 2026-09-17 -- a standalone RQC record (no linked Production Run --
    # see rqc_service.create_rqc's "no match is not an error" behavior)
    # has no machine to attribute this entry to. That's not an error: fall
    # back to a single unattributed allocation (machine=None) rather than
    # blocking FG QR Generation -- build_batch_code already renders a
    # placeholder machine segment for a None machine_number.
    if run is None:
        return [(None, total)]
    run_machines = [rm.machine for rm in run.machines] if run else []
    if len(run_machines) == 1:
        return [(run_machines[0], total)]
    if not run_machines:
        raise BatchCodeError(
            "This Production Run has no machine on record -- add a Machine Allocation on this RQC approval entry before generating QR codes."
        )
    raise BatchCodeError(
        "This Production Run spans multiple machines -- split Approved Pallets across them on this "
        "RQC approval entry before generating QR codes."
    )
