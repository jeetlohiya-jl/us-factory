"""
IPQC (In-Process Quality Control) -- the transactional half of the hybrid
split. Records are still primarily auto-created the moment a Material
Consumption record is finalized -- see
material_consumption_service.find_or_create_ipqc -- but as of migration
0029 a manual "+ New Record" path also exists (the POST route below,
backed by ipqc_service.create_ipqc), for starting a record before/without a
matching Material Consumption finalize. List/detail reads are
Supabase-direct (see frontend/src/lib/api.ts); this router handles the
manual create route plus the one atomic save: Shift Incharge plus the full
set of Check Time inspection blocks (each with its fixed 8-defect
Failure/Reason grid), matching the prototype's ipqcSaveDraft/ipqcSave
exactly.
"""
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.api import deps
from app.adapters.auth.base import AuthenticatedUser
from app.domain import ipqc_service
from app.domain import ipqc_attachments as att_svc
from app.adapters.storage.factory import get_storage_adapter
from app.core.product import FALCON, current_unit

router = APIRouter(prefix="/api/v1/ipqc-records", tags=["ipqc"])

MODULE = "ipqc"


def get_perms(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    # Admin gets full access to every module -- see deps.effective_permission.
    return deps.effective_permission(db, current_user.user_id, MODULE)


def require(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_perms)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def _serialize_save(rec: models.IpqcRecord) -> schemas.IpqcSaveOut:
    return schemas.IpqcSaveOut(
        id=rec.id, status=rec.status, shift_incharge=rec.shift_incharge,
        blocks=[
            schemas.IpqcCheckBlockOut(
                id=b.id, check_time=b.check_time, overall_result=b.overall_result, sort_order=b.sort_order,
                defects=[
                    schemas.IpqcBlockDefectOut(defect_sr=d.defect_sr, failure=d.failure, reason=d.reason)
                    for d in sorted(b.defects, key=lambda d: d.defect_sr)
                ],
            )
            for b in sorted(rec.check_blocks, key=lambda b: b.sort_order)
        ],
    )


@router.post("", response_model=schemas.IpqcCreateOut, status_code=status.HTTP_201_CREATED)
def create_ipqc_record(
    payload: schemas.IpqcCreateIn,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    _perm: models.ModulePermission = Depends(require("create")),
):
    """Manual "+ New Record" creation -- see ipqc_service.create_ipqc for the
    optional Shipment Number -> Production Run lookup. This is purely
    additive: the existing pending/production-linked auto-creation workflow
    (find_or_create_ipqc, fired from Material Consumption's finalize) is
    completely untouched and remains how the vast majority of IPQC records
    come into existence. Cancel on the frontend never calls this route at
    all (no draft is created just by opening the panel), so there is
    nothing to discard on Cancel here."""
    rec = ipqc_service.create_ipqc(db, payload.shipment_number, payload.manufacturer)
    db.commit()
    db.refresh(rec)
    return schemas.IpqcCreateOut(id=rec.id, shipment_number=rec.shipment_number, status=rec.status)


@router.put("/{record_id}", response_model=schemas.IpqcSaveOut)
def save_ipqc_record(
    record_id: uuid.UUID,
    payload: schemas.IpqcSaveIn,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
    # Same convention as Inward QC / Inward Vehicle Inspection: the
    # staff-facing "fill in this record" action is gated on
    # can_fill_section, not can_edit (see 0017's migration note).
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    """
    The single transactional write for IPQC: atomically saves Shift
    Incharge and the full set of Check Time blocks (each block's defect
    Failure/Reason grid), replacing the block list wholesale -- same
    semantics as Production's Wastage save, and for the same reason (a
    short repeatable list edited as a whole from one form).

    Status follows the prototype exactly, no invented model:
    - save_mode='draft' -> status='draft' unconditionally (Save Draft).
    - save_mode='final' -> 'hold' if any defect's Failure >= 1 anywhere
      across every block, else 'approved' (Save) -- ipqcOverallStatus().

    Everything else on the record (Shipment Number, Batch Code,
    Manufacturer, Pad Color, Weight, Dimensions, Absorption Rate, SKU/
    Version, the Production/Material Consumption link) is autopopulated at
    creation and read-only -- never touched here, lives entirely in
    Supabase-direct reads.
    """
    rec = (
        db.query(models.IpqcRecord)
        .options(joinedload(models.IpqcRecord.check_blocks).joinedload(models.IpqcCheckBlock.defects))
        .filter(models.IpqcRecord.id == record_id)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="IPQC record not found.")

    rec.shift_incharge = payload.shift_incharge

    # Replace every block (and its defects, via cascade) wholesale.
    for existing in list(rec.check_blocks):
        db.delete(existing)
    db.flush()

    has_failure = False
    for i, block in enumerate(payload.blocks):
        new_block = models.IpqcCheckBlock(
            ipqc_record_id=rec.id, check_time=block.check_time,
            overall_result=block.overall_result, sort_order=i,
        )
        db.add(new_block)
        db.flush()
        for d in block.defects:
            db.add(models.IpqcBlockDefect(
                block_id=new_block.id, defect_sr=d.defect_sr,
                failure=d.failure, reason=d.reason,
            ))
            if d.failure is not None and d.failure >= 1:
                has_failure = True

    rec.status = "draft" if payload.save_mode == "draft" else ("hold" if has_failure else "approved")

    # NOTE: RQC is NOT auto-created from here. RQC's creation trigger is
    # Material Consumption (see material_consumption_service.finalize,
    # which calls find_or_create_ipqc immediately followed by
    # find_or_create_rqc) -- RQC exists as Pending from the moment Material
    # Consumption is finalized, regardless of this IPQC record's status.
    # This route only ever affects an RQC record that already exists.

    db.commit()
    db.refresh(rec)
    return _serialize_save(rec)


# ---------------------------------------------------------------------------
# Attachments (images / PDF / DOCX) on an IPQC record -- Falcon only
# (migration 0090). Several files per record; stored with the existing
# storage adapter; permissions are the IPQC module's own (view to list,
# fill_section to add / remove).
# ---------------------------------------------------------------------------

def _falcon_only():
    if current_unit() != FALCON:
        raise HTTPException(status_code=404, detail="Not found.")


def _record_or_404(db: Session, record_id: uuid.UUID) -> models.IpqcRecord:
    rec = db.query(models.IpqcRecord).filter(models.IpqcRecord.id == record_id).first()
    if not rec:
        raise HTTPException(status_code=404, detail="IPQC record not found.")
    return rec


def _attachment_out(db: Session, a: models.IpqcAttachment) -> schemas.IpqcAttachmentOut:
    user = db.query(models.AppUser).filter(models.AppUser.id == a.uploaded_by).first() if a.uploaded_by else None
    return schemas.IpqcAttachmentOut(
        id=a.id, filename=a.filename, content_type=a.content_type, size_bytes=a.size_bytes,
        public_url=a.public_url, uploaded_by_name=user.full_name if user else None, created_at=a.created_at,
    )


@router.get("/{record_id}/attachments", response_model=list[schemas.IpqcAttachmentOut])
def list_ipqc_attachments(
    record_id: uuid.UUID, db: Session = Depends(get_db),
    _f=Depends(_falcon_only), _perm: models.ModulePermission = Depends(require("view")),
):
    _record_or_404(db, record_id)
    rows = db.query(models.IpqcAttachment).filter(models.IpqcAttachment.ipqc_record_id == record_id).order_by(models.IpqcAttachment.created_at).all()
    return [_attachment_out(db, a) for a in rows]


@router.post("/{record_id}/attachments", response_model=schemas.IpqcAttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload_ipqc_attachment(
    record_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _f=Depends(_falcon_only),
    _perm: models.ModulePermission = Depends(require("fill_section")),
):
    rec = _record_or_404(db, record_id)
    content = await file.read(att_svc.MAX_BYTES + 1)
    try:
        info = att_svc.validate_upload(file.filename, content)
    except att_svc.AttachmentError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    q = db.query(models.IpqcAttachment).filter(models.IpqcAttachment.ipqc_record_id == rec.id)
    if q.count() >= att_svc.MAX_FILES_PER_RECORD:
        raise HTTPException(status_code=422, detail=f"A record can have at most {att_svc.MAX_FILES_PER_RECORD} attachments.")
    dup = q.filter(models.IpqcAttachment.content_sha256 == info["sha256"]).first()
    if dup:
        raise HTTPException(status_code=409, detail=f"This file is already attached ({dup.filename}).")
    storage = get_storage_adapter()
    stored = storage.save(att_svc.storage_path_for("record", rec.id, info["filename"], info["ext"]), content, info["content_type"])
    row = models.IpqcAttachment(
        ipqc_record_id=rec.id, filename=info["filename"], content_type=info["content_type"], size_bytes=info["size_bytes"],
        content_sha256=info["sha256"], storage_path=stored.storage_path, public_url=stored.public_url,
        uploaded_by=uuid.UUID(current_user.user_id),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        try:
            storage.delete(stored.storage_path)
        except Exception:
            pass
        raise HTTPException(status_code=409, detail="This file is already attached.")
    db.refresh(row)
    return _attachment_out(db, row)


@router.delete("/{record_id}/attachments/{attachment_id}", status_code=204)
def delete_ipqc_attachment(
    record_id: uuid.UUID, attachment_id: uuid.UUID, db: Session = Depends(get_db),
    _f=Depends(_falcon_only), _perm: models.ModulePermission = Depends(require("fill_section")),
):
    _record_or_404(db, record_id)
    row = db.query(models.IpqcAttachment).filter(models.IpqcAttachment.id == attachment_id, models.IpqcAttachment.ipqc_record_id == record_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    path = row.storage_path
    db.delete(row)
    db.commit()
    try:
        get_storage_adapter().delete(path)
    except Exception:
        pass
    return None
