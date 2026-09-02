export type Category = "tray" | "pad" | "polybag" | "cfb" | "glue";
export type InspectionStatus = "draft" | "hold" | "approved";

export interface SkuVersion {
  id: string;
  version: string;
  is_active: boolean;
}

export interface SkuCode {
  id: string;
  code: string;
  category: Category;
  is_active: boolean;
  versions: SkuVersion[];
}

export interface Vendor {
  id: string;
  category: Category;
  name: string;
  country: string | null;
  is_active: boolean;
}

export interface ChecklistItemRef {
  id: string;
  label: string;
  sort_order: number;
}

export interface LineItem {
  id: string;
  sku_code_id: string | null;
  sku_version_id: string | null;
  quantity: string | number;
  sku_code: string | null;
  sku_version: string | null;
}

export type ImageType = "container" | "truck" | "seal" | "condition" | "damage" | "empty_container";

export interface InspectionImage {
  id: string;
  image_type: ImageType;
  public_url: string | null;
  ocr_extracted_value: string | null;
  ocr_confidence: number | null;
  ocr_status: "success" | "low_confidence" | "failed" | null;
  sort_order: number;
}

export interface ChecklistAnswer {
  checklist_item_id: string;
  label: string;
  answer: "ok" | "not_ok" | null;
}

export interface InspectionListItem {
  id: string;
  shipment_number: string;
  invoice_number: string | null;
  container_number: string | null;
  status: InspectionStatus;
  category: Category;
  created_at: string;
}

export interface InspectionDetail {
  id: string;
  shipment_number: string;
  is_auto_shipment_number: boolean;
  category: Category;
  truck_number: string | null;
  container_number: string | null;
  vendor_name: string | null;
  invoice_number: string | null;
  transporter_name: string | null;
  seal_number: string | null;
  total_quantity: string | number | null;
  inspection_passed_quantity: string | null;
  remarks: string | null;
  status: InspectionStatus;
  created_at: string;
  updated_at: string;
  line_items: LineItem[];
  images: InspectionImage[];
  checklist_answers: ChecklistAnswer[];
  linked_qc_id: string | null;
  linked_qc_shipment_number: string | null;
}

export interface Permissions {
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_approve: boolean;
  can_fill_section: boolean;
}

export interface MeResponse {
  user_id: string;
  email: string;
  full_name: string;
  permissions: {
    inward_vehicle_inspection: Permissions;
    inward_qc: Permissions;
    rm_qr_generation: Permissions;
    rm_storage: Permissions;
    material_consumption: Permissions;
    production: Permissions;
    fg_qr_generation: Permissions;
    fg_storage: Permissions;
  };
}

// ---------------------------------------------------------------------------
// Inward QC
// ---------------------------------------------------------------------------

export type QcCategory = "fgtray" | "pad" | "polybag" | "cfb" | "glue";
export type QcManualCategory = "pad" | "polybag" | "cfb" | "glue";
export type QcStatus = "draft" | "pending" | "accepted" | "onhold";
export type QcFieldType = "text" | "number" | "dropdown";

export interface QcAttributeDefinition {
  id: string;
  category: QcManualCategory;
  label: string;
  field_type: QcFieldType;
  options_json: string[] | null;
  is_required: boolean;
  sort_order: number;
}

export interface QcFgtrayCriterion {
  id: string;
  label: string;
  sort_order: number;
}

export interface QcSamplingPlanTier {
  category: QcManualCategory;
  qty_label: string;
  min_qty: string | number;
  max_qty: string | number | null;
  sample_size: number;
  upper_limit: number | null;
  note: string | null;
}

export interface QcMeta {
  manual_categories: QcManualCategory[];
  attribute_definitions: Record<QcManualCategory, QcAttributeDefinition[]>;
  fgtray_criteria: QcFgtrayCriterion[];
  sampling_plan_tiers: QcSamplingPlanTier[];
  quantity_labels: Record<QcCategory, string>;
  conclusion_labels: Record<QcManualCategory, string>;
  count_labels: Record<QcManualCategory, string>;
}

