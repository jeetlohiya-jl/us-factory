import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import require_permission

router = APIRouter(prefix="/api/v1/skus", tags=["skus"])


@router.get("", response_model=list[schemas.SkuCodeOut])
def list_skus(
    category: str | None = Query(default=None),
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("view")),
):
    """Management-screen listing (see /skus admin screen) -- unlike
    /reference/sku-codes (the picker source, active-only), this includes
    inactive SKUs/versions when asked so they can be reactivated."""
    q = db.query(models.SkuCode).options(joinedload(models.SkuCode.versions))
    if category:
        q = q.filter(models.SkuCode.category == category)
    if not include_inactive:
        q = q.filter(models.SkuCode.is_active.is_(True))
    return q.order_by(models.SkuCode.category, models.SkuCode.code).all()


@router.post("", response_model=schemas.SkuCodeOut, status_code=status.HTTP_201_CREATED)
def create_sku(
    payload: schemas.SkuCodeIn,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    code = payload.code.strip()
    if not code:
        raise HTTPException(status_code=422, detail="SKU Name is required.")
    sku = models.SkuCode(category=payload.category.strip(), code=code, is_active=True)
    db.add(sku)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{code}" already exists.')
    db.refresh(sku)
    return sku


@router.put("/{sku_id}", response_model=schemas.SkuCodeOut)
def update_sku(
    sku_id: uuid.UUID,
    payload: schemas.SkuCodeUpdateIn,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    sku = db.query(models.SkuCode).options(joinedload(models.SkuCode.versions)).filter(models.SkuCode.id == sku_id).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU not found.")
    if payload.code is not None:
        code = payload.code.strip()
        if not code:
            raise HTTPException(status_code=422, detail="SKU Name is required.")
        sku.code = code
    if payload.is_active is not None:
        sku.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{payload.code}" already exists.')
    db.refresh(sku)
    return sku


@router.delete("/{sku_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sku(
    sku_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    sku = db.query(models.SkuCode).filter(models.SkuCode.id == sku_id).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU not found.")
    try:
        db.delete(sku)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="This SKU is referenced by existing records and can't be deleted — deactivate it instead.",
        )
    return None


@router.post("/{sku_id}/versions", response_model=schemas.SkuCodeOut, status_code=status.HTTP_201_CREATED)
def add_version(
    sku_id: uuid.UUID,
    payload: schemas.SkuVersionIn,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    sku = db.query(models.SkuCode).options(joinedload(models.SkuCode.versions)).filter(models.SkuCode.id == sku_id).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU not found.")
    version = payload.version.strip()
    if not version:
        raise HTTPException(status_code=422, detail="Version is required.")
    db.add(models.SkuVersion(sku_code_id=sku_id, version=version, is_active=True))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'Version "{version}" already exists for this SKU.')
    db.refresh(sku)
    return sku


@router.put("/versions/{version_id}", response_model=schemas.SkuVersionOut)
def update_version(
    version_id: uuid.UUID,
    payload: schemas.SkuVersionUpdateIn,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    version = db.query(models.SkuVersion).filter(models.SkuVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="SKU version not found.")
    if payload.version is not None:
        v = payload.version.strip()
        if not v:
            raise HTTPException(status_code=422, detail="Version is required.")
        version.version = v
    if payload.is_active is not None:
        version.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'Version "{payload.version}" already exists for this SKU.')
    db.refresh(version)
    return version


@router.delete("/versions/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_version(
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("edit")),
):
    version = db.query(models.SkuVersion).filter(models.SkuVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="SKU version not found.")
    try:
        db.delete(version)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="This version is referenced by existing records and can't be deleted — deactivate it instead.",
        )
    return None
