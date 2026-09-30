"""
Goods Receipt COA (Certificate of Analysis) upload -- 2026-09-30, migration
0080. Polybag/Soaker Pad/CFB entries require a COA (PDF, Word doc, or image)
before their QR codes can be generated (see goods_receipt_generate_pallets'
own guard, and needsCoa() in the frontend). This is a real file, so -- same
reasoning as Inward QC's own COA endpoint (inward_qc.py) -- it goes through
FastAPI rather than Supabase-direct even though the rest of Goods Receipt is
Supabase-direct. Unlike Inward QC's COA, there's no parsing here: just an
upload, written straight onto the goods_receipt_entries row, independent of
(and not gated by) the inward RPCs -- it can happen any time before
Generate QRs.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser
from app.adapters.storage.factory import get_storage_adapter

router = APIRouter(prefix="/api/v1/goods-receipt-entries", tags=["goods-receipt"])

MODULE = "goods_receipt"


def require_fill_section(
    current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)
) -> models.ModulePermission:
    perm = deps.effective_permission(db, current_user.user_id, MODULE)
    if not perm.can_fill_section:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to fill this section.")
    return perm


def _get_entry_or_404(db: Session, entry_id: uuid.UUID) -> models.GoodsReceiptEntry:
    entry = db.query(models.GoodsReceiptEntry).filter(models.GoodsReceiptEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Container entry not found.")
    return entry


@router.post("/{entry_id}/coa")
async def upload_goods_receipt_coa(
    entry_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _perm=Depends(require_fill_section),
):
    entry = _get_entry_or_404(db, entry_id)
    content = await file.read()
    ext = (file.filename or "coa").rsplit(".", 1)[-1] if "." in (file.filename or "") else "pdf"
    storage_path = f"goods-receipt/{entry_id}/coa_{uuid.uuid4().hex[:8]}.{ext}"
    storage = get_storage_adapter()
    stored = storage.save(storage_path, content, file.content_type or "application/octet-stream")
    if entry.coa_storage_path:
        try:
            storage.delete(entry.coa_storage_path)
        except Exception:
            pass  # best-effort -- an orphaned old file is harmless
    entry.coa_storage_path = stored.storage_path
    entry.coa_filename = file.filename or "coa"
    db.commit()
    return {"coa_storage_path": entry.coa_storage_path, "coa_filename": entry.coa_filename, "coa_url": stored.public_url}


@router.delete("/{entry_id}/coa")
def delete_goods_receipt_coa(
    entry_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require_fill_section),
):
    entry = _get_entry_or_404(db, entry_id)
    if entry.coa_storage_path:
        try:
            get_storage_adapter().delete(entry.coa_storage_path)
        except Exception:
            pass
    entry.coa_storage_path = None
    entry.coa_filename = None
    db.commit()
    return None
