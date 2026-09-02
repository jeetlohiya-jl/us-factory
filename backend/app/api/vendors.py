import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import require_permission

router = APIRouter(prefix="/api/v1/vendors", tags=["vendors"])


@router.get("", response_model=list[schemas.VendorOut])
def list_vendors(
    category: str | None = Query(default=None),
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("view")),
):
    """category filters to one Inward Vehicle Inspection category (tray,
    pad, polybag, cfb, glue) for the Vendor Name dropdown; omitted, returns
    every vendor across categories for the management screen. Inactive
    vendors are excluded by default so a retired vendor drops out of new
    dropdowns immediately, but the management screen still lists them
    (include_inactive=true) so they can be reactivated."""
    q = db.query(models.Vendor)
    if category:
        q = q.filter(models.Vendor.category == category)
    if not include_inactive:
        q = q.filter(models.Vendor.is_active.is_(True))
    return q.order_by(models.Vendor.category, models.Vendor.name).all()


@router.post("", response_model=schemas.VendorOut, status_code=status.HTTP_201_CREATED)
def create_vendor(
    payload: schemas.VendorIn,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    name = payload.name.strip()
    category = payload.category.strip()
    country = payload.country.strip().upper()
    if not name:
        raise HTTPException(status_code=422, detail="Vendor name is required.")
    if len(country) != 2 or not country.isalpha():
        raise HTTPException(status_code=422, detail="Country must be a 2-letter code (e.g. US, CN).")
    vendor = models.Vendor(category=category, name=name, country=country, is_active=True)
    db.add(vendor)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{name}" already exists for this category.')
    db.refresh(vendor)
    return vendor


@router.put("/{vendor_id}", response_model=schemas.VendorOut)
def update_vendor(
    vendor_id: uuid.UUID,
    payload: schemas.VendorUpdateIn,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    vendor = db.query(models.Vendor).filter(models.Vendor.id == vendor_id).first()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found.")
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Vendor name is required.")
        vendor.name = name
    if payload.country is not None:
        country = payload.country.strip().upper()
        if len(country) != 2 or not country.isalpha():
            raise HTTPException(status_code=422, detail="Country must be a 2-letter code (e.g. US, CN).")
        vendor.country = country
    if payload.is_active is not None:
        vendor.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{payload.name}" already exists for this category.')
    db.refresh(vendor)
    return vendor


@router.delete("/{vendor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vendor(
    vendor_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    """Vendor Name is still kept as a plain text snapshot on every inspection
    (see InwardVehicleInspection.vendor_name) so a delete here never erases
    what a past record displayed. But since migration 0010, vendor_id is a
    real FK from inward_vehicle_inspections/inward_qc_records back to this
    table -- a vendor a real record still points to can no longer be
    silently deleted; Postgres blocks it and we surface that as a clean
    409, exactly like every other reference-data delete route in this app
    (see skus.py, machines.py)."""
    vendor = db.query(models.Vendor).filter(models.Vendor.id == vendor_id).first()
    if not vendor:
        raise HTTPException(status_code=404, detail="Vendor not found.")
    try:
        db.delete(vendor)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="This vendor is referenced by existing records and can't be deleted — deactivate it instead.",
        )
    return None
