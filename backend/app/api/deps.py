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


def get_permissions(
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.ModulePermission:
    perm = (
        db.query(models.ModulePermission)
        .filter(models.ModulePermission.user_id == current_user.user_id, models.ModulePermission.module == MODULE)
        .first()
    )
    if not perm:
        # No explicit row => view-only, matching a safe default for the existing
        # user-based permission model.
        perm = models.ModulePermission(user_id=current_user.user_id, module=MODULE, can_view=True)
    return perm


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
