import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import require_admin

router = APIRouter(prefix="/api/v1/users", tags=["users"])


def _user_out(user: models.AppUser) -> schemas.UserOut:
    rows_by_module = {p.module: p for p in user.permissions}
    permissions = {
        module: schemas.PermissionFlags(
            can_view=row.can_view, can_create=row.can_create, can_edit=row.can_edit,
            can_delete=row.can_delete, can_approve=row.can_approve, can_fill_section=row.can_fill_section,
        ) if row else schemas.PermissionFlags()
        for module, row in ((m, rows_by_module.get(m)) for m in schemas.USER_MODULES)
    }
    return schemas.UserOut(
        id=user.id, email=user.email, full_name=user.full_name,
        is_active=user.is_active, is_admin=user.is_admin, permissions=permissions,
    )


def _upsert_permissions(db: Session, user: models.AppUser, permissions: dict[str, schemas.PermissionFlags]) -> None:
    """Only touches modules present in `permissions` -- omitted modules
    keep whatever row (or absence of one, i.e. the view-only default) they
    already had, so a partial update from the edit screen never silently
    resets an untouched module back to view-only."""
    existing = {p.module: p for p in user.permissions}
    for module, flags in permissions.items():
        if module not in schemas.USER_MODULES:
            raise HTTPException(status_code=422, detail=f"Unknown module: {module}")
        row = existing.get(module)
        if row is None:
            row = models.ModulePermission(user_id=user.id, module=module)
            db.add(row)
        row.can_view = flags.can_view
        row.can_create = flags.can_create
        row.can_edit = flags.can_edit
        row.can_delete = flags.can_delete
        row.can_approve = flags.can_approve
        row.can_fill_section = flags.can_fill_section


@router.get("", response_model=list[schemas.UserOut])
def list_users(
    db: Session = Depends(get_db),
    _admin: models.AppUser = Depends(require_admin),
):
    users = db.query(models.AppUser).order_by(models.AppUser.full_name).all()
    return [_user_out(u) for u in users]


@router.post("", response_model=schemas.UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: schemas.UserCreateIn,
    db: Session = Depends(get_db),
    _admin: models.AppUser = Depends(require_admin),
):
    email = payload.email.strip().lower()
    full_name = payload.full_name.strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="A valid email is required.")
    if not full_name:
        raise HTTPException(status_code=422, detail="Full name is required.")

    user = models.AppUser(email=email, full_name=full_name, is_active=payload.is_active, is_admin=payload.is_admin)
    db.add(user)
    try:
        db.flush()  # assigns user.id, still inside the outer transaction
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{email}" already has an account.')

    # New user: seed every module explicitly (rather than only the ones the
    # caller passed) so the resulting row set always matches what /me
    # would report for them -- no module silently left un-rowed just
    # because the add-user form didn't send it.
    for module in schemas.USER_MODULES:
        flags = payload.permissions.get(module, schemas.PermissionFlags())
        db.add(models.ModulePermission(
            user_id=user.id, module=module,
            can_view=flags.can_view, can_create=flags.can_create, can_edit=flags.can_edit,
            can_delete=flags.can_delete, can_approve=flags.can_approve, can_fill_section=flags.can_fill_section,
        ))
    db.commit()
    db.refresh(user)
    return _user_out(user)


@router.put("/{user_id}", response_model=schemas.UserOut)
def update_user(
    user_id: uuid.UUID,
    payload: schemas.UserUpdateIn,
    db: Session = Depends(get_db),
    admin: models.AppUser = Depends(require_admin),
):
    user = db.query(models.AppUser).filter(models.AppUser.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    if payload.full_name is not None:
        full_name = payload.full_name.strip()
        if not full_name:
            raise HTTPException(status_code=422, detail="Full name is required.")
        user.full_name = full_name
    if payload.is_active is not None:
        if user.id == admin.id and not payload.is_active:
            raise HTTPException(status_code=422, detail="You can't deactivate your own account.")
        user.is_active = payload.is_active
    if payload.is_admin is not None:
        if user.id == admin.id and not payload.is_admin:
            raise HTTPException(status_code=422, detail="You can't remove your own admin access.")
        user.is_admin = payload.is_admin
    if payload.permissions is not None:
        _upsert_permissions(db, user, payload.permissions)

    db.commit()
    db.refresh(user)
    return _user_out(user)
