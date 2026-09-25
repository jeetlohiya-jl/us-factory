"""
Customer Shipment API -- deliberately narrow. Per spec point 15, list/detail
reads are direct-Supabase from the frontend (see frontend/src/lib/api.ts),
NOT FastAPI GET routes. create/update/delete need the service-role
connection for their atomic multi-table transactions (spec points 14/16)
and the Admin-only + dependency-blocking delete rule.

2026-09-25 -- adds the Packing List pair (PUT .../packing-list, GET
.../packing-list-pdf) for Goods Outward's "Print Packing List": the save
route persists the operator-entered fields, the PDF route is a pure read-
and-render off whatever's currently saved (packing_list_service).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser
from app.domain import customer_shipment_service, packing_list_service
from sqlalchemy.exc import IntegrityError

router = APIRouter(prefix="/api/v1/customer-shipments", tags=["customer-shipment"])

MODULE = "customer_shipment"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    # Admin gets full access to every module -- see deps.effective_permission.
    return deps.effective_permission(db, current_user.user_id, MODULE)


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
    if not body.shipment_number or not body.shipment_number.strip():
        raise HTTPException(status_code=422, detail="Shipment Number is required.")
    valid_items = [li for li in body.line_items if li.pallets_required > 0]
    if not valid_items:
        raise HTTPException(status_code=422, detail="At least one line item with a SKU, Version and pallet quantity is required.")

    try:
        shipment = customer_shipment_service.create_customer_shipment(
            db,
            customer=body.customer.strip(),
            shipment_number=body.shipment_number.strip(),
            line_items=[li.model_dump() for li in valid_items],
            actor_user_id=current_user.user_id,
        )
        db.commit()
    except IntegrityError as e:
        db.rollback()
        if "customer_shipments_shipment_number_key" in str(e.orig):
            raise HTTPException(status_code=409, detail=f'Shipment Number "{body.shipment_number.strip()}" already exists.')
        raise HTTPException(status_code=409, detail="Could not save this Customer Shipment (a unique value conflicted).")
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
                pcs=li.pcs, pcs_per_sleeve=li.pcs_per_sleeve,
            )
            for li in shipment.line_items
        ],
    )


@router.put("/{shipment_id}", response_model=schemas.CustomerShipmentCreateOut)
def update(
    shipment_id: uuid.UUID,
    body: schemas.CustomerShipmentUpdateIn,
    db: Session = Depends(get_db),
    _perm=Depends(require("edit")),
):
    """
    2026-09-24 -- Goods Outward Edit. Same atomic-transaction shape as
    create above, via customer_shipment_service.update_customer_shipment:
    diffs line_items by id (see that function's docstring), blocking
    (409) the instant any change would touch a line item that already has
    real FG pallets picked against it (customer_shipment_service.
    blocked_line_item_edit_reason) -- checked before anything is written,
    so a blocked request never leaves a partial edit applied.
    """
    shipment = db.query(models.CustomerShipment).filter(models.CustomerShipment.id == shipment_id).first()
    if not shipment:
        raise HTTPException(status_code=404, detail="Customer Shipment not found")

    if not body.customer or not body.customer.strip():
        raise HTTPException(status_code=422, detail="Customer / Recipient is required.")
    if not body.shipment_number or not body.shipment_number.strip():
        raise HTTPException(status_code=422, detail="Shipment Number is required.")
    valid_items = [li for li in body.line_items if li.pallets_required > 0]
    if not valid_items:
        raise HTTPException(status_code=422, detail="At least one line item with a SKU, Version and pallet quantity is required.")

    try:
        customer_shipment_service.update_customer_shipment(
            db,
            shipment,
            customer=body.customer.strip(),
            shipment_number=body.shipment_number.strip(),
            line_items=[li.model_dump() for li in valid_items],
        )
        db.commit()
    except customer_shipment_service.CustomerShipmentEditBlocked as e:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(e))
    except IntegrityError as e:
        db.rollback()
        if "customer_shipments_shipment_number_key" in str(e.orig):
            raise HTTPException(status_code=409, detail=f'Shipment Number "{body.shipment_number.strip()}" already exists.')
        raise HTTPException(status_code=409, detail="Could not save this Customer Shipment (a unique value conflicted).")
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
                pcs=li.pcs, pcs_per_sleeve=li.pcs_per_sleeve,
            )
            for li in shipment.line_items
        ],
    )


@router.put("/{shipment_id}/packing-list", status_code=204)
def save_packing_list(
    shipment_id: uuid.UUID,
    body: schemas.PackingListSaveIn,
    db: Session = Depends(get_db),
    _perm=Depends(require("edit")),
):
    """Saves the packing-list-specific fields (PO No./PO Date/PI No./Ship
    To + each line item's UOM/Total Combo) so a later reprint needs no
    re-entry -- see packing_list_service.save_packing_list_fields. Called
    right before GET .../packing-list-pdf by the "Create Packing List"
    step on Goods Outward's detail panel."""
    shipment = db.query(models.CustomerShipment).filter(models.CustomerShipment.id == shipment_id).first()
    if not shipment:
        raise HTTPException(status_code=404, detail="Customer Shipment not found")

    packing_list_service.save_packing_list_fields(
        db, shipment,
        po_number=body.po_number, po_date=body.po_date, pi_number=body.pi_number,
        ship_to_address=body.ship_to_address,
        line_items=[li.model_dump() for li in body.line_items],
    )
    db.commit()
    return None


@router.get("/{shipment_id}/packing-list-pdf")
def download_packing_list(
    shipment_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require("view")),
):
    """Renders the currently-saved packing-list fields into Cirkla's exact
    Packing List document (packing_list_service.generate_packing_list_pdf).
    Pure read -- call PUT .../packing-list first to persist any changes."""
    shipment = db.query(models.CustomerShipment).filter(models.CustomerShipment.id == shipment_id).first()
    if not shipment:
        raise HTTPException(status_code=404, detail="Customer Shipment not found")

    pdf_bytes = packing_list_service.generate_packing_list_pdf(db, shipment)
    filename = f"Packing_List_{shipment.shipment_number}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
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

    customer_shipment_service.delete_customer_shipment(db, shipment)
    db.commit()
