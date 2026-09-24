"""
Customer master data for Goods Outward's "Customer / Recipient" field
(2026-09-24) -- same admin-managed-list shape as vendors.py/machines.py,
but gated through the customer_shipment module's own permission (via a
local require()) rather than deps.require_permission (which is hard-wired
to inward_vehicle_inspection, the module Vendors/SKU Names/Locations serve)
-- api/deps.py's FACTORY_PERMISSION_MAP already remaps customer_shipment to
factory_goods_outward under the Factory product header, so this one router
works correctly for both products with no extra code.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser

router = APIRouter(prefix="/api/v1/customers", tags=["customers"])

MODULE = "customer_shipment"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


@router.get("", response_model=list[schemas.CustomerOut])
def list_customers(
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    _perm=Depends(require("view")),
):
    """Inactive customers are excluded by default so a retired customer
    drops out of the Goods Outward dropdown immediately, but the
    management screen still lists them (include_inactive=true) so they can
    be reactivated."""
    q = db.query(models.Customer)
    if not include_inactive:
        q = q.filter(models.Customer.is_active.is_(True))
    return q.order_by(models.Customer.name).all()


@router.post("", response_model=schemas.CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(
    payload: schemas.CustomerIn,
    db: Session = Depends(get_db),
    _perm=Depends(require("edit")),
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Customer name is required.")
    customer = models.Customer(name=name, is_active=True)
    db.add(customer)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{name}" already exists.')
    db.refresh(customer)
    return customer


@router.put("/{customer_id}", response_model=schemas.CustomerOut)
def update_customer(
    customer_id: uuid.UUID,
    payload: schemas.CustomerUpdateIn,
    db: Session = Depends(get_db),
    _perm=Depends(require("edit")),
):
    customer = db.query(models.Customer).filter(models.Customer.id == customer_id).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found.")
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Customer name is required.")
        customer.name = name
    if payload.is_active is not None:
        customer.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{payload.name}" already exists.')
    db.refresh(customer)
    return customer


@router.delete("/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(
    customer_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require("edit")),
):
    """Customer is still kept as a plain text snapshot on every Customer
    Shipment (customer_shipments.customer is not a foreign key), so a
    delete here never erases what a past shipment displayed -- there is
    nothing to 409-block on reference here, unlike Vendor (no FK from
    customer_shipments back to this table)."""
    customer = db.query(models.Customer).filter(models.Customer.id == customer_id).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found.")
    db.delete(customer)
    db.commit()
    return None