export interface QcListItem {
  id: string;
  shipment_number: string;
  category: QcCategory;
  coa_filename: string | null;
  status: QcStatus;
  created_at: string;
}

export interface QcAttributeValue {
  attribute_definition_id: string;
  label: string;
  field_type: QcFieldType;
  options_json: string[] | null;
  is_required: boolean;
  value: string | null;
}

export interface CoaSuggestion {
  attribute_definition_id: string;
  label: string;
  extracted_value: string | null;
  status: "matched" | "not_found";
  source_line: string | null;
}

export interface QcFgtrayAnswer {
  criteria_id: string;
  label: string;
  answer: "ok" | "not_ok" | null;
  remarks: string | null;
}

export interface QcLineItemSnapshot {
  sku_code: string | null;
  sku_version: string | null;
  quantity: string | number;
}

export interface QcDetail {
  id: string;
  shipment_number: string;
  is_auto_shipment_number: boolean;
  category: QcCategory;
  status: QcStatus;
  vendor_name: string | null;
  quantity: string | number | null;
  quantity_label: string | null;
  sku_code_id: string | null;
  sku_version_id: string | null;
  sku_code: string | null;
  sku_version: string | null;
  coa_filename: string | null;
  coa_url: string | null;
  conclusion_or_suggestions: string | null;
  sampling_sample_size: string | null;
  sampling_upper_limit: string | null;
  sampling_note: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  created_by_name: string | null;
  linked_vehicle_inspection_id: string | null;
  line_item_snapshots: QcLineItemSnapshot[];
  fgtray_answers: QcFgtrayAnswer[];
  attribute_values: QcAttributeValue[];
  vehicle_inspection: InspectionDetail | null;
  // Only ever present on the response to uploadQcCoa — a one-shot batch of
  // suggested Observation values parsed from the COA just uploaded.
  coa_suggestions?: CoaSuggestion[];
}

// ---------------------------------------------------------------------------
// RM/FG QR Generation, Pallets, RM/FG Storage
// ---------------------------------------------------------------------------

export type PalletLifecycleStatus = "generated" | "pending_storage" | "stored" | "consumed" | "picked" | "shipped";

export const PALLET_STAGE_LABELS: Record<PalletLifecycleStatus, string> = {
  generated: "Generated", pending_storage: "Pending Storage", stored: "Stored",
  consumed: "Consumed", picked: "Picked for Shipment", shipped: "Shipped",
};

export const PALLET_STAGE_BADGE_CLASS: Record<PalletLifecycleStatus, string> = {
  generated: "generated", pending_storage: "pending", stored: "accepted",
  consumed: "draft", picked: "accepted", shipped: "draft",
};

export interface Pallet {
  id: string;
  display_id: string;
  pallet_type: "rm" | "fg";
  category: string | null;
  sku_code: string | null;
  sku_version: string | null;
  shipment_number: string | null;
  lifecycle_status: PalletLifecycleStatus;
  qr_url: string | null;
  location_display_id: string | null;
  storage_id: string | null;
}

export interface QrGenerationListItem {
  id: string;
  batch_display_id: string;
  qr_type: "rm" | "fg";
  shipment_number: string | null;
  sku_code_snapshot: string | null;
  sku_version_snapshot: string | null;
  country_code: string | null;
  quantity: number;
  status: "pending" | "generated";
  created_at: string;
}

export interface QrGenerationDetail extends QrGenerationListItem {
  category: string | null;
  generated_at: string | null;
  source_locked: boolean;
  source_inward_qc_id: string | null;
  source_production_run_id: string | null;
  source_display_id: string | null;
  pallets: Pallet[];
}

export interface StorageRecordDetail {
  id: string;
  storage_type: "rm" | "fg";
  pallet_display_id: string;
  sku_code: string | null;
  sku_version: string | null;
  shipment_number: string | null;
  location_display_id: string;
  source_batch_display_id: string;
  source_inward_qc_id: string | null;
  source_production_run_id: string | null;
  stored_by_name: string | null;
  stored_at: string;
  pallet_status: PalletLifecycleStatus;
}

