"""
Shared domain logic for RM + FG QR Generation and RM + FG Storage.

Source of truth for naming/numbering/workflow is the HTML prototype:
  - CATEGORY_SUFFIX category->suffix map (what's on the pallet)
  - "<country>-<suffix>-<yymm>-<seq4>" pallet numbering (US-PLT-2608-0091,
    CN-PLT-2608-0001, ...) — the country identifies where the pallet was
    packed: the RM vendor's country for an RM pallet, always "US" for FG
    (see prefix_for_category)
  - "RMQR-<seq4>" / "FGQR-<seq4>" QR-batch numbering
  - one accepted QC (or, for FG, one approved Production Run) -> one QR
    batch -> N individually numbered pallets
  - generated pallets automatically enter "pending_storage"

Deviation from the prototype's markup (per the task's explicit override for
this implementation): RM and FG pallets of the same country+category share
one display-id namespace/prefix — pallet_type is what distinguishes an RM
pallet from an FG one, rather than a separate "US-FG-PLT" prefix.

Each pallet and each location is backed by a real QR PNG (via the `qrcode`
package) encoding a small JSON payload — the pallet/location's immutable
display_id plus enough context to identify the record, but the DB row (found
by display_id) always remains the single source of truth. A "scan" resolves
that payload (or a bare display_id, for a plain hardware barcode-scanner
that just emits keystrokes) back to the exact DB record.
"""
import io
import json
import re
from datetime import datetime, timezone

import qrcode
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import models
from app.adapters.storage.factory import get_storage_adapter
from app.domain.id_counters import next_seq


# Category -> the part of the pallet-number prefix that identifies WHAT is
# on the pallet. The other part -- WHERE it was packed -- used to be
# hardcoded "US" for every pallet; it's now the 2-letter country the pallet
# was actually packed in (see prefix_for_category below).
CATEGORY_SUFFIX = {
    "tray": "PLT", "lnp_tray": "PLT", "fgtray": "PLT", "pad": "PAD",
    "polybag": "PB", "cfb": "CFB", "glue": "GLUE",
}


def prefix_for_category(category: str | None, country_code: str | None = None) -> str:
    """
    A pallet's display_id prefix identifies both what's on it and where it
    was packed: "<country>-<category suffix>", e.g. "CN-PLT" for a Tray
    pallet packed at a China vendor, "US-GLUE" for Glue packed here.
    country_code is the vendor's country for an RM pallet (resolved from the
    Inward QC's vendor at batch-creation time -- see
    qr_generation_service.get_or_create_rm_qr_for_qc) or always "US" for an
    FG pallet, since finished goods are packed at this US factory regardless
    of where any RM component shipped from. Defaults to "US" when unknown
    (a legacy vendor with no country on file) rather than failing the whole
    batch over missing master data.
    """
    suffix = CATEGORY_SUFFIX.get(category or "", "PLT")
    country = (country_code or "US").strip().upper()
    return f"{country}-{suffix}"


def next_batch_display_id(db: Session, qr_type: str) -> str:
    prefix = "RMQR" if qr_type == "rm" else "FGQR"
    seq = next_seq(db, f"qr_batch:{qr_type}")
    return f"{prefix}-{str(seq).zfill(4)}"


def next_pallet_display_id(db: Session, category: str | None, country_code: str | None = None) -> str:
    """
    RM and FG pallets intentionally share one namespace per prefix (see
    module docstring) — the counter is keyed on that exact country+category
    prefix, regardless of pallet_type. A different country naturally starts
    its own sequence from 0001, since it's a different prefix string.
    """
    prefix = prefix_for_category(category, country_code)
    yymm = datetime.now(timezone.utc).strftime("%y%m")
    seq = next_seq(db, f"pallet:{prefix}")
    return f"{prefix}-{yymm}-{str(seq).zfill(4)}"


