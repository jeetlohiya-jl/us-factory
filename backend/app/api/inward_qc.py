import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, status
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import or_

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.adapters.storage.factory import get_storage_adapter
from app.domain import inward_qc_service as svc
from app.api.inward_vehicle_inspections import _serialize_detail as _serialize_vehicle_inspection, _get_or_404 as _get_vehicle_inspection_or_404

router = APIRouter(prefix="/api/v1/inward-qc", tags=["inward-qc"])

MODULE = "inward_qc"


def get_qc_permissions(current_user: AuthenticatedUser = Depends(get_current_user), db: Session = Depends(get_db)) -> models.ModulePermission:
    perm = (
        db.query(models.ModulePermission)
        .filter(models.ModulePermission.user_id == current_user.user_id, models.ModulePermission.module == MODULE)
        .first()
    )
    if not perm:
        perm = models.ModulePermission(user_id=current_user.user_id, module=MODULE, can_view=True)
    return perm


def require_qc_permission(action: str):
    def _dep(perm: models.ModulePermission = Depends(get_qc_permissions)):
        if not getattr(perm, f"can_{action}", False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"You do not have permission to {action} this record.")
        return perm
    return _dep


def _get_or_404(db: Session, qc_id: uuid.UUID) -> models.InwardQcRecord:
    qc = (
        db.query(models.InwardQcRecord)
        .options(
            joinedload(models.InwardQcRecord.fgtray_answers).joinedload(models.InwardQcFgtrayCriteriaAnswer.criteria),
            joinedload(models.InwardQcRecord.attribute_values).joinedload(models.InwardQcAttributeValue.attribute_definition),
            joinedload(models.InwardQcRecord.line_item_snapshots),
            joinedload(models.InwardQcRecord.sku_code),
            joinedload(models.InwardQcRecord.sku_version),
            joinedload(models.InwardQcRecord.vehicle_inspection),
        )
        .filter(models.InwardQcRecord.id == qc_id)
        .first()
    )
    if not qc:
        raise HTTPException(status_code=404, detail="Inward QC record not found.")
    return qc


def _serialize_detail(db: Session, qc: models.InwardQcRecord) -> dict:
    # public_url isn't stored for COA (single file, not an image gallery row) —
    # local adapter serves everything under /media/<path>, mirroring images.
    # (Swap this for the storage adapter's own public URL once Supabase Storage is live.)
    coa_url = f"/media/{qc.coa_storage_path}" if qc.coa_storage_path else None

    created_by_name = qc.created_by and db.query(models.AppUser).filter(models.AppUser.id == qc.created_by).first()

    fgtray_criteria = svc.get_fgtray_criteria(db)
    answers_by_id = {a.criteria_id: a for a in qc.fgtray_answers}
    fgtray_answers_out = [
        schemas.QcFgtrayAnswerOut(
            criteria_id=c.id, label=c.label,
            answer=(answers_by_id.get(c.id).answer if c.id in answers_by_id else None),
            remarks=(answers_by_id.get(c.id).remarks if c.id in answers_by_id else None),
        )
        for c in fgtray_criteria
    ] if qc.category == "fgtray" else []

    attr_defs = svc.get_attribute_definitions(db, qc.category) if qc.category != "fgtray" else []
    values_by_id = {v.attribute_definition_id: v.value for v in qc.attribute_values}
    attribute_values_out = [
        schemas.QcAttributeValueOut(
            attribute_definition_id=d.id, label=d.label, field_type=d.field_type,
            options_json=d.options_json, is_required=d.is_required, value=values_by_id.get(d.id),
        )
        for d in attr_defs
    ]

    line_items_out = [
        schemas.QcLineItemSnapshotOut(
            sku_code=li.sku_code_snapshot or (li.sku_code.code if li.sku_code else None),
            sku_version=li.sku_version_snapshot or (li.sku_version.version if li.sku_version else None),
            quantity=li.quantity,
        )
        for li in qc.line_item_snapshots
    ]

    vehicle_inspection_dict = None
    if qc.category == "fgtray" and qc.linked_vehicle_inspection_id:
        vi = _get_vehicle_inspection_or_404(db, qc.linked_vehicle_inspection_id)
        vehicle_inspection_dict = _serialize_vehicle_inspection(db, vi)

    return schemas.QcDetailOut(
        id=qc.id, shipment_number=qc.shipment_number, is_auto_shipment_number=qc.is_auto_shipment_number,
        category=qc.category, status=qc.status, vendor_name=qc.vendor_name, quantity=qc.quantity,
        quantity_label=qc.quantity_label, sku_code_id=qc.sku_code_id, sku_version_id=qc.sku_version_id,
        sku_code=qc.sku_code.code if qc.sku_code else None, sku_version=qc.sku_version.version if qc.sku_version else None,
        coa_filename=qc.coa_filename, coa_url=coa_url, conclusion_or_suggestions=qc.conclusion_or_suggestions,
        sampling_sample_size=qc.sampling_sample_size, sampling_upper_limit=qc.sampling_upper_limit, sampling_note=qc.sampling_note,
        created_at=qc.created_at.isoformat(), updated_at=qc.updated_at.isoformat(),
        submitted_at=qc.submitted_at.isoformat() if qc.submitted_at else None,
        created_by_name=created_by_name.full_name if created_by_name else None,
        linked_vehicle_inspection_id=qc.linked_vehicle_inspection_id,
        line_item_snapshots=line_items_out, fgtray_answers=fgtray_answers_out, attribute_values=attribute_values_out,
        vehicle_inspection=vehicle_inspection_dict,
    ).model_dump()


