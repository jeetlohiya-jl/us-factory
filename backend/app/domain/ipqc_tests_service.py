"""
Falcon IPQC -- Burst Test and Pinhole Test (migration 0090).

Source of truth: the "Burst Test Container wise Record Sheet" (burst columns:
Sealing Temp C, Sealing Time Sec, Acceptable "More than 16 inHg", Fail "Less
than 16 inHg"; pinhole columns: Lamination Machine Shot No., Avg Weight of 10
Trays (g) +/-1 g, Trays Quantity Failed, Pinhole Location / Remarks).

What this module decides, and what it deliberately does NOT decide:

  * Burst reading: > 16 inHg passes, < 16 inHg fails. EXACTLY 16 inHg is not
    defined by the sheet, so it is never given a pass/fail -- it is reported as
    "undetermined", and a test that still contains one cannot be saved as final.
  * Pinhole reading: a row fails when Trays Quantity Failed is above 0. The
    +/-1 g weight tolerance is shown for information only: the sheet does not say
    what weight the average is compared against, so it never decides pass/fail
    here. The partly hidden "dimensions" column on the sheet image is not
    implemented (its heading / tolerance cannot be established).
  * A failed reading needs remarks (burst: the test remarks; pinhole: that row's
    Pinhole Location / Remarks). A test with any failure is saved as 'failed',
    never 'passed' -- status is computed here from the readings, never trusted
    from the client, and the database refuses 'passed' while fail_count > 0.

Every test belongs to a Production Run (never to a SKU alone) and to one
lamination machine, LM1-LM7. SKU / Version / Shift are read from that run.
"""
from __future__ import annotations

import re
import uuid
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy.orm import Session, joinedload

from app.db import models

# The sheet: "Acceptable: more than 16 inHg", "Fail: less than 16 inHg".
BURST_THRESHOLD_INHG = Decimal("16")

# Valid lamination machines: LM1..LM7 ('LM5 FILM', 'LM6 SALM' ... keep a suffix).
_LM_CODE = re.compile(r"^LM[1-7](\s|$)")


class TestRuleError(Exception):
    """A business-rule violation -> HTTP 422 with this message."""
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def is_valid_lamination_machine(machine: models.Machine | None) -> bool:
    return bool(machine and machine.machine_type == "lamination" and _LM_CODE.match(machine.code or ""))


# ---------------------------------------------------------------------------
# Readings: parsing + classification
# ---------------------------------------------------------------------------

def _dec(raw, label: str) -> Optional[Decimal]:
    """Blank -> None; otherwise a number >= 0."""
    if raw is None:
        return None
    s = str(raw).strip()
    if s == "":
        return None
    try:
        d = Decimal(s)
    except InvalidOperation:
        raise TestRuleError(f"{label} must be a number.")
    if not d.is_finite() or d < 0:
        raise TestRuleError(f"{label} must be a number of 0 or more.")
    return d


