"""
Shipment Picking API -- also narrow (list/detail are direct-Supabase, per
spec point 15). Requests are never created here; they only ever come from
Customer Shipment's fan-out (customer_shipment_service.create_customer_shipment).
This router only exposes the pick / undo-pick actions, which need the
service-role connection because they mutate Pallet lifecycle state and
StorageRecord.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser
from app.domain import shipment_picking_service

router = APIRouter(prefix="/api/v1/shipment-picking", tags=["shipment-picking"])

MODULE = "shipment_picking"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    # Admin gets full access to every module -- see deps.effective_permission.
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def _get_request(db: Session, request_id: uuid.UUID) -> models.ShipmentPickingRequest:
    req = db.query(models.ShipmentPickingRequest).filter(models.ShipmentPickingRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Shipment Picking request not found")
    return req


@router.post("/{request_id}/pick", response_model=schemas.ShipmentPickOut)
def pick(
    request_id: uuid.UUID,
    body: schemas.ShipmentPickIn,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require("create")),
):
    req = _get_request(db, request_id)
    try:
        pick_row = shipment_picking_service.pick_pallet_for_request(db, req, body.payload, actor_user_id=current_user.user_id)
        db.commit()
    except shipment_picking_service.PickError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(e))
    db.refresh(req)
    picked_count = len(req.picks)
    return schemas.ShipmentPickOut(
        request_id=req.id,
        status=req.status,
        pallet_display_id=pick_row.pallet.display_id,
        pallets_picked=picked_count,
        pallets_required=req.pallets_required,
    )


@router.delete("/{request_id}/picks/{pick_id}", status_code=204)
def undo_pick(
    request_id: uuid.UUID,
    pick_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require("create")),
):
    req = _get_request(db, request_id)
    pick_row = (
        db.query(models.ShipmentPickingPick)
        .filter(models.ShipmentPickingPick.id == pick_id, models.ShipmentPickingPick.shipment_picking_request_id == req.id)
        .first()
    )
    if not pick_row:
        raise HTTPException(status_code=404, detail="Pick not found")
    try:
        shipment_picking_service.remove_pick(db, pick_row, actor_user_id=current_user.user_id)
        db.commit()
    except shipment_picking_service.PickError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(e))
