"""
RQC COA (Certificate of Analysis) -- as of the 2026-09-17 RQC redesign, COA
is decoupled from RqcRecord entirely and lives in its own per-SHIPMENT flow
(see models.RqcCoaEntry's docstring): exactly one COA entry per shipment,
never one per RQC activity record. This router is the whole of that flow --
find-or-create by Shipment Number (POST), and the one atomic save for its 4
observation tables (PUT) -- mirroring api/rqc.py's own create/save shape
closely. Same `fill_section` permission gate as the main RQC save route,
same module ("rqc") -- COA is part of the RQC module, just a separate
record type within it.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser

router = APIRouter(prefix="/api/v1/rqc-coa-entries", tags=["rqc"])

MODULE = "rqc"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def _serialize(entry: models.RqcCoaEntry) -> schemas.RqcCoaEntryOut:
    return schemas.RqcCoaEntryOut(
        id=entry.id,
        shipment_number=entry.shipment_number,
        coa_observations=[
            schemas.RqcCoaObservationOut(coa_group=o.coa_group, sr=o.sr, observation=o.observation)
            for o in sorted(entry.observations, key=lambda o: (o.coa_group, o.sr))
        ],
    )


@router.post("", response_model=schemas.RqcCoaEntryOut, status_code=status.HTTP_201_CREATED)
def create_or_get_rqc_coa_entry(
    payload: schemas.RqcCoaEntryCreateIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm: models.ModulePermission = Depends(require("create")),
):
    """Find-or-create by Shipment Number -- COA is one-per-shipment
    (rqc_coa_entries.shipment_number is unique), so opening "+ New Record"
    (or "View/Edit") for a shipment that already has a COA entry just
    returns the existing one instead of ever raising a conflict; the RQC
    list's own COA column/action is what decides which label to show
    ("+ New Record" vs. "View/Edit"), not this route."""
    shipment_number = (payload.shipment_number or "").strip()
    if not shipment_number:
        raise HTTPException(status_code=422, detail="Shipment Number is required.")

    existing = (
        db.query(models.RqcCoaEntry)
        .options(joinedload(models.RqcCoaEntry.observations))
        .filter(models.RqcCoaEntry.shipment_number == shipment_number)
        .first()
    )
    if existing:
        return _serialize(existing)

    entry = models.RqcCoaEntry(shipment_number=shipment_number, created_by=current_user.user_id)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return _serialize(entry)


@router.put("/{entry_id}", response_model=schemas.RqcCoaEntryOut)
def save_rqc_coa_entry(
    entry_id: uuid.UUID,
    payload: schemas.RqcCoaEntrySaveIn,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    """The single atomic write for a COA entry: replaces its whole
    observations list wholesale, same semantics as the main RQC save
    route's own defect_results/coa_observations replace-and-reinsert."""
    entry = (
        db.query(models.RqcCoaEntry)
        .options(joinedload(models.RqcCoaEntry.observations))
        .filter(models.RqcCoaEntry.id == entry_id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="COA entry not found.")

    for existing in list(entry.observations):
        db.delete(existing)
    db.flush()

    for o in payload.coa_observations:
        db.add(models.RqcCoaObservation(
            rqc_coa_entry_id=entry.id, coa_group=o.coa_group, sr=o.sr, observation=o.observation,
        ))

    db.commit()
    db.refresh(entry)
    return _serialize(entry)


@router.get("/by-shipment/{shipment_number}", response_model=schemas.RqcCoaEntryOut)
def get_rqc_coa_entry_by_shipment(
    shipment_number: str,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    _perm: models.ModulePermission = Depends(require("view")),
):
    """Used by the RQC list's COA column to check whether a shipment
    already has an entry (View/Edit) or not (+ New Record) without a
    separate Supabase-direct read -- COA entries are few enough, and this
    lookup infrequent enough (one call per opened row), that a plain
    FastAPI round-trip is fine here rather than adding a new Supabase
    read path for it."""
    entry = (
        db.query(models.RqcCoaEntry)
        .options(joinedload(models.RqcCoaEntry.observations))
        .filter(models.RqcCoaEntry.shipment_number == shipment_number)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No COA entry for this shipment yet.")
    return _serialize(entry)
