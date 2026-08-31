from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import require_permission

router = APIRouter(prefix="/api/v1/reference", tags=["reference"])


@router.get("/sku-codes", response_model=list[schemas.SkuCodeOut])
def list_sku_codes(db: Session = Depends(get_db), _perm=Depends(require_permission("view"))):
    """Reference-data source for SKU Code + SKU Version pickers. Not hardcoded
    in the frontend — this is the source a future Admin console will manage."""
    codes = (
        db.query(models.SkuCode)
        .options(joinedload(models.SkuCode.versions))
        .filter(models.SkuCode.is_active.is_(True))
        .order_by(models.SkuCode.code)
        .all()
    )
    return codes


@router.get("/checklist-items", response_model=list[schemas.ChecklistItemOut])
def list_checklist_items(db: Session = Depends(get_db), _perm=Depends(require_permission("view"))):
    items = (
        db.query(models.ChecklistItem)
        .filter(models.ChecklistItem.is_active.is_(True))
        .order_by(models.ChecklistItem.sort_order)
        .all()
    )
    return items
