import uuid
from decimal import Decimal
from typing import Literal, Optional

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
    country: Optional[str] = None
    is_active: bool


class VendorIn(BaseModel):
    category: str
    name: str
    country: str


class VendorUpdateIn(BaseModel):
    name: Optional[str] = None
    country: Optional[str] = None
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
    country_code: Optional[str] = None
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
    country_code: Optional[str] = None
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


# ---------------------------------------------------------------------------
# Production -- editable fields (migration 0013). Rejection Classification,
# Wastage entries and Total FG Pallets Generated are the only genuinely
# per-run editable data (see migration 0013's design notes) -- everything
# else on a Production record is autopopulated/read-only, sourced from
# Material Consumption and the SKU Version, both direct-Supabase reads.
# ---------------------------------------------------------------------------

class ProductionWastageEntryIn(BaseModel):
    machine_id: Optional[uuid.UUID] = None
    trays: Optional[Decimal] = None
    reason: Optional[str] = None


class ProductionWastageEntryOut(BaseModel):
    id: uuid.UUID
    machine_id: Optional[uuid.UUID] = None
    trays: Optional[Decimal] = None
    reason: Optional[str] = None
    sort_order: int


class ProductionSaveIn(BaseModel):
    rejection_damage: Decimal = Decimal("0")
    rejection_misplaced_glue: Decimal = Decimal("0")
    rejection_misplaced_pad: Decimal = Decimal("0")
    rejection_glue_on_pad: Decimal = Decimal("0")
    rejection_pad_placement_direction: Decimal = Decimal("0")
    rejection_adhesion_issue: Decimal = Decimal("0")
    total_fg_pallets: int = 0
    wastage_entries: list[ProductionWastageEntryIn] = []
    # This device's own clock, same convention as Material Consumption's
    # start_time -- saving this record is now what stamps end_time on every
    # machine entry that fed it (see stamp_end_times_for_production_run).
    # Optional: falls back to the server's clock if not sent.
    client_time: Optional[str] = None


class ProductionSaveOut(BaseModel):
    id: uuid.UUID
    status: str
    total_fg_pallets: int
    rejection_damage: Decimal
    rejection_misplaced_glue: Decimal
    rejection_misplaced_pad: Decimal
    rejection_glue_on_pad: Decimal
    rejection_pad_placement_direction: Decimal
    rejection_adhesion_issue: Decimal
    wastage_entries: list[ProductionWastageEntryOut] = []


# ---------------------------------------------------------------------------
# IPQC -- editable fields (migration 0015). Shift Incharge and the Check
# Time inspection blocks (each with its fixed 8-defect Failure/Reason
# grid) are the only genuinely per-record editable data -- everything else
# (Shipment Number, Batch Code, Manufacturer, Pad Color, Weight,
# Dimensions, Absorption Rate, SKU/Version) is autopopulated at creation
# from Material Consumption / the SKU Version and never re-entered here.
# ---------------------------------------------------------------------------

class IpqcBlockDefectIn(BaseModel):
    defect_sr: int
    failure: Optional[Decimal] = None
    reason: Optional[str] = None


class IpqcBlockDefectOut(BaseModel):
    defect_sr: int
    failure: Optional[Decimal] = None
    reason: Optional[str] = None


class IpqcCheckBlockIn(BaseModel):
    # check_time is stamped client-side off the device clock the moment
    # "+ Add Another Record" is clicked (same client_time pattern Material
    # Consumption uses for start_time) and never edited afterward -- the
    # backend just persists whatever arrives, it doesn't generate it.
    check_time: Optional[str] = None
    overall_result: Optional[str] = None
    defects: list[IpqcBlockDefectIn] = []


class IpqcCheckBlockOut(BaseModel):
    id: uuid.UUID
    check_time: Optional[str] = None
    overall_result: Optional[str] = None
    sort_order: int
    defects: list[IpqcBlockDefectOut] = []


class IpqcSaveIn(BaseModel):
    shift_incharge: Optional[str] = None
    # 'draft' always saves as Draft (Save Draft button); 'final' computes
    # Approved/Hold from whether any defect's Failure is >= 1 across every
    # block (Save button) -- matches ipqcSaveDraft/ipqcSave exactly, no
    # other status model.
    save_mode: Literal["draft", "final"] = "draft"
    blocks: list[IpqcCheckBlockIn] = []


class IpqcSaveOut(BaseModel):
    id: uuid.UUID
    status: str
    shift_incharge: Optional[str] = None
    blocks: list[IpqcCheckBlockOut] = []


# ---------------------------------------------------------------------------
# RQC (Final Quality Control) -- migration 0019. Auto-created the moment the
# relevant Material Consumption record is finalized, independent of IPQC's
# status (see rqc_service.find_or_create_rqc).
# Shape is flat (no "blocks" concept like IPQC's Check Time entries) -- one
# fixed 15-item defect grid (RQC_DEFECT_GROUPS) and 4 fixed COA parameter
# tables (RQC_COA_BASE/FUNCTIONAL/PACKING/PRINTING) answered once per record.
# Shipment Number / SKU Code / SKU Version / No. of Pallets are all
# autopopulated from the Production Run at creation and never re-entered
# here -- only Manufacturer (no real upstream source, placeholder + editable)
# and the inspection answers themselves are genuinely user-editable.
# ---------------------------------------------------------------------------

