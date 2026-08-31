from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.domain import pallet_service

router = APIRouter(prefix="/api/v1/locations", tags=["locations"])


@router.get("")
def list_locations(db: Session = Depends(get_db), _current_user: AuthenticatedUser = Depends(get_current_user)):
    locations = db.query(models.Location).filter(models.Location.is_active.is_(True)).order_by(models.Location.display_id).all()
    changed = False
    for loc in locations:
        if not loc.qr_public_url:
            pallet_service.generate_location_qr(db, loc)
            changed = True
    if changed:
        db.commit()
    return [
        {"id": str(l.id), "display_id": l.display_id, "zone": l.zone, "qr_url": l.qr_public_url}
        for l in locations
    ]
