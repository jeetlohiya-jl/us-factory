import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, status
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import or_

from app.db.session import get_db
from app.db import models
from app.api import schemas
from app.api.deps import require_permission, get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.adapters.ocr.factory import get_ocr_adapter
from app.adapters.storage.factory import get_storage_adapter
from app.domain import vehicle_inspection_service as svc
from app.domain.vendor_lookup import resolve_vendor_id

router = APIRouter(prefix="/api/v1/inward-vehicle-inspections", tags=["inward-vehicle-inspection"])

OCR_FIELD_TYPES = {"container", "truck", "seal"}
ALL_IMAGE_TYPES = {"container", "truck", "seal", "condition", "damage", "empty_container"}
FIELD_BY_IMAGE_TYPE = {"container": "container_number", "truck": "truck_number", "seal": "seal_number"}


def _serialize_detail(db: Session, inspection: models.InwardVehicleInspection) -> dict:
    checklist_items = (
        db.query(models.ChecklistItem)
        .filter(models.ChecklistItem.is_active.is_(True))
        .order_by(models.ChecklistItem.sort_order)
        .all()
    )
    answers_by_item = {str(a.checklist_item_id): a.answer for a in inspection.checklist_answers}
    checklist_out = [
        schemas.ChecklistAnswerOut(checklist_item_id=ci.id, label=ci.label, answer=answers_by_item.get(str(ci.id)))
        for ci in checklist_items
    ]
    line_items_out = []
    for li in inspection.line_items:
        line_items_out.append(schemas.LineItemOut(
            id=li.id, sku_code_id=li.sku_code_id, sku_version_id=li.sku_version_id, quantity=li.quantity,
            sku_code=li.sku_code.code if li.sku_code else None,
            sku_version=li.sku_version.version if li.sku_version else None,
        ))
    linked_qc = svc.find_dependent_qc(db, inspection.id)
    return schemas.InspectionDetailOut(
        id=inspection.id,
        shipment_number=inspection.shipment_number,
        is_auto_shipment_number=inspection.is_auto_shipment_number,
        category=inspection.category,
        truck_number=inspection.truck_number,
        container_number=inspection.container_number,
        vendor_name=inspection.vendor_name,
        invoice_number=inspection.invoice_number,
        transporter_name=inspection.transporter_name,
        seal_number=inspection.seal_number,
        total_quantity=inspection.total_quantity,
        inspection_passed_quantity=inspection.inspection_passed_quantity,
        remarks=inspection.remarks,
        status=inspection.status,
        created_at=inspection.created_at.isoformat(),
        updated_at=inspection.updated_at.isoformat(),
        line_items=line_items_out,
        images=[schemas.ImageOut.model_validate(img) for img in inspection.images],
        checklist_answers=checklist_out,
        linked_qc_id=linked_qc.id if linked_qc else None,
        linked_qc_shipment_number=linked_qc.shipment_number if linked_qc else None,
    ).model_dump()


def _get_or_404(db: Session, inspection_id: uuid.UUID) -> models.InwardVehicleInspection:
    inspection = (
        db.query(models.InwardVehicleInspection)
        .options(
            joinedload(models.InwardVehicleInspection.line_items).joinedload(models.InwardVehicleInspectionLineItem.sku_code),
            joinedload(models.InwardVehicleInspection.line_items).joinedload(models.InwardVehicleInspectionLineItem.sku_version),
            joinedload(models.InwardVehicleInspection.images),
            joinedload(models.InwardVehicleInspection.checklist_answers),
        )
        .filter(models.InwardVehicleInspection.id == inspection_id)
        .first()
    )
    if not inspection:
        raise HTTPException(status_code=404, detail="Inward Vehicle Inspection record not found.")
    return inspection