class RqcDefectResultIn(BaseModel):
    defect_sr: int
    found: Optional[Decimal] = None
    remarks: Optional[str] = None


class RqcDefectResultOut(BaseModel):
    defect_sr: int
    found: Optional[Decimal] = None
    remarks: Optional[str] = None


class RqcCoaObservationIn(BaseModel):
    coa_group: str
    sr: int
    observation: Optional[str] = None


class RqcCoaObservationOut(BaseModel):
    coa_group: str
    sr: int
    observation: Optional[str] = None


class RqcSaveIn(BaseModel):
    manufacturer: Optional[str] = None
    overall_result: Optional[str] = None
    # 'draft' always saves as Draft (Save Draft button); 'final' computes
    # Approved/Hold from whether any defect's Found >= that defect group's
    # reject number across the whole grid (Save button) -- matches
    # rqcRecalcResult/rqcOverallStatus exactly, same shape as IPQC's own
    # save_mode/status computation.
    save_mode: Literal["draft", "final"] = "draft"
    defect_results: list[RqcDefectResultIn] = []
    coa_observations: list[RqcCoaObservationIn] = []


class RqcSaveOut(BaseModel):
    id: uuid.UUID
    status: str
    manufacturer: Optional[str] = None
    overall_result: Optional[str] = None
    defect_results: list[RqcDefectResultOut] = []
    coa_observations: list[RqcCoaObservationOut] = []


class RqcCreateIn(BaseModel):
    # Manual "+ New Record" creation -- the only way an RQC record is
    # created. Shipment Number is required and must be unique.
    shipment_number: str
    manufacturer: Optional[str] = None


class RqcCreateOut(BaseModel):
    id: uuid.UUID
    shipment_number: str
    status: str


# ---------------------------------------------------------------------------
# Machines (master data for Material Consumption / Production)
# ---------------------------------------------------------------------------

class MachineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    code: str
    is_active: bool = True


class MachineIn(BaseModel):
    code: str


class MachineUpdateIn(BaseModel):
    code: Optional[str] = None
    is_active: Optional[bool] = None


# ---------------------------------------------------------------------------
# Material Consumption
# ---------------------------------------------------------------------------

class MaterialConsumptionScanIn(BaseModel):
    payload: str
    # Optional "HH:MM" from the scanning device's own clock, used to stamp
    # this machine entry's start_time atomically with its very first
    # primary-pallet scan (see add_primary_pallet). Sent by the frontend so
    # the factory workstation's local time is what's recorded, not the
    # backend server's -- the backend can run anywhere, the workstation is
    # what's physically at the factory.
    client_time: Optional[str] = None


class MaterialConsumptionSecondaryScanIn(BaseModel):
    payload: str
    category: str  # 'cfb' | 'pad' | 'glue' | 'polybag'


class MaterialConsumptionBasicUpdate(BaseModel):
    shift: Optional[str] = None


class MaterialConsumptionMachineEntryIn(BaseModel):
    machine_id: Optional[uuid.UUID] = None


class MaterialConsumptionPalletOut(BaseModel):
    id: uuid.UUID
    role: str
    pallet_id: uuid.UUID
    pallet_display_id: str
    sku_code: Optional[str] = None
    sku_version: Optional[str] = None
    category: Optional[str] = None
    quantity: Decimal
    status: str  # the pallet's own lifecycle_status, for display


class MaterialConsumptionSecondaryMaterialsOut(BaseModel):
    cfb: list[MaterialConsumptionPalletOut] = []
    pad: list[MaterialConsumptionPalletOut] = []
    glue: list[MaterialConsumptionPalletOut] = []
    polybag: list[MaterialConsumptionPalletOut] = []


class MaterialConsumptionMachineEntryOut(BaseModel):
    id: uuid.UUID
    machine_id: Optional[uuid.UUID] = None
    machine: Optional[str] = None
    category: Optional[str] = None
    sku_code_id: Optional[uuid.UUID] = None
    sku_version_id: Optional[uuid.UUID] = None
    sku_code: Optional[str] = None
    sku_version: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    pallets: list[MaterialConsumptionPalletOut] = []
    secondary_materials: MaterialConsumptionSecondaryMaterialsOut = MaterialConsumptionSecondaryMaterialsOut()


class MaterialConsumptionEntrySummaryOut(BaseModel):
    """Compact per-machine summary for the list page -- the full pallet/
    secondary-material breakdown only appears in MaterialConsumptionDetailOut,
    opened from the wizard."""
    machine: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None


