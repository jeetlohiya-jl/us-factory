"""
Minimal Production Run listing — added strictly to give FG QR Generation a
real upstream source to auto-populate from (see the note in
migrations/0003_rm_fg_qr_storage.sql and app/db/models.py:ProductionRun).
The full Production/IPQC/Material Allocation modules are out of scope here;
this is intentionally just enough to drive "Production feeds FG QR
Generation" for approved runs, exactly as an approved Inward QC feeds RM QR
Generation.
"""
import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser

router = APIRouter(prefix="/api/v1/production-runs", tags=["production-runs"])


def _serialize(run: models.ProductionRun) -> schemas.ProductionRunOut:
    return schemas.ProductionRunOut(
        id=run.id, run_number=run.run_number, shipment_number=run.shipment_number,
        sku_code=run.sku_code.code if run.sku_code else None,
        sku_version=run.sku_version.version if run.sku_version else None,
        category=run.category, total_fg_pallets=run.total_fg_pallets, status=run.status,
    )


@router.get("", response_model=list[schemas.ProductionRunOut])
def list_production_runs(
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
):
    runs = (
        db.query(models.ProductionRun)
        .options(joinedload(models.ProductionRun.sku_code), joinedload(models.ProductionRun.sku_version))
        .order_by(models.ProductionRun.created_at.desc())
        .all()
    )
    fg_qr_run_ids = {
        r.source_production_run_id
        for r in db.query(models.QrGenerationRecord.source_production_run_id)
        .filter(models.QrGenerationRecord.source_production_run_id.isnot(None))
        .all()
    }
    out = []
    for run in runs:
        item = _serialize(run)
        item.has_fg_qr = run.id in fg_qr_run_ids
        out.append(item)
    return out


@router.post("", response_model=schemas.ProductionRunOut, status_code=201)
def create_production_run(
    run_number: str, sku_code_id: uuid.UUID, sku_version_id: uuid.UUID | None = None,
    shipment_number: str | None = None, total_fg_pallets: int = 0, shift: str | None = None,
    category: str = "fgtray", status_: str = "approved",
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
):
    """Dev/test-only creation endpoint — a real Production module would own
    this. Kept intentionally bare-bones since it is out of scope here."""
    run = models.ProductionRun(
        run_number=run_number, sku_code_id=sku_code_id, sku_version_id=sku_version_id,
        shipment_number=shipment_number, total_fg_pallets=total_fg_pallets, shift=shift,
        category=category, status=status_, created_by=current_user.user_id,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return _serialize(run)