@router.get("")
def list_inspections(
    search: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    category: str | None = Query(default=None),
    date: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("view")),
):
    q = db.query(models.InwardVehicleInspection)
    if search:
        like = f"%{search.lower()}%"
        q = q.filter(or_(
            models.InwardVehicleInspection.shipment_number.ilike(like),
            models.InwardVehicleInspection.invoice_number.ilike(like),
            models.InwardVehicleInspection.container_number.ilike(like),
            models.InwardVehicleInspection.truck_number.ilike(like),
        ))
    if status_filter:
        q = q.filter(models.InwardVehicleInspection.status == status_filter)
    if category:
        q = q.filter(models.InwardVehicleInspection.category == category)
    if date:
        from sqlalchemy import func, Date
        q = q.filter(func.cast(models.InwardVehicleInspection.created_at, Date) == date)

    total_all = db.query(models.InwardVehicleInspection).count()
    # No filter active => matched_count == total_count by construction;
    # skip the second COUNT query in that (common, default-load) case.
    matched = total_all if not (search or status_filter or category or date) else q.count()
    rows = (
        q.order_by(models.InwardVehicleInspection.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [
        schemas.InspectionListItemOut(
            id=r.id, shipment_number=r.shipment_number, invoice_number=r.invoice_number,
            container_number=r.container_number, status=r.status, category=r.category,
            created_at=r.created_at.isoformat(),
        )
        for r in rows
    ]
    return {"items": items, "matched_count": matched, "total_count": total_all}


@router.post("/draft", status_code=201)
def create_draft(
    category: str = Query(default="tray"),
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require_permission("create")),
):
    """Creates an empty draft immediately so images/OCR have a real record to
    attach to from the moment the wizard opens. Untouched drafts are cleaned
    up on Cancel via DELETE /{id}/if-blank."""
    shipment_number, is_auto = svc.next_shipment_number(db, category)
    inspection = models.InwardVehicleInspection(
        shipment_number=shipment_number,
        is_auto_shipment_number=is_auto,
        category=category,
        status="draft",
        created_by=current_user.user_id,
        updated_by=current_user.user_id,
    )
    db.add(inspection)
    db.commit()
    # _get_or_404 immediately below re-fetches this row fresh (with its
    # joinedload'd relationships, needed for _serialize_detail) -- an extra
    # db.refresh(inspection) here just costs a round trip for an object we
    # discard.
    return _serialize_detail(db, _get_or_404(db, inspection.id))


@router.get("/{inspection_id}")
def get_inspection(inspection_id: uuid.UUID, db: Session = Depends(get_db), _perm=Depends(require_permission("view"))):
    return _serialize_detail(db, _get_or_404(db, inspection_id))


@router.put("/{inspection_id}")
def update_inspection(
    inspection_id: uuid.UUID,
    payload: schemas.InspectionBasicUpdate,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require_permission("edit")),
):
    inspection = _get_or_404(db, inspection_id)
    data = payload.model_dump(exclude_unset=True)
    line_items = data.pop("line_items", None)

    if "category" in data and data["category"] != inspection.category:
        inspection.category = data["category"]
        shipment_number, is_auto = svc.next_shipment_number(db, inspection.category)
        if is_auto:
            inspection.shipment_number = shipment_number
            inspection.is_auto_shipment_number = True
        else:
            inspection.is_auto_shipment_number = False

    for field in ["shipment_number", "truck_number", "container_number", "vendor_name", "invoice_number",
                  "transporter_name", "seal_number", "remarks", "inspection_passed_quantity"]:
        if field in data:
            setattr(inspection, field, data[field])

    if "vendor_name" in data:
        inspection.vendor_id = resolve_vendor_id(db, inspection.category, inspection.vendor_name)

    if line_items is not None:
        inspection.line_items.clear()
        db.flush()
        for i, li in enumerate(line_items):
            inspection.line_items.append(models.InwardVehicleInspectionLineItem(
                sku_code_id=li.get("sku_code_id"), sku_version_id=li.get("sku_version_id"),
                quantity=li.get("quantity") or Decimal("0"), sort_order=i,
            ))
        svc.recompute_total_quantity(inspection)

    inspection.updated_by = current_user.user_id
    db.commit()
    return _serialize_detail(db, _get_or_404(db, inspection_id))


@router.put("/{inspection_id}/checklist")
def save_checklist(
    inspection_id: uuid.UUID,
    payload: schemas.ChecklistSubmitIn,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("fill_section")),
):
    inspection = _get_or_404(db, inspection_id)
    valid_ids = {str(i.id) for i in db.query(models.ChecklistItem).all()}
    for item_id_str, answer in payload.answers.items():
        if item_id_str not in valid_ids or answer not in ("ok", "not_ok"):
            continue
        item_id = uuid.UUID(item_id_str)
        existing = next((a for a in inspection.checklist_answers if str(a.checklist_item_id) == item_id_str), None)
        if existing:
            existing.answer = answer
        else:
            db.add(models.InwardVehicleInspectionChecklistAnswer(
                inspection_id=inspection.id, checklist_item_id=item_id, answer=answer
            ))
    db.commit()
    return _serialize_detail(db, _get_or_404(db, inspection_id))


@router.post("/{inspection_id}/submit")
def submit_inspection(
    inspection_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require_permission("approve")),
):
    inspection = _get_or_404(db, inspection_id)
    if not svc.checklist_is_complete(db, inspection):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="All checklist items must be answered OK or NOT OK before submitting. Use Save Draft to keep this Pending.",
        )
    new_status = svc.compute_status(db, inspection)
    if new_status == "approved":
        # Requirement: if anything is NOT OK, never ask for passed quantity;
        # only meaningful when the record is fully approved.
        pass
    else:
        inspection.inspection_passed_quantity = None
    inspection.status = new_status
    inspection.updated_by = current_user.user_id
    db.flush()
    svc.propagate_to_qc(db, inspection)
    db.commit()
    return _serialize_detail(db, _get_or_404(db, inspection_id))