@router.get("/meta", response_model=schemas.QcMetaOut)
def get_meta(db: Session = Depends(get_db), _perm=Depends(require_qc_permission("view"))):
    """Everything the frontend needs to render category-specific forms
    without hardcoding the prototype's business data client-side."""
    attribute_definitions: dict[str, list] = {}
    for cat in svc.MANUAL_CATEGORIES:
        attribute_definitions[cat] = svc.get_attribute_definitions(db, cat)
    tiers = db.query(models.InwardQcSamplingPlanTier).order_by(models.InwardQcSamplingPlanTier.category, models.InwardQcSamplingPlanTier.sort_order).all()
    criteria = svc.get_fgtray_criteria(db)
    quantity_labels = {cat: svc.quantity_label_for(db, cat) for cat in svc.ALL_CATEGORIES}
    return schemas.QcMetaOut(
        manual_categories=sorted(svc.MANUAL_CATEGORIES),
        attribute_definitions=attribute_definitions,
        fgtray_criteria=criteria,
        sampling_plan_tiers=tiers,
        quantity_labels=quantity_labels,
        conclusion_labels=svc.CONCLUSION_LABEL,
        count_labels=svc.QC_COUNT_LABEL,
    )


@router.get("")
def list_qc(
    search: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    category: str | None = Query(default=None),
    date: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _perm=Depends(require_qc_permission("view")),
):
    q = db.query(models.InwardQcRecord)
    if search:
        like = f"%{search.lower()}%"
        q = q.filter(or_(models.InwardQcRecord.shipment_number.ilike(like)))
    if status_filter:
        q = q.filter(models.InwardQcRecord.status == status_filter)
    if category:
        q = q.filter(models.InwardQcRecord.category == category)
    if date:
        from sqlalchemy import func, Date
        q = q.filter(func.cast(models.InwardQcRecord.created_at, Date) == date)

    total_all = db.query(models.InwardQcRecord).count()
    matched = q.count()
    rows = q.order_by(models.InwardQcRecord.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    items = [
        schemas.QcListItemOut(
            id=r.id, shipment_number=r.shipment_number, category=r.category,
            coa_filename=r.coa_filename, status=r.status, created_at=r.created_at.isoformat(),
        )
        for r in rows
    ]
    return {"items": items, "matched_count": matched, "total_count": total_all}


@router.post("/draft", status_code=201)
def create_manual_draft(
    category: str = Query(...),
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require_qc_permission("create")),
):
    """Tray/FG Non-Padded Tray QC is NEVER manually created — it is
    auto-created only from an approved Vehicle Inspection (see
    vehicle_inspection_service.propagate_to_qc). '+ New Record' on this
    module only ever offers the four manual categories."""
    if category not in svc.MANUAL_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail="Tray / FG Non-Padded Tray QC cannot be created manually — it is generated automatically when its Inward Vehicle Inspection is approved.",
        )
    shipment_number, is_auto = svc.next_shipment_number(db, category)
    qty_label = svc.quantity_label_for(db, category)
    qc = models.InwardQcRecord(
        shipment_number=shipment_number, is_auto_shipment_number=is_auto, category=category,
        status="draft", quantity_label=qty_label, created_by=current_user.user_id, updated_by=current_user.user_id,
    )
    db.add(qc)
    db.commit()
    db.refresh(qc)
    return _serialize_detail(db, _get_or_404(db, qc.id))


