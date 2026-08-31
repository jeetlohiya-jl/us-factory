import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas

router = APIRouter(prefix="/api/v1/machines", tags=["machines"])

# Machines are managed data for Material Consumption / Production -- gated
# on that module's own permission (mirrors how Vendors/SKU Names are gated
# on inward_vehicle_inspection, the module that actually consumes them).
MODULE = "material_consumption"


from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser


def _get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    perm = db.query(models.ModulePermission).filter(models.ModulePermission.user_id == current_user.user_id, models.ModulePermission.module == MODULE).first()
    if not perm:
        perm = models.ModulePermission(user_id=current_user.user_id, module=MODULE, can_view=True)
    return perm


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(_get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


@router.get("", response_model=list[schemas.MachineOut])
def list_machines(
    include_inactive: bool = Query(default=False),
    db: Session = Depends(get_db),
    _perm=Depends(require("view")),
):
    q = db.query(models.Machine)
    if not include_inactive:
        q = q.filter(models.Machine.is_active.is_(True))
    return q.order_by(models.Machine.code).all()


@router.post("", response_model=schemas.MachineOut, status_code=status.HTTP_201_CREATED)
def create_machine(
    payload: schemas.MachineIn,
    db: Session = Depends(get_db),
    _perm=Depends(require("edit")),
):
    code = payload.code.strip()
    if not code:
        raise HTTPException(status_code=422, detail="Machine code is required.")
    machine = models.Machine(code=code, is_active=True)
    db.add(machine)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{code}" already exists.')
    db.refresh(machine)
    return machine


@router.put("/{machine_id}", response_model=schemas.MachineOut)
def update_machine(
    machine_id: uuid.UUID,
    payload: schemas.MachineUpdateIn,
    db: Session = Depends(get_db),
    _perm=Depends(require("edit")),
):
    machine = db.query(models.Machine).filter(models.Machine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=404, detail="Machine not found.")
    if payload.code is not None:
        code = payload.code.strip()
        if not code:
            raise HTTPException(status_code=422, detail="Machine code is required.")
        machine.code = code
    if payload.is_active is not None:
        machine.is_active = payload.is_active
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{payload.code}" already exists.')
    db.refresh(machine)
    return machine


@router.delete("/{machine_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_machine(
    machine_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require("edit")),
):
    machine = db.query(models.Machine).filter(models.Machine.id == machine_id).first()
    if not machine:
        raise HTTPException(status_code=404, detail="Machine not found.")
    in_use = db.query(models.MaterialConsumption).filter(models.MaterialConsumption.machine_id == machine_id).first()
    if in_use:
        raise HTTPException(status_code=409, detail="This machine is referenced by an existing Material Consumption record and cannot be deleted. Deactivate it instead.")
    db.delete(machine)
    db.commit()
    return None
