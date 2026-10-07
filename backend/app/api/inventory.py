import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser
from app.domain import inventory_service

router = APIRouter(prefix="/api/v1/inventory", tags=["inventory"])

MODULE = "inventory"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    # Admin gets full access to every module -- see deps.effective_permission.
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def require_any(*actions: str):
    """Allowed if the person has ANY of the given actions."""
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not any(getattr(perm, f"can_{a}", False) for a in actions):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to add stock.")
        return perm
    return _dep


@router.get("", response_model=schemas.InventoryListOut)
def list_inventory(
    search: str = Query(""),
    page: int = Query(default=1, ge=1), page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db), _perm=Depends(require("view")),
):
    items, matched_count = inventory_service.list_inventory(db, search=search, page=page, page_size=page_size)
    return {"items": items, "matched_count": matched_count}


@router.get("/{item_id}", response_model=schemas.InventoryDetailOut)
def get_inventory(item_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("view"))):
    detail = inventory_service.get_inventory_detail(db, item_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Inventory item not found.")
    return detail


@router.post("", response_model=schemas.InventoryDetailOut, status_code=status.HTTP_201_CREATED)
def create_inventory(
    # New Inventory items (a SKU not yet in Inventory) are set up by admins
    # (or in Supabase) -- the "+ Add" screen only adds stock to existing items.
    payload: schemas.InventoryCreateIn, db: Session = Depends(get_db), _admin=Depends(deps.require_admin),
):
    try:
        item = inventory_service.create_inventory_item(db, payload)
    except inventory_service.InventoryValidationError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    return inventory_service.get_inventory_detail(db, item.id)


@router.patch("/{item_id}", response_model=schemas.InventoryDetailOut)
def update_inventory(
    item_id: uuid.UUID, payload: schemas.InventoryUpdateIn, db: Session = Depends(get_db), _perm=Depends(require("edit")),
):
    try:
        item = inventory_service.update_inventory_item(db, item_id, payload)
    except inventory_service.InventoryValidationError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    return inventory_service.get_inventory_detail(db, item.id)


@router.post("/{item_id}/sources", response_model=schemas.InventoryDetailOut, status_code=status.HTTP_201_CREATED)
def add_source(
    # Stock arriving for an existing item: "+ Add" (Create) or the item's own
    # panel (Edit) -- either permission may record it.
    item_id: uuid.UUID, payload: schemas.InventorySourceIn, db: Session = Depends(get_db), _perm=Depends(require_any("create", "edit")),
):
    try:
        inventory_service.add_manual_source(db, item_id, payload)
    except inventory_service.InventoryValidationError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    return inventory_service.get_inventory_detail(db, item_id)