@router.get("/{qc_id}")
def get_qc(qc_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require_qc_permission("view"))):
    return _serialize_detail(db, _get_or_404(db, qc_id))


@router.put("/{qc_id}")
def update_qc_basic(
    qc_id: uuid.UUID,
    payload: schemas.QcBasicUpdate,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require_qc_permission("fill_section")),
):
    qc = _get_or_404(db, qc_id)
    if qc.category == "fgtray":
        raise HTTPException(status_code=400, detail="Tray QC's basic information comes from its linked Vehicle Inspection and cannot be edited here.")
    data = payload.model_dump(exclude_unset=True)
    for field in ["vendor_name", "quantity", "sku_code_id", "sku_version_id"]:
        if field in data:
            setattr(qc, field, data[field])
    qc.updated_by = current_user.user_id
    db.commit()
    return _serialize_detail(db, _get_or_404(db, qc_id))


@router.post("/{qc_id}/coa")
async def upload_coa(
    qc_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _perm=Depends(require_qc_permission("fill_section")),
):
    qc = _get_or_404(db, qc_id)
    if qc.category == "fgtray":
        raise HTTPException(status_code=400, detail="COA is not applicable to Tray / FG Non-Padded Tray QC.")
    content = await file.read()
    ext = (file.filename or "coa").rsplit(".", 1)[-1] if "." in (file.filename or "") else "pdf"
    storage_path = f"qc/{qc_id}/coa_{uuid.uuid4().hex[:8]}.{ext}"
    storage = get_storage_adapter()
    storage.save(storage_path, content, file.content_type or "application/octet-stream")
    if qc.coa_storage_path:
        try:
            storage.delete(qc.coa_storage_path)
        except Exception:
            pass
    qc.coa_storage_path = storage_path
    qc.coa_filename = file.filename or "coa"
    db.commit()
    return _serialize_detail(db, _get_or_404(db, qc_id))


@router.delete("/{qc_id}/coa")
def delete_coa(qc_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require_qc_permission("fill_section"))):
    qc = _get_or_404(db, qc_id)
    if qc.coa_storage_path:
        try:
            get_storage_adapter().delete(qc.coa_storage_path)
        except Exception:
            pass
    qc.coa_storage_path = None
    qc.coa_filename = None
    db.commit()
    return _serialize_detail(db, _get_or_404(db, qc_id))


@router.put("/{qc_id}/fgtray-answers")
def save_fgtray_answers(
    qc_id: uuid.UUID,
    payload: list[schemas.QcFgtrayAnswerIn],
    db: Session = Depends(get_db),
    _perm=Depends(require_qc_permission("fill_section")),
):
    qc = _get_or_404(db, qc_id)
    if qc.category != "fgtray":
        raise HTTPException(status_code=400, detail="Only applicable to Tray / FG Non-Padded Tray QC.")
    valid_ids = {c.id for c in svc.get_fgtray_criteria(db)}
    for item in payload:
        if item.criteria_id not in valid_ids:
            continue
        existing = next((a for a in qc.fgtray_answers if a.criteria_id == item.criteria_id), None)
        if existing:
            existing.answer = item.answer
            existing.remarks = item.remarks
        else:
            db.add(models.InwardQcFgtrayCriteriaAnswer(
                inward_qc_id=qc.id, criteria_id=item.criteria_id, answer=item.answer, remarks=item.remarks,
            ))
    db.commit()
    return _serialize_detail(db, _get_or_404(db, qc_id))


