from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.auth.base import AuthenticatedUser
from app.api.deps import get_current_user
from app.db.session import get_db
from app.db import models

router = APIRouter(prefix="/api/v1", tags=["me"])

MODULES = [
    "inward_vehicle_inspection", "inward_qc",
    "rm_qr_generation", "rm_storage", "material_consumption", "production", "ipqc", "rqc", "fg_qr_generation", "fg_storage",
]


def _perm_dict(perm: models.ModulePermission | None) -> dict:
    if not perm:
        return {"can_view": True, "can_create": False, "can_edit": False, "can_delete": False, "can_approve": False, "can_fill_section": False}
    return {
        "can_view": perm.can_view, "can_create": perm.can_create, "can_edit": perm.can_edit,
        "can_delete": perm.can_delete, "can_approve": perm.can_approve, "can_fill_section": perm.can_fill_section,
    }


@router.get("/me")
def me(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(models.ModulePermission)
        .filter(models.ModulePermission.user_id == current_user.user_id, models.ModulePermission.module.in_(MODULES))
        .all()
    )
    rows_by_module = {row.module: row for row in rows}
    perms = {module: _perm_dict(rows_by_module.get(module)) for module in MODULES}
    # is_admin gates the Setup -> Users screen (frontend nav + the
    # require_admin-protected /api/v1/users endpoints) -- not a
    # module_permissions flag, since managing other users isn't scoped to
    # one module. Missing user row (shouldn't happen, get_current_user
    # already resolved one) defaults to non-admin rather than erroring.
    app_user = db.query(models.AppUser).filter(models.AppUser.id == current_user.user_id).first()
    return {
        "user_id": current_user.user_id,
        "email": current_user.email,
        "full_name": current_user.full_name,
        "is_admin": bool(app_user and app_user.is_admin),
        "permissions": perms,
    }
