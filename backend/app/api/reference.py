from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import require_permission

router = APIRouter(prefix="/api/v1/reference", tags=["reference"])


@router.get("/sku-codes", response_model=list[schemas.SkuCodeOut])
def list_sku_codes(
    category: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("view")),
):
    """Reference-data source for SKU Name + SKU Version pickers -- managed
    from the /skus admin screen (see app/api/skus.py), not hardcoded here.
    category optionally scopes results to one material category (a Glue
    line item has no business offering Polybag SKUs) the way /vendors
    already scopes vendors."""
    q = (
        db.query(models.SkuCode)
        .options(joinedload(models.SkuCode.versions))
        .filter(models.SkuCode.is_active.is_(True))
    )
    if category:
        q = q.filter(models.SkuCode.category == category)
    return q.order_by(models.SkuCode.code).all()


@router.get("/checklist-items", response_model=list[schemas.ChecklistItemOut])
def list_checklist_items(db: Session = Depends(get_db), _perm=Depends(require_permission("view"))):
    items = (
        db.query(models.ChecklistItem)
        .filter(models.ChecklistItem.is_active.is_(True))
        .order_by(models.ChecklistItem.sort_order)
        .all()
    )
    return items