@router.put("/{qc_id}/attributes")
def save_attributes(
    qc_id: uuid.UUID,
    payload: list[schemas.QcAttributeValueIn],
    conclusion_or_suggestions: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _perm=Depends(require_qc_permission("fill_section")),
):
    qc = _get_or_404(db, qc_id)
    if qc.category == "fgtray":
        raise HTTPException(status_code=400, detail="Not applicable to Tray / FG Non-Padded Tray QC.")
    valid_ids = {d.id for d in svc.get_attribute_definitions(db, qc.category)}
    for item in payload:
        if item.attribute_definition_id not in valid_ids:
            continue
        existing = next((v for v in qc.attribute_values if v.attribute_definition_id == item.attribute_definition_id), None)
        if existing:
            existing.value = item.value
        else:
            db.add(models.InwardQcAttributeValue(
                inward_qc_id=qc.id, attribute_definition_id=item.attribute_definition_id, value=item.value,
            ))
    if conclusion_or_suggestions is not None:
        qc.conclusion_or_suggestions = conclusion_or_suggestions
    db.commit()
    return _serialize_detail(db, _get_or_404(db, qc_id))


@router.post("/{qc_id}/save-draft")
def save_draft(
    qc_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require_qc_permission("fill_section")),
):
    """Mirrors qcSaveDraft(): persists whatever is there without requiring
    completion. Only meaningful for manually-created records — an
    auto-created Tray QC is never a 'draft', it stays Pending until its own
    completion logic promotes it (see submit_qc)."""
    qc = _get_or_404(db, qc_id)
    if qc.category != "fgtray" and qc.status not in ("accepted", "onhold"):
        qc.status = "draft"
    qc.updated_by = current_user.user_id
    db.commit()
    return _serialize_detail(db, _get_or_404(db, qc_id))


@router.post("/{qc_id}/submit")
def submit_qc(
    qc_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require_qc_permission("approve")),
):
    qc = _get_or_404(db, qc_id)
    new_status = svc.compute_status(db, qc)
    if new_status == "pending":
        if qc.category == "fgtray":
            detail = "Mark OK / NOT OK for every criterion to complete this inspection. Until then it stays Pending."
        else:
            detail = "Fill in every required field (marked *) and the conclusion to complete this inspection. Until then it stays Pending."
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)

    plan = svc.compute_sampling_plan(db, qc.category, float(qc.quantity) if qc.quantity else None)
    if plan:
        qc.sampling_sample_size = str(plan.get("sample_size"))
        qc.sampling_upper_limit = plan.get("upper_limit")
        qc.sampling_note = plan.get("note")

    qc.status = new_status
    qc.updated_by = current_user.user_id
    from datetime import datetime, timezone
    qc.submitted_at = datetime.now(timezone.utc)
    if new_status == "accepted":
        # An accepted Inward QC feeds RM QR Generation exactly the way an
        # approved Vehicle Inspection feeds Tray QC — auto-created, never
        # duplicated (find-or-create backed by a DB unique constraint).
        from app.domain import qr_generation_service
        qr_generation_service.get_or_create_rm_qr_for_qc(db, qc)
    db.commit()
    return _serialize_detail(db, _get_or_404(db, qc_id))


@router.delete("/{qc_id}/if-blank", status_code=204)
def discard_if_blank(qc_id: uuid.UUID, db: Session = Depends(get_db)):
    """Cleans up an untouched manually-created draft on Cancel. Never applies
    to an auto-created Tray QC (linked_vehicle_inspection_id is set) — those
    must stay in the list as Pending even if untouched."""
    qc = db.query(models.InwardQcRecord).filter(models.InwardQcRecord.id == qc_id).first()
    if qc and qc.linked_vehicle_inspection_id is None and svc.is_qc_blank(qc):
        db.delete(qc)
        db.commit()
    return None


@router.delete("/{qc_id}")
def delete_qc(qc_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require_qc_permission("delete"))):
    qc = _get_or_404(db, qc_id)
    if qc.coa_storage_path:
        try:
            get_storage_adapter().delete(qc.coa_storage_path)
        except Exception:
            pass
    db.delete(qc)
    db.commit()
    return {"deleted": True}
