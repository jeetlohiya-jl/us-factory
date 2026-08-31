import uuid
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.domain import material_consumption_service as svc
from app.domain.pallet_serialization import serialize_mc_detail, serialize_mc_list_item

router = APIRouter(prefix="/api/v1/material-consumption", tags=["material-consumption"])

MODULE = "material_consumption"

SHIFTS = ["Shift A", "Shift B", "Shift C"]


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


def _q(db: Session):
    return (
        db.query(models.MaterialConsumption)
        .options(
            joinedload(models.MaterialConsumption.pallets).joinedload(models.MaterialConsumptionPallet.pallet),
            joinedload(models.MaterialConsumption.machine),
            joinedload(models.MaterialConsumption.production_run).joinedload(models.ProductionRun.ipqc_record),
        )
    )


def _get_or_404(db: Session, mc_id: uuid.UUID) -> models.MaterialConsumption:
    mc = _q(db).filter(models.MaterialConsumption.id == mc_id).first()
    if not mc:
        raise HTTPException(status_code=404, detail="Material Consumption record not found")
    return mc


@router.get("/shifts", response_model=list[str])
def list_shifts(_perm=Depends(require("view"))):
    return SHIFTS


@router.get("", response_model=list[schemas.MaterialConsumptionListItemOut])
def list_material_consumption(
    search: str = Query(""), category: str = Query(""), date: str = Query(""), status_: str = Query("", alias="status"),
    db: Session = Depends(get_db), _perm=Depends(require("view")),
):
    q = _q(db).order_by(models.MaterialConsumption.created_at.desc())
    recs = q.all()
    if category:
        recs = [r for r in recs if r.category == category]
    if date:
        recs = [r for r in recs if r.consumption_date == date]
    if status_:
        recs = [r for r in recs if r.status == status_]
    if search:
        s = search.lower()
        def matches(r: models.MaterialConsumption) -> bool:
            haystack = [
                r.sku_code_snapshot or "", r.sku_version_snapshot or "", r.category or "",
                r.machine.code if r.machine else "",
            ] + [p.pallet.display_id for p in r.pallets if p.role == "primary"]
            return any(s in h.lower() for h in haystack)
        recs = [r for r in recs if matches(r)]
    return [serialize_mc_list_item(r) for r in recs]


@router.post("/draft", response_model=schemas.MaterialConsumptionDetailOut, status_code=201)
def create_draft(
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require("create")),
):
    import datetime as _dt
    mc = models.MaterialConsumption(
        consumption_date=_dt.date.today().isoformat(), status="draft", created_by=current_user.user_id,
    )
    db.add(mc)
    db.commit()
    return serialize_mc_detail(_get_or_404(db, mc.id))


@router.get("/{mc_id}", response_model=schemas.MaterialConsumptionDetailOut)
def get_material_consumption(mc_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("view"))):
    return serialize_mc_detail(_get_or_404(db, mc_id))


@router.put("/{mc_id}/basic", response_model=schemas.MaterialConsumptionDetailOut)
def update_basic(
    mc_id: uuid.UUID, payload: schemas.MaterialConsumptionBasicUpdate,
    db: Session = Depends(get_db), current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require("edit")),
):
    mc = _get_or_404(db, mc_id)
    if mc.status != "draft":
        raise HTTPException(status_code=422, detail="This Material Consumption record has already been saved and cannot be changed.")
    if payload.machine_id is not None:
        machine = db.query(models.Machine).filter(models.Machine.id == payload.machine_id).first()
        if not machine:
            raise HTTPException(status_code=422, detail="Machine not found.")
        mc.machine_id = payload.machine_id
    if payload.shift is not None:
        mc.shift = payload.shift or None
    if payload.start_time is not None:
        mc.start_time = payload.start_time or None
    if payload.end_time is not None:
        mc.end_time = payload.end_time or None
    mc.updated_by = current_user.user_id
    db.commit()
    return serialize_mc_detail(_get_or_404(db, mc_id))