export interface LocationRef {
  id: string;
  display_id: string;
  zone: string;
  qr_url: string | null;
}

export interface ProductionRun {
  id: string;
  run_number: string;
  shipment_number: string | null;
  sku_code: string | null;
  sku_version: string | null;
  category: string;
  total_fg_pallets: number;
  status: string;
  has_fg_qr: boolean;
}

// ---------------------------------------------------------------------------
// Material Consumption
// ---------------------------------------------------------------------------

export interface Machine {
  id: string;
  code: string;
  is_active: boolean;
}

export type SecondaryMaterialCategory = "cfb" | "pad" | "glue" | "polybag";

export interface MaterialConsumptionPalletRow {
  id: string;
  role: "primary" | SecondaryMaterialCategory;
  pallet_id: string;
  pallet_display_id: string;
  sku_code: string | null;
  sku_version: string | null;
  category: string | null;
  quantity: string | number;
  status: PalletLifecycleStatus;
}

export interface MaterialConsumptionEntrySummary {
  machine: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface MaterialConsumptionListItem {
  id: string;
  consumption_date: string;
  category: string | null;
  sku_code: string | null;
  sku_version: string | null;
  pallet_numbers: string;
  machine: string | null;
  shift: string | null;
  entries: MaterialConsumptionEntrySummary[];
  status: "draft" | "saved";
}

export interface MaterialConsumptionMachineEntry {
  id: string;
  machine_id: string | null;
  machine: string | null;
  category: string | null;
  sku_code_id: string | null;
  sku_version_id: string | null;
  sku_code: string | null;
  sku_version: string | null;
  start_time: string | null;
  end_time: string | null;
  pallets: MaterialConsumptionPalletRow[];
  secondary_materials: {
    cfb: MaterialConsumptionPalletRow[];
    pad: MaterialConsumptionPalletRow[];
    glue: MaterialConsumptionPalletRow[];
    polybag: MaterialConsumptionPalletRow[];
  };
}

export interface MaterialConsumptionDetail {
  id: string;
  consumption_date: string;
  shift: string | null;
  status: "draft" | "saved";
  production_run_id: string | null;
  production_run_number: string | null;
  ipqc_id: string | null;
  machine_entries: MaterialConsumptionMachineEntry[];
}

// ---------------------------------------------------------------------------
// Production -- read-only: every record is auto-created by Material
// Consumption's finalize() (see material_consumption_service.py), never a
// manual "New Record" flow. One entry per machine on the run, each carrying
// that machine's own linked Material Consumption data (category/SKU/
// pallets/times) -- exactly the machine_entries shape Material Consumption
// itself uses, since a run's machine entries ARE its source MC record(s)'
// machine entries.
// ---------------------------------------------------------------------------

export interface ProductionMachineEntry {
  machine_consumption_id: string; // the MaterialConsumptionMachineEntry id -- for stable list keys only
  material_consumption_id: string;
  machine: string | null;
  category: string | null;
  sku_code: string | null;
  sku_version: string | null;
  start_time: string | null;
  end_time: string | null;
  pallets: MaterialConsumptionPalletRow[];
}

export interface ProductionListItem {
  id: string;
  run_number: string;
  shipment_number: string | null;
  machines: string; // comma-joined machine codes, matching the prototype's table shape
  shift: string | null;
  sku_code: string | null;
  operator: string | null;
  status: string;
  date: string | null;
}

export interface ProductionDetail {
  id: string;
  run_number: string;
  shipment_number: string | null;
  shift: string | null;
  date: string | null;
  status: string;
  operator: string | null;
  sku_codes: string; // distinct SKU codes across every machine entry, comma-joined
  machine_entries: ProductionMachineEntry[];
  ipqc_id: string | null;
  ipqc_status: string | null;
  fg_qr_batches: { id: string; batch_display_id: string; status: string }[];
}
