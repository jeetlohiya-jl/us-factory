"""
RM Storage + FG Storage — the same two-scan workflow (scan pallet -> scan
location -> review -> confirm), parameterized by storage_type, per the
prototype's storageScan()/storageConfirm() (RM) and the equivalent FG
functions. Both scans are mandatory; nothing is committed until confirm,
and confirm is one atomic transaction (pallet lifecycle update + location
persisted + storage_records row, or nothing).
"""
from sqlalchemy.orm import Session

from app.db import models
from app.domain import pallet_service


class StorageValidationError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def resolve_pallet_for_storage(db: Session, raw_scan: str, pallet_type: str) -> models.Pallet:
    pallet = pallet_service.resolve_pallet_from_scan(db, raw_scan, pallet_type)
    if not pallet:
        raise StorageValidationError("Unrecognized pallet QR. Check the pallet and try scanning again.")
    if pallet.lifecycle_status == "stored":
        raise StorageValidationError(f"Pallet {pallet.display_id} is already stored. Use a relocation workflow to move it.")
    if pallet.lifecycle_status in ("consumed", "picked", "shipped"):
        raise StorageValidationError(
            f"Pallet {pallet.display_id} has already been {pallet.lifecycle_status} and is no longer available for storage."
        )
    if pallet.lifecycle_status != "pending_storage":
        raise StorageValidationError(f"Pallet {pallet.display_id} is not currently pending storage.")
    return pallet


def resolve_location_for_storage(db: Session, raw_scan: str) -> models.Location:
    location = pallet_service.resolve_location_from_scan(db, raw_scan)
    if not location:
        raise StorageValidationError("Unrecognized location QR. Check the location label and try scanning again.")
    return location


def confirm_storage(
    db: Session, pallet: models.Pallet, location: models.Location, storage_type: str, actor_user_id,
) -> models.StorageRecord:
    """
    Atomic: re-checked against the live DB state (not just the scan-time
    snapshot) inside the same transaction as the write, so a pallet stored
    by someone else between the two scans and the confirm click can never
    produce two storage records for it — the unique constraint on
    storage_records.pallet_id is the hard backstop either way.
    """
    db.refresh(pallet)
    if pallet.lifecycle_status != "pending_storage":
        raise StorageValidationError(f"Pallet {pallet.display_id} is no longer pending storage.")
    existing = db.query(models.StorageRecord).filter(models.StorageRecord.pallet_id == pallet.id).first()
    if existing:
        raise StorageValidationError(f"Pallet {pallet.display_id} is already stored.")

    storage_record = models.StorageRecord(
        storage_type=storage_type,
        pallet_id=pallet.id,
        location_id=location.id,
        source_qr_generation_id=pallet.source_qr_generation_id,
        source_inward_qc_id=pallet.source_inward_qc_id,
        source_production_run_id=pallet.source_production_run_id,
        stored_by=actor_user_id,
    )
    db.add(storage_record)
    pallet.current_location_id = location.id
    pallet_service.record_lifecycle_event(
        db, pallet, "stored", actor_user_id=actor_user_id, location=location.display_id,
    )
    db.flush()
    return storage_record
