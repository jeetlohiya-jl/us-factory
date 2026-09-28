"""
Inventory (2026-09-28) -- SKU-centric raw-material stock.

SKU-centric, not vendor-centric: the same SKU received from multiple
suppliers still shows as ONE inventory item with quantity clubbed
together (models.InventoryItem, one row per SKU per product). The
underlying per-source rows (models.InventorySource) keep the
supplier/PO/inward information -- and, at that level, the country code
QR generation needs -- without ever creating a second inventory record
just because the vendor differs.

Kept in sync automatically on the write side that matters: a Goods
Receipt container inward calls inventory_apply_receipt() (migration
0059) directly in SQL, since Goods Receipt is itself a pure Postgres-RPC
flow (see goods_receipt_inward / goods_receipt_inward_remaining) with no
FastAPI leg to hook into. This module only reads that result (list/
detail) plus handles the two things that DO make sense as ordinary
FastAPI writes: manually adding a new inventory item / a manual source
line (a delivery with no PO behind it yet, or a correction), and editing
an item's own reference fields (UOM, compatible tray SKU(s) --
migration 0061, a material can pair with more than one tray).

Performance: the dashboard is one aggregating query (SUM per SKU) with
no N+1 joins to every PO/vendor/inward row -- those only get fetched in
get_inventory_detail(), once an item is actually opened.
"""
import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.core.product import current_unit
from app.db import models


def _country_from_vendor(db: Session, vendor_id) -> str | None:
    if not vendor_id:
        return None
    vendor = db.query(models.Vendor).filter(models.Vendor.id == vendor_id).first()
    if not vendor:
        return None
    country = (vendor.country or "").strip().upper()
    return country or None


def list_inventory(db: Session, search: str = "", page: int = 1, page_size: int = 50):
    unit = current_unit()
    qty = func.coalesce(func.sum(models.InventorySource.quantity), 0)

    base = (
        db.query(models.InventoryItem.id)
        .join(models.SkuCode, models.SkuCode.id == models.InventoryItem.sku_code_id)
        .filter(models.InventoryItem.product == unit)
    )
    if search:
        like = f"%{search.strip().lower()}%"
        base = base.filter(
            func.lower(models.SkuCode.code).like(like)
            | func.lower(func.coalesce(models.SkuCode.sku_code, "")).like(like)
        )
    matched_count = base.distinct().count()

    q = (
        db.query(
            models.InventoryItem.id,
            models.SkuCode.code,
            models.SkuCode.sku_code,
            models.InventoryItem.uom,
            qty.label("quantity"),
        )
        .join(models.SkuCode, models.SkuCode.id == models.InventoryItem.sku_code_id)
        .outerjoin(models.InventorySource, models.InventorySource.inventory_item_id == models.InventoryItem.id)
        .filter(models.InventoryItem.product == unit)
    )
    if search:
        like = f"%{search.strip().lower()}%"
        q = q.filter(
            func.lower(models.SkuCode.code).like(like)
            | func.lower(func.coalesce(models.SkuCode.sku_code, "")).like(like)
        )
    q = q.group_by(models.InventoryItem.id, models.SkuCode.code, models.SkuCode.sku_code, models.InventoryItem.uom)
    rows = q.order_by(models.SkuCode.code).offset((page - 1) * page_size).limit(page_size).all()

    items = [
        {"id": r.id, "sku": r.code, "sku_code": r.sku_code, "uom": r.uom, "quantity": float(r.quantity)}
        for r in rows
    ]
    return items, matched_count


def get_inventory_detail(db: Session, item_id: uuid.UUID):
    unit = current_unit()
    item = (
        db.query(models.InventoryItem)
        .options(
            joinedload(models.InventoryItem.sku_code),
            joinedload(models.InventoryItem.compatible_trays).joinedload(models.InventoryCompatibleTray.tray_sku_code),
        )
        .filter(models.InventoryItem.id == item_id, models.InventoryItem.product == unit)
        .first()
    )
    if not item:
        return None

    sources = (
        db.query(models.InventorySource)
        .options(
            joinedload(models.InventorySource.vendor),
            joinedload(models.InventorySource.source_goods_receipt_entry).joinedload(models.GoodsReceiptEntry.goods_receipt),
        )
        .filter(models.InventorySource.inventory_item_id == item_id)
        .order_by(models.InventorySource.created_at.desc())
        .all()
    )
    quantity = sum(float(s.quantity or 0) for s in sources)

    source_rows = []
    for s in sources:
        gr_entry = s.source_goods_receipt_entry
        gr = gr_entry.goods_receipt if gr_entry else None
        source_rows.append({
            "id": s.id,
            "vendor_name": s.vendor.name if s.vendor else s.vendor_name,
            "supplier_country": s.country_code,
            "quantity": float(s.quantity or 0),
            "unit": s.unit,
            "is_manual": s.is_manual,
            "note": s.note,
            "po_number": gr.po_number if gr else None,
            "shipment_number": gr_entry.shipment_number if gr_entry else None,
            "goods_receipt_id": gr.id if gr else None,
            "created_at": s.created_at.isoformat() if s.created_at else "",
        })

    return {
        "id": item.id,
        "sku_code_id": item.sku_code_id,
        "sku": item.sku_code.code if item.sku_code else "",
        "sku_code": item.sku_code.sku_code if item.sku_code else None,
        "category": item.sku_code.category if item.sku_code else "",
        "uom": item.uom,
        "quantity": quantity,
        "compatible_trays": [
            {"id": ct.tray_sku_code_id, "code": ct.tray_sku_code.code}
            for ct in item.compatible_trays if ct.tray_sku_code
        ],
        "sources": source_rows,
    }


