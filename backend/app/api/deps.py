from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.db import models
from app.adapters.auth.base import AuthenticatedUser


def get_auth_adapter(db: Session = Depends(get_db)):
    settings = get_settings()
    if settings.auth_provider == "supabase":
        from app.adapters.auth.supabase_adapter import SupabaseAuthAdapter
        return SupabaseAuthAdapter(db)
    from app.adapters.auth.dev_adapter import DevAuthAdapter
    return DevAuthAdapter(db)


def get_current_user(
    authorization: str | None = Header(default=None),
    auth_adapter=Depends(get_auth_adapter),
) -> AuthenticatedUser:
    user = auth_adapter.resolve_user(authorization)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


MODULE = "inward_vehicle_inspection"


def effective_permission(db: Session, user_id, module: str) -> models.ModulePermission:
    """Single shared source of truth for "what can this user do in this
    module", used by every router's own get_perms() (all of which used to
    duplicate this exact lookup+default). Reuses the existing
    module_permissions structure -- this is not a second permission system,
    just where the "no explicit row => view-only" default AND the "Admin
    has full access to everything, not just View" rule both live, so every
    module gets both consistently instead of each router re-implementing
    (and potentially drifting on) its own copy.

    is_admin (app_users.is_admin) grants every permission in every module,
    unconditionally overriding whatever module_permissions rows exist --
    matches the same "Admin must have full access" rule already applied to
    Supabase-direct reads/writes via the app_can() SQL function (migration
    0011, updated by 0022... see there for the RLS-side mirror of this).
    The returned object is transient (never persisted) when there is no
    real row or when overridden for an admin -- exactly like the previous
    per-router default already was.
    """
    app_user = db.query(models.AppUser).filter(models.AppUser.id == user_id).first()
    if app_user and app_user.is_admin:
        return models.ModulePermission(
            user_id=user_id, module=module,
            can_view=True, can_create=True, can_edit=True, can_delete=True, can_approve=True, can_fill_section=True,
        )
    perm = (
        db.query(models.ModulePermission)
        .filter(models.ModulePermission.user_id == user_id, models.ModulePermission.module == module)
        .first()
    )
    if not perm:
        # No explicit row => view-only, matching a safe default for the existing
        # user-based permission model.
        perm = models.ModulePermission(user_id=user_id, module=module, can_view=True)
    return perm


def get_permissions(
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.ModulePermission:
    return effective_permission(db, current_user.user_id, MODULE)


def require_permission(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_permissions)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def require_admin(
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.AppUser:
    """Gate for the Setup -> Users screen (app/api/users.py). Separate from
    the module_permissions model entirely -- managing other users' accounts
    and permissions isn't a per-module action, so it gets its own flag
    (app_users.is_admin, migration 0018) rather than overloading an
    existing module's can_edit."""
    user = db.query(models.AppUser).filter(models.AppUser.id == current_user.user_id).first()
    if not user or not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required.")
    return user