@router.post("/{inspection_id}/save-draft")
def save_draft(
    inspection_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: AuthenticatedUser = Depends(get_current_user),
    _perm=Depends(require_permission("fill_section")),
):
    """Explicit Save Draft: persists whatever is already there without
    requiring the checklist to be complete. Status stays/moves to 'draft'
    unless already approved/hold (editing an approved record via Edit and
    hitting Save Draft should not silently downgrade its status)."""
    inspection = _get_or_404(db, inspection_id)
    if inspection.status not in ("approved", "hold"):
        inspection.status = "draft"
    inspection.updated_by = current_user.user_id
    db.commit()
    return _serialize_detail(db, _get_or_404(db, inspection_id))


@router.delete("/{inspection_id}/if-blank", status_code=204)
def discard_if_blank(inspection_id: uuid.UUID, db: Session = Depends(get_db)):
    """Called when the user hits Cancel on a brand-new record: silently
    removes the auto-created draft if nothing was ever entered, so the
    landing page isn't littered with empty rows."""
    inspection = db.query(models.InwardVehicleInspection).filter(models.InwardVehicleInspection.id == inspection_id).first()
    if inspection and svc.is_inspection_blank(inspection):
        db.delete(inspection)
        db.commit()
    return None


@router.delete("/{inspection_id}")
def delete_inspection(
    inspection_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("delete")),
):
    inspection = _get_or_404(db, inspection_id)
    dependent = svc.find_dependent_qc(db, inspection_id)
    if dependent:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This Inward Vehicle Inspection record has a linked Inward QC record ({dependent.shipment_number}) and cannot be deleted.",
        )
    storage = get_storage_adapter()
    for img in inspection.images:
        try:
            storage.delete(img.storage_path)
        except Exception:
            pass
    db.delete(inspection)
    db.commit()
    return {"deleted": True}


@router.post("/{inspection_id}/images")
async def upload_image(
    inspection_id: uuid.UUID,
    image_type: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("fill_section")),
):
    if image_type not in ALL_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unknown image_type '{image_type}'.")
    inspection = _get_or_404(db, inspection_id)
    content = await file.read()
    ext = (file.filename or "upload").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "jpg"
    sort_order = max([i.sort_order for i in inspection.images if i.image_type == image_type], default=-1) + 1
    storage_path = f"{inspection_id}/{image_type}_{sort_order}_{uuid.uuid4().hex[:8]}.{ext}"

    storage = get_storage_adapter()
    stored = storage.save(storage_path, content, file.content_type or "application/octet-stream")

    ocr_value, ocr_conf, ocr_status = None, None, None
    if image_type in OCR_FIELD_TYPES:
        ocr = get_ocr_adapter().extract_identifier(content, image_type)
        ocr_value, ocr_conf, ocr_status = ocr.extracted_value, ocr.confidence, ocr.status
        if ocr.extracted_value and ocr.status in ("success", "low_confidence"):
            setattr(inspection, FIELD_BY_IMAGE_TYPE[image_type], ocr.extracted_value)

    image_row = models.InwardVehicleInspectionImage(
        inspection_id=inspection_id, image_type=image_type, storage_path=stored.storage_path,
        public_url=stored.public_url, ocr_extracted_value=ocr_value, ocr_confidence=ocr_conf,
        ocr_status=ocr_status, sort_order=sort_order,
    )
    db.add(image_row)
    db.commit()
    return _serialize_detail(db, _get_or_404(db, inspection_id))


@router.put("/{inspection_id}/images/{image_id}")
async def replace_image(
    inspection_id: uuid.UUID,
    image_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("fill_section")),
):
    inspection = _get_or_404(db, inspection_id)
    image_row = next((i for i in inspection.images if i.id == image_id), None)
    if not image_row:
        raise HTTPException(status_code=404, detail="Image not found.")
    content = await file.read()
    storage = get_storage_adapter()
    stored = storage.save(image_row.storage_path, content, file.content_type or "application/octet-stream")
    image_row.public_url = stored.public_url

    if image_row.image_type in OCR_FIELD_TYPES:
        ocr = get_ocr_adapter().extract_identifier(content, image_row.image_type)
        image_row.ocr_extracted_value = ocr.extracted_value
        image_row.ocr_confidence = ocr.confidence
        image_row.ocr_status = ocr.status
        if ocr.extracted_value and ocr.status in ("success", "low_confidence"):
            setattr(inspection, FIELD_BY_IMAGE_TYPE[image_row.image_type], ocr.extracted_value)

    db.commit()
    return _serialize_detail(db, _get_or_404(db, inspection_id))


@router.delete("/{inspection_id}/images/{image_id}")
def delete_image(
    inspection_id: uuid.UUID,
    image_id: uuid.UUID,
    db: Session = Depends(get_db),
    _perm=Depends(require_permission("fill_section")),
):
    inspection = _get_or_404(db, inspection_id)
    image_row = next((i for i in inspection.images if i.id == image_id), None)
    if not image_row:
        raise HTTPException(status_code=404, detail="Image not found.")
    storage = get_storage_adapter()
    try:
        storage.delete(image_row.storage_path)
    except Exception:
        pass
    db.delete(image_row)
    db.commit()
    return _serialize_detail(db, _get_or_404(db, inspection_id))
