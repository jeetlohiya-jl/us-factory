from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.adapters.auth.base import AuthenticatedUser
from app.api.deps import get_current_user
from app.db.session import get_db
from app.db import models

router = APIRouter(prefix="/api/v1", tags=["me"])

MODULES = [
    "inward_vehicle_inspection", "inward_qc",
    "rm_qr_generation", "rm_storage", "material_consumption", "production", "fg_qr_generation", "fg_storage",
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
    perms = {}
    for module in MODULES:
        row = (
            db.query(models.ModulePermission)
            .filter(models.ModulePermission.user_id == current_user.user_id, models.ModulePermission.module == module)
            .first()
        )
        perms[module] = _perm_dict(row)
    return {
        "user_id": current_user.user_id,
        "email": current_user.email,
        "full_name": current_user.full_name,
        "permissions": perms,
    }