@router.post("/{mc_id}/scan-pallet", response_model=schemas.MaterialConsumptionDetailOut)
def scan_pallet(
    mc_id: uuid.UUID, body: schemas.MaterialConsumptionScanIn,
    db: Session = Depends(get_db), _perm=Depends(require("create")),
):
    mc = _get_or_404(db, mc_id)
    try:
        svc.add_primary_pallet(db, mc, body.payload, client_time=body.client_time)
        db.commit()
    except svc.MaterialConsumptionError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    return serialize_mc_detail(_get_or_404(db, mc_id))


@router.post("/{mc_id}/scan-secondary", response_model=schemas.MaterialConsumptionDetailOut)
def scan_secondary(
    mc_id: uuid.UUID, body: schemas.MaterialConsumptionSecondaryScanIn,
    db: Session = Depends(get_db), _perm=Depends(require("create")),
):
    mc = _get_or_404(db, mc_id)
    try:
        svc.add_secondary_pallet(db, mc, body.payload, body.category)
        db.commit()
    except svc.MaterialConsumptionError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    return serialize_mc_detail(_get_or_404(db, mc_id))


@router.delete("/{mc_id}/pallets/{row_id}", response_model=schemas.MaterialConsumptionDetailOut)
def remove_pallet(
    mc_id: uuid.UUID, row_id: uuid.UUID,
    db: Session = Depends(get_db), _perm=Depends(require("edit")),
):
    mc = _get_or_404(db, mc_id)
    try:
        svc.remove_pallet(db, mc, row_id)
        db.commit()
    except svc.MaterialConsumptionError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    return serialize_mc_detail(_get_or_404(db, mc_id))


class QuantityIn(schemas.BaseModel):
    quantity: str


@router.put("/{mc_id}/pallets/{row_id}/quantity", response_model=schemas.MaterialConsumptionDetailOut)
def set_pallet_quantity(
    mc_id: uuid.UUID, row_id: uuid.UUID, body: QuantityIn,
    db: Session = Depends(get_db), _perm=Depends(require("edit")),
):
    mc = _get_or_404(db, mc_id)
    try:
        qty = Decimal(body.quantity)
    except (InvalidOperation, ValueError):
        raise HTTPException(status_code=422, detail="Invalid quantity.")
    try:
        svc.set_secondary_quantity(db, mc, row_id, qty)
        db.commit()
    except svc.MaterialConsumptionError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    return serialize_mc_detail(_get_or_404(db, mc_id))


@router.post("/{mc_id}/save-draft", response_model=schemas.MaterialConsumptionDetailOut)
def save_draft(mc_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("create"))):
    """Draft is already persisted as records are scanned/edited -- this
    endpoint exists purely to mirror the app's Save-Draft-vs-Submit UX
    convention. It intentionally does nothing beyond confirming the record
    exists: no pallet is consumed, no Production Run/IPQC is created."""
    return serialize_mc_detail(_get_or_404(db, mc_id))


@router.post("/{mc_id}/finalize", response_model=schemas.MaterialConsumptionDetailOut)
def finalize(
    mc_id: uuid.UUID, db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require("create")),
):
    mc = _get_or_404(db, mc_id)
    try:
        svc.finalize(db, mc, actor_user_id=current_user.user_id)
        db.commit()
    except svc.MaterialConsumptionError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=e.message)
    return serialize_mc_detail(_get_or_404(db, mc_id))


@router.delete("/{mc_id}/if-blank", status_code=204)
def discard_if_blank(mc_id: uuid.UUID, db: Session = Depends(get_db)):
    mc = db.query(models.MaterialConsumption).options(joinedload(models.MaterialConsumption.pallets)).filter(models.MaterialConsumption.id == mc_id).first()
    if mc and mc.status == "draft" and svc.is_blank(mc):
        db.delete(mc)
        db.commit()
    return None


@router.delete("/{mc_id}")
def delete_material_consumption(mc_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require("delete"))):
    mc = _get_or_404(db, mc_id)
    blocked = svc.find_dependent_summary(mc)
    if blocked:
        raise HTTPException(status_code=409, detail=blocked)
    db.delete(mc)
    db.commit()
    return {"ok": True}