class MaterialConsumptionListItemOut(BaseModel):
    id: uuid.UUID
    consumption_date: str
    category: Optional[str]
    sku_code: Optional[str]
    sku_version: Optional[str]
    pallet_numbers: str  # comma-joined display of primary pallets across every machine
    machine: Optional[str]  # comma-joined machine codes, e.g. "MACH-001, MACH-002"
    shift: Optional[str]
    entries: list[MaterialConsumptionEntrySummaryOut] = []
    status: str


class MaterialConsumptionDetailOut(BaseModel):
    id: uuid.UUID
    consumption_date: str
    shift: Optional[str]
    status: str
    production_run_id: Optional[uuid.UUID]
    production_run_number: Optional[str] = None
    ipqc_id: Optional[uuid.UUID] = None
    machine_entries: list[MaterialConsumptionMachineEntryOut] = []


# ---------------------------------------------------------------------------
# Customer Shipment / Shipment Picking -- downstream of FG Storage:
#   FG Storage -> Customer Shipment -> Shipment Picking
# Customer Shipment list/detail reads are direct-Supabase (per spec); the
# only FastAPI routes are the one atomic create transaction and delete for
# Customer Shipment, and pick/undo-pick for Shipment Picking.
# ---------------------------------------------------------------------------

class CustomerShipmentLineItemIn(BaseModel):
    sku_code_id: uuid.UUID
    sku_version_id: uuid.UUID
    pallets_required: int


class CustomerShipmentCreateIn(BaseModel):
    customer: str
    # User-entered, not system-generated (see customer_shipment_service.
    # create_customer_shipment's docstring) -- Container Number is still
    # allocated automatically.
    shipment_number: str
    line_items: list[CustomerShipmentLineItemIn] = []


class CustomerShipmentLineItemOut(BaseModel):
    id: uuid.UUID
    sku_code: Optional[str] = None
    sku_version: Optional[str] = None
    pallets_required: int


class CustomerShipmentCreateOut(BaseModel):
    id: uuid.UUID
    shipment_number: str
    container_number: str
    customer: str
    line_items: list[CustomerShipmentLineItemOut] = []


class ShipmentPickIn(BaseModel):
    payload: str  # scanned pallet QR payload


class ShipmentPickOut(BaseModel):
    request_id: uuid.UUID
    status: str
    pallet_display_id: str
    pallets_picked: int
    pallets_required: int


# ---------------------------------------------------------------------------
# Outward Vehicle Inspection -- auto-created from Customer Shipment (see
# customer_shipment_service.create_customer_shipment); this router exists
# solely for the one atomic save (Step 1 fields + the 7-question checklist
# + remarks) and Admin-only delete. No create schema -- there is no
# POST/create route.
# ---------------------------------------------------------------------------

class OviAnswerIn(BaseModel):
    question_sr: int
    answer: Optional[Literal["ok", "not_ok"]] = None


class OviAnswerOut(BaseModel):
    question_sr: int
    answer: Optional[str] = None


class OviSaveIn(BaseModel):
    truck_number: Optional[str] = None
    invoice_number: Optional[str] = None
    transporter_name: Optional[str] = None
    seal_number: Optional[str] = None
    quantity: Optional[str] = None
    remarks: Optional[str] = None
    save_mode: Literal["draft", "final"] = "draft"
    answers: list[OviAnswerIn] = []


class OviSaveOut(BaseModel):
    id: uuid.UUID
    status: str
    truck_number: Optional[str] = None
    invoice_number: Optional[str] = None
    transporter_name: Optional[str] = None
    seal_number: Optional[str] = None
    quantity: Optional[str] = None
    remarks: Optional[str] = None
    answers: list[OviAnswerOut] = []


# ---------------------------------------------------------------------------
# User management (Setup -> Users) -- app_users + module_permissions CRUD,
# admin-only (see require_admin in app/api/deps.py). Mirrors the exact
# module list and permission flags /api/v1/me already returns
# (app/api/me.py MODULES) so the "shape" of a user's permissions is
# identical whether you're reading your own via /me or managing someone
# else's here.
# ---------------------------------------------------------------------------

USER_MODULES = [
    "inward_vehicle_inspection", "inward_qc",
    "rm_qr_generation", "rm_storage", "material_consumption", "production", "ipqc", "rqc", "fg_qr_generation", "fg_storage",
    "customer_shipment", "shipment_picking", "outward_vehicle_inspection", "machine_downtime",
]


class PermissionFlags(BaseModel):
    can_view: bool = True
    can_create: bool = False
    can_edit: bool = False
    can_delete: bool = False
    can_approve: bool = False
    can_fill_section: bool = False


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    full_name: str
    is_active: bool
    is_admin: bool
    permissions: dict[str, PermissionFlags]


class UserCreateIn(BaseModel):
    email: str
    full_name: str
    is_admin: bool = False
    is_active: bool = True
    permissions: dict[str, PermissionFlags] = {}


class UserUpdateIn(BaseModel):
    full_name: Optional[str] = None
    is_active: Optional[bool] = None
    is_admin: Optional[bool] = None
    permissions: Optional[dict[str, PermissionFlags]] = None
