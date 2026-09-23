"""
Portfolio Access -- the post-login "which product do you want to open"
gate. Today there are two products: "Factory" (not built yet) and
"US Factory" (this app). An admin manages who can see which via this
router's CRUD routes; the signed-in person's own picker reads
GET .../me.

Deliberately separate from app/api/users.py's app_users-based admin model:
a person with only Factory access may never get an app_users row in this
database at all (see PortfolioAccess's model docstring), so `/me` below
authenticates with get_verified_email (JWT-valid, no app_users row
required) rather than get_current_user. The admin CRUD routes below it
still gate on require_admin (an existing app_users.is_admin flag) --
managing this table is done from inside the US Factory app by the same
admins who already manage Setup -> Users, not a separate access tier.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import require_admin, get_verified_email

router = APIRouter(prefix="/api/v1/portfolio-access", tags=["portfolio-access"])


def _out(row: models.PortfolioAccess) -> schemas.PortfolioAccessOut:
    return schemas.PortfolioAccessOut(
        id=row.id,
        email=row.email,
        access_factory=row.access_factory,
        access_us_factory=row.access_us_factory,
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


@router.get("/me", response_model=schemas.PortfolioAccessMeOut)
def my_portfolio_access(
    email: str = Depends(get_verified_email),
    db: Session = Depends(get_db),
):
    row = (
        db.query(models.PortfolioAccess)
        .filter(models.PortfolioAccess.email == email.strip().lower())
        .first()
    )
    # No row => no access to either -- same safe-default convention as
    # effective_permission()'s "no explicit row => view-only" in deps.py.
    return schemas.PortfolioAccessMeOut(
        access_factory=bool(row and row.access_factory),
        access_us_factory=bool(row and row.access_us_factory),
    )


@router.get("", response_model=list[schemas.PortfolioAccessOut])
def list_portfolio_access(
    db: Session = Depends(get_db),
    _admin: models.AppUser = Depends(require_admin),
):
    rows = db.query(models.PortfolioAccess).order_by(models.PortfolioAccess.email).all()
    return [_out(r) for r in rows]


@router.post("", response_model=schemas.PortfolioAccessOut, status_code=status.HTTP_201_CREATED)
def create_portfolio_access(
    payload: schemas.PortfolioAccessIn,
    db: Session = Depends(get_db),
    _admin: models.AppUser = Depends(require_admin),
):
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="A valid email is required.")

    row = models.PortfolioAccess(
        email=email, access_factory=payload.access_factory, access_us_factory=payload.access_us_factory,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=f'"{email}" already has portfolio access configured.')
    db.commit()
    db.refresh(row)
    return _out(row)


@router.put("/{access_id}", response_model=schemas.PortfolioAccessOut)
def update_portfolio_access(
    access_id: uuid.UUID,
    payload: schemas.PortfolioAccessUpdateIn,
    db: Session = Depends(get_db),
    _admin: models.AppUser = Depends(require_admin),
):
    row = db.query(models.PortfolioAccess).filter(models.PortfolioAccess.id == access_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")
    if payload.access_factory is not None:
        row.access_factory = payload.access_factory
    if payload.access_us_factory is not None:
        row.access_us_factory = payload.access_us_factory
    db.commit()
    db.refresh(row)
    return _out(row)


@router.delete("/{access_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_portfolio_access(
    access_id: uuid.UUID,
    db: Session = Depends(get_db),
    _admin: models.AppUser = Depends(require_admin),
):
    row = db.query(models.PortfolioAccess).filter(models.PortfolioAccess.id == access_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")
    db.delete(row)
    db.commit()
    return None