def _make_qr_png(payload: str) -> bytes:
    img = qrcode.make(payload)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def build_pallet_qr(pallet: models.Pallet) -> tuple[str, str, bytes]:
    """Pure/CPU-only half of generate_pallet_qr -- no DB access, no network
    call. Returns (storage_path, payload, png_bytes) so a caller generating
    many pallets at once (see qr_generation_service.generate_pallets) can
    build every pallet's QR PNG up front and then upload them all
    concurrently, instead of one network round-trip at a time. Split out
    specifically to fix QR Generation being slow for a full batch (e.g.
    ~8s for 44 pallets when each upload ran back-to-back)."""
    payload = json.dumps({
        "t": "rm_pallet" if pallet.pallet_type == "rm" else "fg_pallet",
        "id": pallet.display_id,
        "shipment": pallet.shipment_number,
        "sku": pallet.sku_code_snapshot,
    })
    png = _make_qr_png(payload)
    path = f"qr/pallets/{pallet.id}.png"
    return path, payload, png


def generate_pallet_qr(db: Session, pallet: models.Pallet) -> None:
    """Real QR PNG encoding the pallet's immutable display_id + enough
    context to resolve its identity — backed by, never a substitute for, the
    DB row itself. Single-pallet convenience wrapper around build_pallet_qr
    -- generate_pallets (the batch path) calls build_pallet_qr directly so
    it can parallelize the storage upload across the whole batch instead of
    going through this one-at-a-time version."""
    path, payload, png = build_pallet_qr(pallet)
    storage = get_storage_adapter()
    stored = storage.save(path, png, "image/png")
    pallet.qr_storage_path = stored.storage_path
    pallet.qr_public_url = stored.public_url
    pallet.qr_payload = payload


def generate_location_qr(db: Session, location: models.Location) -> None:
    payload = json.dumps({"t": "location", "id": location.display_id, "zone": location.zone})
    png = _make_qr_png(payload)
    storage = get_storage_adapter()
    path = f"qr/locations/{location.id}.png"
    stored = storage.save(path, png, "image/png")
    location.qr_storage_path = stored.storage_path
    location.qr_public_url = stored.public_url
    location.qr_payload = payload


def record_lifecycle_event(db: Session, pallet: models.Pallet, stage: str, actor_user_id=None, **metadata) -> None:
    db.add(models.PalletLifecycleEvent(
        pallet_id=pallet.id, stage=stage, event_metadata=metadata or None, actor_user_id=actor_user_id,
    ))
    pallet.lifecycle_status = stage


def _parse_scan_payload(raw: str) -> dict:
    """What a scan produced: the QR's JSON ({"t": ..., "id": ...}) or a plain
    Pallet / Location code typed by hand or by a barcode scanner.

    Tolerant of how hardware scanners and keyboards can alter the text on its
    way in -- keys in another case ({"T":...,"ID":...}), smart quotes, stray
    spaces -- so a scan never fails just because the JSON arrived changed.
    Code comparison downstream is case-insensitive."""
    raw = (raw or "").strip()
    if not raw:
        return {}
    cleaned = raw.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'")
    try:
        data = json.loads(cleaned)
        if isinstance(data, dict):
            lowered = {str(k).lower(): v for k, v in data.items()}
            if lowered.get("id"):
                return lowered
    except (ValueError, TypeError):
        pass
    # JSON that got mangled beyond parsing: still pick out its "id" value.
    m = re.search(r'["\']?id["\']?\s*:\s*["\']([^"\']+)["\']', cleaned, re.IGNORECASE)
    if m:
        return {"id": m.group(1)}
    # Plain display_id -- e.g. a hardware barcode-scanner that just types the
    # printed code as keystrokes rather than the full QR JSON payload.
    return {"id": raw}

def resolve_pallet_from_scan(db: Session, raw: str, pallet_type: str) -> models.Pallet | None:
    data = _parse_scan_payload(raw)
    display_id = data.get("id")
    if not display_id:
        return None
    return (
        db.query(models.Pallet)
        .filter(func.lower(models.Pallet.display_id) == display_id.strip().lower())
        .filter(models.Pallet.pallet_type == pallet_type)
        .first()
    )


def resolve_location_from_scan(db: Session, raw: str) -> models.Location | None:
    data = _parse_scan_payload(raw)
    display_id = data.get("id")
    if not display_id:
        return None
    return (
        db.query(models.Location)
        .filter(func.lower(models.Location.display_id) == display_id.strip().lower())
        .filter(models.Location.is_active.is_(True))
        .first()
    )
