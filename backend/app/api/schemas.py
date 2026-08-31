import uuid
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict


class SkuVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    version: str
    is_active: bool = True


class SkuCodeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    code: str
    category: str
    is_active: bool = True
    versions: list[SkuVersionOut] = []


class SkuCodeIn(BaseModel):
    category: str
    code: str


class SkuCodeUpdateIn(BaseModel):
    code: Optional[str] = None
    is_active: Optional[bool] = None


class SkuVersionIn(BaseModel):
    version: str


class SkuVersionUpdateIn(BaseModel):
    version: Optional[str] = None
    is_active: Optional[bool] = None


class VendorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    category: str
    name: str
    is_active: bool


class VendorIn(BaseModel):
    category: str
    name: str


class VendorUpdateIn(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None


class ChecklistItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    label: str
    sort_order: int


class LineItemIn(BaseModel):
    sku_code_id: Optional[uuid.UUID] = None
    sku_version_id: Optional[uuid.UUID] = None
    quantity: Decimal = Decimal("0")


class LineItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    sku_code_id: Optional[uuid.UUID]
    sku_version_id: Optional[uuid.UUID]
    quantity: Decimal
    sku_code: Optional[str] = None
    sku_version: Optional[str] = None


class ImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    image_type: str
    public_url: Optional[str]
    ocr_extracted_value: Optional[str]
    ocr_confidence: Optional[Decimal]
    ocr_status: Optional[str]
    sort_order: int


class ChecklistAnswerOut(BaseModel):
    checklist_item_id: uuid.UUID
    label: str
    answer: Optional[str]


class InspectionListItemOut(BaseModel):
    id: uuid.UUID
    shipment_number: str
    invoice_number: Optional[str]
    container_number: Optional[str]
    status: str
    category: str
    created_at: str


class InspectionBasicUpdate(BaseModel):
    category: Optional[str] = None
    shipment_number: Optional[str] = None
    truck_number: Optional[str] = None
    container_number: Optional[str] = None
    vendor_name: Optional[str] = None
    invoice_number: Optional[str] = None
    transporter_name: Optional[str] = None
    seal_number: Optional[str] = None
    remarks: Optional[str] = None
    inspection_passed_quantity: Optional[str] = None
    line_items: Optional[list[LineItemIn]] = None


class ChecklistSubmitIn(BaseModel):
    answers: dict[str, str]  # checklist_item_id (str) -> "ok" | "not_ok"


class InspectionDetailOut(BaseModel):
    id: uuid.UUID
    shipment_number: str
    is_auto_shipment_number: bool
    category: str
    truck_number: Optional[str]
    container_number: Optional[str]
    vendor_name: Optional[str]
    invoice_number: Optional[str]
    transporter_name: Optional[str]
    seal_number: Optional[str]
    total_quantity: Optional[Decimal]
    inspection_passed_quantity: Optional[str]
    remarks: Optional[str]
    status: str
    created_at: str
    updated_at: str
    line_items: list[LineItemOut]
    images: list[ImageOut]
    checklist_answers: list[ChecklistAnswerOut]
    linked_qc_id: Optional[uuid.UUID] = None
    linked_qc_shipment_number: Optional[str] = None


# ---------------------------------------------------------------------------
# Inward QC
# ---------------------------------------------------------------------------

class QcAttributeDefinitionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    category: str
    label: str
    field_type: str
    options_json: Optional[list[str]] = None
    is_required: bool
    sort_order: int


class QcFgtrayCriterionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    label: str
    sort_order: int


class QcSamplingPlanTierOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    category: str
    qty_label: str
    min_qty: Decimal
    max_qty: Optional[Decimal]
    sample_size: int
    upper_limit: Optional[int]
    note: Optional[str]


class QcMetaOut(BaseModel):
    manual_categories: list[str]
    attribute_definitions: dict[str, list[QcAttributeDefinitionOut]]
    fgtray_criteria: list[QcFgtrayCriterionOut]
    sampling_plan_tiers: list[QcSamplingPlanTierOut]
    quantity_labels: dict[str, str]
    conclusion_labels: dict[str, str]
    count_labels: dict[str, str]


class QcListItemOut(BaseModel):
    id: uuid.UUID
    shipment_number: str
    category: str
    coa_filename: Optional[str]
    status: str
    created_at: str


class QcAttributeValueIn(BaseModel):
    attribute_definition_id: uuid.UUID
    value: Optional[str] = None


class QcAttributeValueOut(BaseModel):
    attribute_definition_id: uuid.UUID
    label: str
    field_type: str
    options_json: Optional[list[str]] = None
    is_required: bool
    value: Optional[str]


class QcFgtrayAnswerIn(BaseModel):
    criteria_id: uuid.UUID
    answer: Optional[str] = None
    remarks: Optional[str] = None


class QcFgtrayAnswerOut(BaseModel):
    criteria_id: uuid.UUID
    label: str
    answer: Optional[str]
    remarks: Optional[str]


class QcLineItemSnapshotOut(BaseModel):
    sku_code: Optional[str]
    sku_version: Optional[str]
    quantity: Decimal


class QcBasicUpdate(BaseModel):
    vendor_name: Optional[str] = None
    quantity: Optional[Decimal] = None
    sku_code_id: Optional[uuid.UUID] = None
    sku_version_id: Optional[uuid.UUID] = None


class QcDetailOut(BaseModel):
    id: uuid.UUID
    shipment_number: str
    is_auto_shipment_number: bool
    category: str
    status: str
    vendor_name: Optional[str]
    quantity: Optional[Decimal]
    quantity_label: Optional[str]
    sku_code_id: Optional[uuid.UUID]
    sku_version_id: Optional[uuid.UUID]
    sku_code: Optional[str] = None
    sku_version: Optional[str] = None
    coa_filename: Optional[str]
    coa_url: Optional[str] = None
    conclusion_or_suggestions: Optional[str]
    sampling_sample_size: Optional[str]
    sampling_upper_limit: Optional[str]
    sampling_note: Optional[str]
    created_at: str
    updated_at: str
    submitted_at: Optional[str]
    created_by_name: Optional[str] = None
    linked_vehicle_inspection_id: Optional[uuid.UUID] = None
    line_item_snapshots: list[QcLineItemSnapshotOut] = []
    fgtray_answers: list[QcFgtrayAnswerOut] = []
    attribute_values: list[QcAttributeValueOut] = []
    vehicle_inspection: Optional[dict] = None


# ============================================================================
# RM/FG QR Generation, Pallets, RM/FG Storage
# ============================================================================

class PalletOut(BaseModel):
    id: uuid.UUID
    display_id: str
    pallet_type: str
    category: Optional[str]
    sku_code: Optional[str]
    sku_version: Optional[str]
    shipment_number: Optional[str]
    lifecycle_status: str
    qr_url: Optional[str] = None
    location_display_id: Optional[str] = None
    storage_id: Optional[uuid.UUID] = None


class QrGenerationListItemOut(BaseModel):
    id: uuid.UUID
    batch_display_id: str
    qr_type: str
    shipment_number: Optional[str]
    sku_code_snapshot: Optional[str]
    sku_version_snapshot: Optional[str]
    quantity: int
    status: str
    created_at: str


class QrGenerationDetailOut(BaseModel):
    id: uuid.UUID
    batch_display_id: str
    qr_type: str
    category: Optional[str]
    shipment_number: Optional[str]
    sku_code_snapshot: Optional[str]
    sku_version_snapshot: Optional[str]
    quantity: int
    status: str
    created_at: str
    generated_at: Optional[str]
    source_locked: bool
    source_inward_qc_id: Optional[uuid.UUID] = None
    source_production_run_id: Optional[uuid.UUID] = None
    source_display_id: Optional[str] = None
    pallets: list[PalletOut] = []


class ScanIn(BaseModel):
    payload: str


class StorageScanResultOut(BaseModel):
    stage: str  # "pallet_scanned" | "ready_to_confirm"
    pallet: Optional[PalletOut] = None
    location_display_id: Optional[str] = None
    location_zone: Optional[str] = None


class StorageRecordOut(BaseModel):
    id: uuid.UUID
    storage_type: str
    pallet_display_id: str
    sku_code: Optional[str]
    sku_version: Optional[str]
    shipment_number: Optional[str]
    location_display_id: str
    source_batch_display_id: str
    source_inward_qc_id: Optional[uuid.UUID] = None
    source_production_run_id: Optional[uuid.UUID] = None
    stored_by_name: Optional[str] = None
    stored_at: str
    pallet_status: str


class ProductionRunOut(BaseModel):
    id: uuid.UUID
    run_number: str
    shipment_number: Optional[str]
    sku_code: Optional[str]
    sku_version: Optional[str]
    category: str
    total_fg_pallets: int
    status: str
    has_fg_qr: bool = False
