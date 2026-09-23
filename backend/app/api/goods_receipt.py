"""
Factory OS Module 1 -- Goods Receipt: the ONE write that needs FastAPI.

Supabase is the primary backend for Goods Receipt. List/detail reads are
Supabase-direct (lib/api.ts listGoodsReceiptsSb / getGoodsReceiptSb), and
save / inward / delete are atomic Postgres functions called via
supabase.rpc() (goods_receipt_save / goods_receipt_inward /
goods_receipt_delete, migration 0045).

Pallet QR generation is the exception and lives here, because it:
  - renders one QR PNG per pallet and uploads it to Storage, and
  - must use the exact same RM batch/pallet numbering + country-prefix code
    (qr_generation_service / pallet_service) as every other RM batch, so the
    QR format can never drift into a second implementation.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload, selectinload

from app.adapters.auth.base import AuthenticatedUser
from app.api import deps
from app.api.deps import get_current_user
from app.db import models
from app.db.session import get_db
from app.domain import qr_generation_service
from app.domain.pallet_serialization import serialize_qr_detail

router = APIRouter(prefix="/api/v1/goods-receipts", tags=["goods-receipt"])

MODULE = "goods_receipt"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


@router.post("/{gr_id}/entries/{entry_id}/generate-qr")
def generate_entry_qr(
    gr_id: uuid.UUID, entry_id: uuid.UUID, db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user), _perm=Depends(require("fill_section")),
):
    """Find-or-create this inwarded entry's RM QR batch (at most one per
    entry -- partial unique index uq_qr_source_goods_receipt_entry) and
    generate its pallets through the same generate_pallets every RM batch
    uses: row lock -> no double generation, shared numbering, parallel QR
    upload, pallets go straight to pending_storage. Already generated ->
    returned as-is. The response carries every pallet, so the UI shows the
    QRs immediately with no second fetch."""
    entry = (
        db.query(models.GoodsReceiptEntry)
        .options(joinedload(models.GoodsReceiptEntry.goods_receipt).joinedload(models.GoodsReceipt.vendor))
        .options(joinedload(models.GoodsReceiptEntry.sku_code))
        .filter(models.GoodsReceiptEntry.id == entry_id, models.GoodsReceiptEntry.goods_receipt_id == gr_id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Container entry not found on this Goods Receipt.")
    if entry.status != "inwarded":
        raise HTTPException(status_code=409, detail="Inward this container before generating its pallet QRs.")
    # Serialize concurrent first clicks on the entry row so only one of them
    # creates the batch; the unique index is the backstop behind this.
    db.query(models.GoodsReceiptEntry.id).filter(models.GoodsReceiptEntry.id == entry.id).with_for_update().one()
    batch = qr_generation_service.get_or_create_rm_qr_for_goods_receipt_entry(db, entry, current_user.user_id)
    try:
        qr_generation_service.generate_pallets(db, batch, actor_user_id=current_user.user_id)
    except qr_generation_service.QrGenerationError as e:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(e))
    db.commit()
    rec = (
        db.query(models.QrGenerationRecord)
        .options(selectinload(models.QrGenerationRecord.pallets).joinedload(models.Pallet.current_location))
        .options(selectinload(models.QrGenerationRecord.pallets).joinedload(models.Pallet.storage_record))
        .options(joinedload(models.QrGenerationRecord.source_goods_receipt_entry).joinedload(models.GoodsReceiptEntry.goods_receipt))
        .filter(models.QrGenerationRecord.id == batch.id)
        .one()
    )
    return serialize_qr_detail(rec)
