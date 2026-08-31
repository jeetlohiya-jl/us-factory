"""Shared serialization for pallets / QR-generation records / storage
records, reused by the RM and FG variants of each router so the JSON shape
returned to the frontend never drifts between the two."""
from app.db import models
from app.api import schemas


def serialize_pallet(pallet: models.Pallet) -> schemas.PalletOut:
    return schemas.PalletOut(
        id=pallet.id,
        display_id=pallet.display_id,
        pallet_type=pallet.pallet_type,
        category=pallet.category,
        sku_code=pallet.sku_code_snapshot,
        sku_version=pallet.sku_version_snapshot,
        shipment_number=pallet.shipment_number,
        lifecycle_status=pallet.lifecycle_status,
        qr_url=pallet.qr_public_url,
        location_display_id=pallet.current_location.display_id if pallet.current_location else None,
        storage_id=pallet.storage_record.id if pallet.storage_record else None,
    )


def serialize_qr_list_item(rec: models.QrGenerationRecord) -> schemas.QrGenerationListItemOut:
    return schemas.QrGenerationListItemOut(
        id=rec.id, batch_display_id=rec.batch_display_id, qr_type=rec.qr_type,
        shipment_number=rec.shipment_number, sku_code_snapshot=rec.sku_code_snapshot,
        sku_version_snapshot=rec.sku_version_snapshot, quantity=rec.quantity, status=rec.status,
        created_at=rec.created_at.isoformat(),
    )


def serialize_qr_detail(rec: models.QrGenerationRecord) -> schemas.QrGenerationDetailOut:
    source_display_id = None
    if rec.source_inward_qc:
        source_display_id = rec.source_inward_qc.shipment_number
    elif rec.source_production_run:
        source_display_id = rec.source_production_run.run_number
    return schemas.QrGenerationDetailOut(
        id=rec.id, batch_display_id=rec.batch_display_id, qr_type=rec.qr_type, category=rec.category,
        shipment_number=rec.shipment_number, sku_code_snapshot=rec.sku_code_snapshot,
        sku_version_snapshot=rec.sku_version_snapshot, quantity=rec.quantity, status=rec.status,
        created_at=rec.created_at.isoformat(),
        generated_at=rec.generated_at.isoformat() if rec.generated_at else None,
        source_locked=bool(rec.source_inward_qc_id or rec.source_production_run_id),
        source_inward_qc_id=rec.source_inward_qc_id, source_production_run_id=rec.source_production_run_id,
        source_display_id=source_display_id,
        pallets=[serialize_pallet(p) for p in rec.pallets],
    )


def serialize_storage_record(rec: models.StorageRecord) -> schemas.StorageRecordOut:
    return schemas.StorageRecordOut(
        id=rec.id, storage_type=rec.storage_type, pallet_display_id=rec.pallet.display_id,
        sku_code=rec.pallet.sku_code_snapshot, sku_version=rec.pallet.sku_version_snapshot,
        shipment_number=rec.pallet.shipment_number, location_display_id=rec.location.display_id,
        source_batch_display_id=rec.source_qr_generation.batch_display_id,
        source_inward_qc_id=rec.source_inward_qc_id, source_production_run_id=rec.source_production_run_id,
        stored_by_name=rec.stored_by_user.full_name if rec.stored_by_user else None,
        stored_at=rec.stored_at.isoformat(), pallet_status=rec.pallet.lifecycle_status,
    )