def classify_burst(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    if value > BURST_THRESHOLD_INHG:
        return "pass"
    if value < BURST_THRESHOLD_INHG:
        return "fail"
    return "undetermined"  # exactly 16 inHg: not defined by the source sheet


def evaluate_burst(save_mode: str, container_number: Optional[str], remarks: Optional[str], readings: list) -> dict:
    """Validate + classify. Returns {rows, status, fail_count, undetermined_count}.
    Draft is lenient (partial rows allowed); final needs a container number, at
    least one complete reading, no undetermined (exactly-16) reading, and remarks
    when any reading fails."""
    rows = []
    for i, r in enumerate(readings, start=1):
        label = f"Reading {i}"
        temp = _dec(r.sealing_temp_c, f"{label}: Sealing Temperature")
        secs = _dec(r.sealing_time_s, f"{label}: Sealing Time")
        burst = _dec(r.burst_inhg, f"{label}: Burst Test Result")
        rows.append({"sr": i, "sealing_temp_c": temp, "sealing_time_s": secs, "burst_inhg": burst, "result": classify_burst(burst)})
    fails = sum(1 for r in rows if r["result"] == "fail")
    unknown = sum(1 for r in rows if r["result"] == "undetermined")

    if save_mode == "draft":
        return {"rows": rows, "status": "draft", "fail_count": fails, "undetermined_count": unknown}

    if not (container_number or "").strip():
        raise TestRuleError("Container Number is required.")
    if not rows:
        raise TestRuleError("Add at least one reading.")
    for r in rows:
        if r["sealing_temp_c"] is None or r["sealing_time_s"] is None or r["burst_inhg"] is None:
            raise TestRuleError(f"Reading {r['sr']}: Sealing Temperature, Sealing Time and Burst Test Result are all required.")
    if unknown:
        nums = ", ".join(str(r["sr"]) for r in rows if r["result"] == "undetermined")
        raise TestRuleError(
            f"Reading {nums}: exactly 16 inHg is not defined as acceptable or failed on the QC sheet. "
            "Confirm the rule with QA (or re-test) before saving this test as final; you can still save it as a draft."
        )
    if fails and not (remarks or "").strip():
        raise TestRuleError("Remarks are required because at least one reading failed (below 16 inHg).")
    return {"rows": rows, "status": "failed" if fails else "passed", "fail_count": fails, "undetermined_count": 0}


def evaluate_pinhole(save_mode: str, readings: list) -> dict:
    rows = []
    for i, r in enumerate(readings, start=1):
        label = f"Reading {i}"
        weight = _dec(r.avg_weight_g, f"{label}: Average Weight of 10 Trays")
        failed_raw = None if r.trays_failed is None else str(r.trays_failed).strip()
        failed: Optional[int] = None
        if failed_raw not in (None, ""):
            try:
                fd = Decimal(failed_raw)
            except InvalidOperation:
                raise TestRuleError(f"{label}: Quantity of Trays Failed must be a whole number.")
            if fd < 0 or fd != fd.to_integral_value():
                raise TestRuleError(f"{label}: Quantity of Trays Failed must be a whole number of 0 or more.")
            failed = int(fd)
        shot = (r.shot_number or "").strip() or None
        remarks = (r.remarks or "").strip() or None
        rows.append({
            "sr": i, "shot_number": shot, "avg_weight_g": weight, "trays_failed": failed, "remarks": remarks,
            "result": None if failed is None else ("fail" if failed > 0 else "pass"),
        })
    fails = sum(1 for r in rows if r["result"] == "fail")

    if save_mode == "draft":
        return {"rows": rows, "status": "draft", "fail_count": fails}

    if not rows:
        raise TestRuleError("Add at least one reading.")
    for r in rows:
        if r["shot_number"] is None or r["avg_weight_g"] is None or r["trays_failed"] is None:
            raise TestRuleError(
                f"Reading {r['sr']}: Lamination Machine Shot No., Average Weight of 10 Trays and Quantity of Trays Failed are all required."
            )
        if r["trays_failed"] > 0 and not r["remarks"]:
            raise TestRuleError(f"Reading {r['sr']}: Pinhole Location / Remarks is required because trays failed.")
    return {"rows": rows, "status": "failed" if fails else "passed", "fail_count": fails}


# ---------------------------------------------------------------------------
# Production Run linkage
# ---------------------------------------------------------------------------

def run_lamination_machines(run: models.ProductionRun) -> list[dict]:
    """Lamination machines (LM1-LM7) actually used on this run, one dict per
    machine, with the SKU / Version of that machine's entry (first entry that
    has one) and falling back to the run's own SKU. Needs the run's
    material_consumptions -> machine_entries -> machine already loaded."""
    out: dict[uuid.UUID, dict] = {}
    for mc in run.material_consumptions:
        for e in mc.machine_entries:
            m = e.machine
            if not is_valid_lamination_machine(m):
                continue
            d = out.setdefault(m.id, {"machine_id": m.id, "machine_code": m.code, "sku_code_id": None, "sku_version_id": None,
                                      "sku_code": None, "sku_version": None})
            if d["sku_code_id"] is None and e.sku_code_id:
                d.update(sku_code_id=e.sku_code_id, sku_version_id=e.sku_version_id,
                         sku_code=e.sku_code_snapshot, sku_version=e.sku_version_snapshot)
    return sorted(out.values(), key=lambda d: d["machine_code"])


def load_run(db: Session, run_id: uuid.UUID) -> models.ProductionRun | None:
    return (
        db.query(models.ProductionRun)
        .options(
            joinedload(models.ProductionRun.sku_code),
            joinedload(models.ProductionRun.sku_version),
            joinedload(models.ProductionRun.material_consumptions)
            .joinedload(models.MaterialConsumption.machine_entries)
            .joinedload(models.MaterialConsumptionMachineEntry.machine),
        )
        .filter(models.ProductionRun.id == run_id)
        .first()
    )


def resolve_link(db: Session, run: models.ProductionRun, machine_id: Optional[uuid.UUID]) -> dict:
    """Decide the lamination machine + SKU/Version/Shift snapshot for a new test.
    - machine_id omitted and the run used exactly one lamination machine -> that one.
    - machine_id omitted and it used several -> the user must choose.
    - the run used lamination machines -> machine_id must be one of them.
    - the run recorded none (e.g. not yet entered) -> any valid LM1-LM7 machine.
    """
    used = run_lamination_machines(run)
    chosen: Optional[dict] = None
    if machine_id is None:
        if len(used) == 1:
            chosen = used[0]
        elif len(used) > 1:
            raise TestRuleError("This run used more than one lamination machine. Choose which machine the test is for.")
        else:
            raise TestRuleError("Choose the lamination machine (LM1-LM7) for this test.")
    else:
        machine = db.query(models.Machine).filter(models.Machine.id == machine_id).first()
        if not is_valid_lamination_machine(machine):
            raise TestRuleError("Only the lamination machines LM1-LM7 can be tested.")
        if used:
            chosen = next((u for u in used if u["machine_id"] == machine.id), None)
            if chosen is None:
                raise TestRuleError(f"{machine.code} was not used on {run.run_number}. Choose one of: " + ", ".join(u["machine_code"] for u in used) + ".")
        else:
            chosen = {"machine_id": machine.id, "machine_code": machine.code, "sku_code_id": None, "sku_version_id": None,
                      "sku_code": None, "sku_version": None}

    sku_code_id = chosen["sku_code_id"] or run.sku_code_id
    sku_version_id = chosen["sku_version_id"] or run.sku_version_id
    sku_code = chosen["sku_code"] or (run.sku_code.code if run.sku_code else None)
    sku_version_row = None
    if sku_version_id:
        sku_version_row = db.query(models.SkuVersion).filter(models.SkuVersion.id == sku_version_id).first()
    sku_version = chosen["sku_version"] or (sku_version_row.version if sku_version_row else None)
    return {
        "machine_id": chosen["machine_id"], "machine_code": chosen["machine_code"],
        "sku_code_id": sku_code_id, "sku_version_id": sku_version_id,
        "sku_code_snapshot": sku_code, "sku_version_snapshot": sku_version,
        "sku_weight_snapshot": sku_version_row.prod_weight if sku_version_row else None,
        "shift": run.shift, "production_date": run.production_date, "run_number_snapshot": run.run_number,
    }