class InventoryValidationError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def create_inventory_item(db: Session, payload) -> models.InventoryItem:
    unit = current_unit()
    sku = db.query(models.SkuCode).filter(models.SkuCode.id == payload.sku_code_id).first()
    if not sku:
        raise InventoryValidationError("SKU not found.")
    existing = (
        db.query(models.InventoryItem)
        .filter(models.InventoryItem.product == unit, models.InventoryItem.sku_code_id == payload.sku_code_id)
        .first()
    )
    if existing:
        raise InventoryValidationError(f'"{sku.code}" is already an Inventory item -- open it to add a source instead.')

    item = models.InventoryItem(
        sku_code_id=payload.sku_code_id,
        uom=(payload.uom or "Kgs").strip() or "Kgs",
    )
    db.add(item)
    db.flush()

    for tray_sku_code_id in payload.compatible_tray_sku_code_ids or []:
        db.add(models.InventoryCompatibleTray(inventory_item_id=item.id, tray_sku_code_id=tray_sku_code_id))

    if payload.initial_quantity:
        if payload.initial_quantity <= 0:
            raise InventoryValidationError("Initial quantity must be greater than 0.")
        country = (payload.supplier_country or "").strip().upper() or _country_from_vendor(db, payload.vendor_id)
        vendor_name = None
        if payload.vendor_id:
            vendor = db.query(models.Vendor).filter(models.Vendor.id == payload.vendor_id).first()
            vendor_name = vendor.name if vendor else None
        db.add(models.InventorySource(
            inventory_item_id=item.id,
            vendor_id=payload.vendor_id,
            vendor_name=vendor_name,
            country_code=country,
            quantity=payload.initial_quantity,
            unit=item.uom,
            is_manual=True,
            note=payload.note,
        ))
    db.commit()
    db.refresh(item)
    return item


def update_inventory_item(db: Session, item_id: uuid.UUID, payload) -> models.InventoryItem:
    unit = current_unit()
    item = (
        db.query(models.InventoryItem)
        .filter(models.InventoryItem.id == item_id, models.InventoryItem.product == unit)
        .first()
    )
    if not item:
        raise InventoryValidationError("Inventory item not found.")
    if payload.uom is not None:
        uom = payload.uom.strip()
        if not uom:
            raise InventoryValidationError("UOM is required.")
        item.uom = uom
    if payload.compatible_tray_sku_code_ids is not None:
        db.query(models.InventoryCompatibleTray).filter(
            models.InventoryCompatibleTray.inventory_item_id == item.id
        ).delete()
        db.flush()
        for tray_sku_code_id in payload.compatible_tray_sku_code_ids:
            db.add(models.InventoryCompatibleTray(inventory_item_id=item.id, tray_sku_code_id=tray_sku_code_id))
    db.commit()
    db.refresh(item)
    return item


def add_manual_source(db: Session, item_id: uuid.UUID, payload) -> models.InventorySource:
    unit = current_unit()
    item = (
        db.query(models.InventoryItem)
        .filter(models.InventoryItem.id == item_id, models.InventoryItem.product == unit)
        .first()
    )
    if not item:
        raise InventoryValidationError("Inventory item not found.")
    if payload.quantity is None or payload.quantity <= 0:
        raise InventoryValidationError("Quantity must be greater than 0.")

    country = (payload.supplier_country or "").strip().upper() or _country_from_vendor(db, payload.vendor_id)
    vendor_name = None
    if payload.vendor_id:
        vendor = db.query(models.Vendor).filter(models.Vendor.id == payload.vendor_id).first()
        vendor_name = vendor.name if vendor else None

    source = models.InventorySource(
        inventory_item_id=item.id,
        vendor_id=payload.vendor_id,
        vendor_name=vendor_name,
        country_code=country,
        quantity=payload.quantity,
        unit=(payload.unit or item.uom),
        is_manual=True,
        note=payload.note,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return source
