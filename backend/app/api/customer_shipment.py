"""
Customer Shipment API -- deliberately narrow. Per spec point 15, list/detail
reads are direct-Supabase from the frontend (see frontend/src/lib/api.ts),
NOT FastAPI GET routes. The only two routes here are the ones that need the
service-role connection: the one atomic multi-table create transaction
(spec points 14/16), and delete (which must enforce the Admin-only +
dependency-blocking rule).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.domain import customer_shipment_service

router = APIRouter(prefix="/api/v1/customer-shipments", tags=["customer-shipment"])

MODULE = "customer_shipment"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    perm = db.query(models.ModulePermission).filter(models.ModulePermission.user_id == current_user.user_id, models.ModulePermission.module == MODULE).first()
    if not perm:
        perm = models.ModulePermission(user_id=current_user.user_id, module=MODULE, can_view=True)
    return perm


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


@router.post("", response_model=schemas.CustomerShipmentCreateOut)
def create(
    body: schemas.CustomerShipmentCreateIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require("create")),
):
    if not body.customer or not body.customer.strip():
        raise HTTPException(status_code=422, detail="Customer / Recipient is required.")
    valid_items = [li for li in body.line_items if li.pallets_required > 0]
    if not valid_items:
        raise HTTPException(status_code=422, detail="At least one line item with a SKU, Version and pallet quantity is required.")

    shipment = customer_shipment_service.create_customer_shipment(
        db,
        customer=body.customer.strip(),
        line_items=[li.model_dump() for li in valid_items],
        actor_user_id=current_user.user_id,
    )
    db.commit()
    db.refresh(shipment)

    return schemas.CustomerShipmentCreateOut(
        id=shipment.id,
        shipment_number=shipment.shipment_number,
        container_number=shipment.container_number,
        customer=shipment.customer,
        line_items=[
            schemas.CustomerShipmentLineItemOut(
                id=li.id,
                sku_code=li.sku_code_snapshot,
                sku_version=li.sku_version_snapshot,
                pallets_required=li.pallets_required,
            )
            for li in shipment.line_items
        ],
    )


@router.delete("/{shipment_id}", status_code=204)
def delete(
    shipment_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require("delete")),
):
    shipment = db.query(models.CustomerShipment).filter(models.CustomerShipment.id == shipment_id).first()
    if not shipment:
        raise HTTPException(status_code=404, detail="Customer Shipment not found")

    reason = customer_shipment_service.blocked_delete_reason(db, shipment)
    if reason:
        raise HTTPException(status_code=409, detail=reason)

    db.delete(shipment)
    db.commit()
