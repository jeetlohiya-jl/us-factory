export type Category = "tray" | "pad" | "polybag" | "cfb" | "glue";
export type InspectionStatus = "draft" | "hold" | "approved";

export interface SkuVersion {
  id: string;
  version: string;
  is_active: boolean;
  // Production Details reference attributes (migration 0013) -- entered
  // once via the SKU Names admin screen, then autopopulated (never
  // re-entered) on every Production record that uses this version,
  // matching the prototype's SKU_PRODUCTION_DETAILS lookup.
  prod_weight?: string | null;
  prod_pcs_per_sleeve?: string | null;
  prod_sleeve_per_case?: string | null;
  prod_total_pcs_per_pallet?: number | null;
  prod_total_pallets?: number | null;
  prod_target_shots?: string | null;
  prod_pad_type?: string | null;
  prod_pad_color?: string | null;
  prod_case_type?: string | null;
  // Completes SKU_PRODUCTION_DETAILS (migration 0015) -- not used by
  // Production, but IPQC's autopopulation (Dimensions of Pad, Absorption
  // Rate) reads these off the same per-SKU-Version reference data.
  prod_dimensions?: string | null;
  prod_absorption_rate?: string | null;
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

export interface ModulePermissionsMap {
  inward_vehicle_inspection: Permissions;
  inward_qc: Permissions;
  rm_qr_generation: Permissions;
  rm_storage: Permissions;
  material_consumption: Permissions;
  production: Permissions;
  ipqc: Permissions;
  rqc: Permissions;
  fg_qr_generation: Permissions;
  fg_storage: Permissions;
  customer_shipment: Permissions;
  shipment_picking: Permissions;
}

export interface MeResponse {
  user_id: string;
  email: string;
  full_name: string;
  is_admin: boolean;
  permissions: ModulePermissionsMap;
}

// ---------------------------------------------------------------------------
// Users (Setup -> Users, admin-only)
// ---------------------------------------------------------------------------

export type ModuleKey = keyof ModulePermissionsMap;

export const USER_MODULES: ModuleKey[] = [
  "inward_vehicle_inspection", "inward_qc",
  "rm_qr_generation", "rm_storage", "material_consumption", "production", "ipqc", "rqc", "fg_qr_generation", "fg_storage",
  "customer_shipment", "shipment_picking",
];

export interface AppUser {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  is_admin: boolean;
  permissions: Record<ModuleKey, Permissions>;
}

export interface UserCreateInput {
  email: string;
  full_name: string;
  is_admin?: boolean;
  is_active?: boolean;
  permissions?: Partial<Record<ModuleKey, Permissions>>;
}

export interface UserUpdateInput {
  full_name?: string;
  is_active?: boolean;
  is_admin?: boolean;
  permissions?: Partial<Record<ModuleKey, Permissions>>;
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
  sku_version_id: string | null;
  start_time: string | null;
  end_time: string | null;
  pallets: MaterialConsumptionPalletRow[];
  // SKU-derived Production Details, autopopulated from the machine entry's
  // own SKU Version -- read-only, never re-entered per run (migration 0013).
  production_details: {
    prod_weight: string | null;
    prod_pcs_per_sleeve: string | null;
    prod_sleeve_per_case: string | null;
    prod_total_pcs_per_pallet: number | null;
    prod_total_pallets: number | null;
    prod_target_shots: string | null;
    prod_pad_type: string | null;
    prod_pad_color: string | null;
    prod_case_type: string | null;
  } | null;
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
  total_pcs_per_pallet: number | null; // sum across machine entries' SKU-derived Production Details
  total_rejections: number; // sum of the run's Rejection Classification fields
}

// Rejection Classification, matching the prototype's rejectionClassification
// shape exactly (Damage, Misplaced Glue, Misplaced Pad, Glue on Pad, Pad
// Placement Direction, Adhesion Issue).
export interface ProductionRejectionClassification {
  damage: number;
  misplaced_glue: number;
  misplaced_pad: number;
  glue_on_pad: number;
  pad_placement_direction: number;
  adhesion_issue: number;
}

export interface ProductionWastageEntry {
  id: string;
  machine_id: string | null;
  machine: string | null;
  trays: number | null;
  reason: string | null;
  sort_order: number;
}

// Payload for api.saveProduction -- the single atomic write for the
// editable Production feature (backend/app/api/production.py's PUT route).
export interface ProductionSavePayload {
  rejection_damage: number;
  rejection_misplaced_glue: number;
  rejection_misplaced_pad: number;
  rejection_glue_on_pad: number;
  rejection_pad_placement_direction: number;
  rejection_adhesion_issue: number;
  total_fg_pallets: number;
  wastage_entries: { machine_id: string | null; trays: number | null; reason: string | null }[];
  // This device's own clock ("HH:MM") -- saving this record now stamps
  // end_time on every Material Consumption machine entry it feeds, same
  // convention as start_time (see Wizard.tsx's nowHHMM()).
  client_time?: string;
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
  total_fg_pallets: number;
  rejection_classification: ProductionRejectionClassification;
  wastage_entries: ProductionWastageEntry[];
  // Who actually filled in and saved the editable fields (migration 0014)
  // -- distinct from `operator`, which is whoever's Material Consumption
  // save auto-created this run.
  completed_by: string | null;
  completed_at: string | null;
  ipqc_id: string | null;
  ipqc_status: string | null;
  rqc_id: string | null;
  rqc_status: string | null;
  fg_qr_batches: { id: string; batch_display_id: string; status: string }[];
}

// ---------------------------------------------------------------------------
// IPQC -- auto-created (never manually) the moment its Production Run's
// first Material Consumption record is finalized. Shipment/product/pad
// fields are autopopulated from that source and read-only; Shift Incharge
// and the Check Time inspection blocks are the editable data, saved
// atomically through FastAPI.
// ---------------------------------------------------------------------------

// The prototype's fixed IPQC_DEFECTS list -- static reference data (type,
// classification, inspection method, sample size), never stored per
// record. Only order/sr/label matter for rendering. Note: sr skips 4/5
// here, but this is IPQC's own independent numbering -- RQC has its own
// fully separate 15-item defect grid (RQC_DEFECT_GROUPS below, sr 1-15),
// not a continuation of this list.
export interface IpqcDefectDef {
  sr: number;
  type: string;
  classification: string;
  badgeClass: string;
  method: string;
  sampleSize: number;
}

export const IPQC_DEFECTS: IpqcDefectDef[] = [
  { sr: 1, type: "Foreign Material (Insects , Hair and Dust)", classification: "Unacceptable", badgeClass: "unacceptable", method: "Visual inspection", sampleSize: 4 },
  { sr: 2, type: "Metal Particles", classification: "Unacceptable", badgeClass: "unacceptable", method: "Visual inspection", sampleSize: 4 },
  { sr: 3, type: "Lamination black spots (due to metal pieces)", classification: "Unacceptable", badgeClass: "unacceptable", method: "Visual inspection", sampleSize: 4 },
  { sr: 6, type: "Stickiness of the Pad", classification: "Critical", badgeClass: "critical", method: "Visual inspection", sampleSize: 4 },
  { sr: 7, type: "Placement Side of the Pad", classification: "Critical", badgeClass: "critical", method: "Visual inspection", sampleSize: 4 },
  { sr: 8, type: "Direction of the Pad", classification: "Major", badgeClass: "major", method: "Visual inspection", sampleSize: 4 },
  { sr: 9, type: "Air gap", classification: "Functional test", badgeClass: "functional", method: "As per SOP", sampleSize: 4 },
  { sr: 10, type: "Gravity fall", classification: "Functional test", badgeClass: "functional", method: "As per SOP", sampleSize: 4 },
];

export interface IpqcListItem {
  id: string;
  shipment_number: string | null;
  sku_code: string | null;
  sku_version: string | null;
  shift_incharge: string | null;
  status: string;
  date: string | null;
  shift: string | null;
}

export interface IpqcBlockDefect {
  defect_sr: number;
  failure: number | null;
  reason: string | null;
}

export interface IpqcCheckBlock {
  id: string;
  check_time: string | null;
  overall_result: string | null;
  sort_order: number;
  defects: IpqcBlockDefect[];
}

export interface IpqcDetail {
  id: string;
  production_run_id: string;
  production_run_number: string | null;
  shipment_number: string | null;
  batch_code: string | null;
  manufacturer: string | null;
  shift: string | null;
  date: string | null;
  pad_color: string | null;
  weight: string | null;
  dimensions: string | null;
  absorption_rate: string | null;
  sku_code: string | null;
  sku_version: string | null;
  shift_incharge: string | null;
  status: string;
  check_blocks: IpqcCheckBlock[];
  material_consumptions: { id: string; status: string }[];
}

// Payload for api.saveIpqc -- the single atomic write for IPQC (backend/
// app/api/ipqc.py's PUT route).
export interface IpqcSavePayload {
  shift_incharge: string | null;
  save_mode: "draft" | "final";
  blocks: { check_time: string | null; overall_result: string | null; defects: IpqcBlockDefect[] }[];
}

// ---------------------------------------------------------------------------
// RQC (Final Quality Control) -- auto-created (never manually) the moment
// its Production Run's IPQC record reaches Approved. Sits between IPQC and
// FG QR Generation: Shipment/SKU/pallet-count fields are autopopulated from
// upstream (the Production Run, via IPQC) and read-only; Manufacturer, the
// defect grid, the COA observation tables, and Overall Result are the
// editable data, saved atomically through FastAPI. RQC does not create or
// own any FG pallets -- it only gates when Production's own existing FG
// pallet count becomes eligible for FG QR Generation.
// ---------------------------------------------------------------------------

// The prototype's fixed RQC_DEFECT_GROUPS -- 4 classification groups, each
// with its own AQL accept/reject sample numbers, 15 items total. Static
// reference data, never stored per record -- only the per-defect Found/
// Remarks answers are. Independent sr numbering space from IPQC_DEFECTS.
export interface RqcDefectItemDef {
  sr: number;
  type: string;
}

export interface RqcDefectGroupDef {
  classification: string;
  badgeClass: string;
  sampleSize: number;
  accept: number;
  reject: number;
  items: RqcDefectItemDef[];
}

export const RQC_DEFECT_GROUPS: RqcDefectGroupDef[] = [
  { classification: "Unacceptable", badgeClass: "unacceptable", sampleSize: 800, accept: 0, reject: 1, items: [
    { sr: 1, type: "Foreign Material (Insects , Hair and Dust)" },
    { sr: 2, type: "Metal Particles" },
    { sr: 3, type: "Lamination black spots (due to metal pieces)" },
  ] },
  { classification: "Critical", badgeClass: "critical", sampleSize: 800, accept: 14, reject: 15, items: [
    { sr: 4, type: "Surface Cracks and Cuts" },
    { sr: 5, type: "Lamination bubbles on tray" },
    { sr: 6, type: "Stickiness of the Pad" },
    { sr: 7, type: "Placement Side of the Pad" },
  ] },
  { classification: "Major", badgeClass: "major", sampleSize: 800, accept: 21, reject: 22, items: [
    { sr: 8, type: "Direction of the Pad" },
    { sr: 9, type: "Lamination peel off" },
    { sr: 10, type: "Trimming burs" },
    { sr: 11, type: "Lamination film darkening" },
    { sr: 12, type: "Flange damage or bend" },
  ] },
  { classification: "Minor", badgeClass: "minor", sampleSize: 800, accept: 53, reject: 54, items: [
    { sr: 13, type: "Color spots (Black, yellow etc)" },
    { sr: 14, type: "Watermarks or mold marks" },
    { sr: 15, type: "Lamination fold" },
  ] },
];

export interface RqcCoaParamDef {
  sr: number;
  param: string;
  spec: string;
}

export const RQC_COA_BASE: RqcCoaParamDef[] = [
  { sr: 1, param: "Tray Colour", spec: "Natural" },
  { sr: 2, param: "Tray Dimensions (L x W x H) mm", spec: "As per specs" },
  { sr: 3, param: "Tray Weight with liner (g)", spec: "As per specs" },
  { sr: 4, param: "Pad color", spec: "As per specs" },
  { sr: 5, param: "Base material of Pad", spec: "As per specs" },
  { sr: 6, param: "Dimensions of Pad", spec: "As per specs" },
  { sr: 7, param: "Weight of pad with Base material", spec: "As per specs" },
  { sr: 8, param: "Absorption Rate", spec: "As per specs" },
];

export const RQC_COA_FUNCTIONAL: RqcCoaParamDef[] = [
  { sr: 1, param: "Air gap (AB Stacking)", spec: "1 sample set of 10 trays/pallet (Test procedure)" },
  { sr: 2, param: "Gravity fall (AB stacking)", spec: "1 sample set of 10 trays/pallet (Test procedure)" },
];

export const RQC_COA_PACKING: RqcCoaParamDef[] = [
  { sr: 1, param: "Pallet Box Dimensions", spec: "As per specifications (Pallet Box need to be having 1500 Kgf)" },
  { sr: 2, param: "Trays/Bag", spec: "As per specifications" },
  { sr: 3, param: "Bags/Pallet", spec: "As per specifications" },
  { sr: 4, param: "Trays/Pallet", spec: "As per specifications" },
  { sr: 5, param: "Tray Packing Direction in bags", spec: "As per specifications" },
  { sr: 6, param: "Strapping & Angle Boards", spec: "As per specifications" },
  { sr: 7, param: "Stretch wrapping of pallet boxes", spec: "As per specifications" },
  { sr: 8, param: "Pallet Material and Quality", spec: "As per specs - Plywood pallets" },
];

export const RQC_COA_PRINTING: RqcCoaParamDef[] = [
  { sr: 1, param: "Artwork", spec: "As per approved artwork" },
  { sr: 2, param: "Print shade", spec: "As per approved artwork" },
  { sr: 3, param: "Barcode", spec: "As per approved artwork" },
  { sr: 4, param: "Packing Label", spec: "As per approved artwork" },
  { sr: 5, param: "Special Label", spec: "As per approved artwork" },
];

export interface RqcListItem {
  id: string;
  shipment_number: string | null;
  sku_code: string | null;
  sku_version: string | null;
  manufacturer: string | null;
  status: string;
  date: string | null;
}

export interface RqcDefectResult {
  defect_sr: number;
  found: number | null;
  remarks: string | null;
}

export interface RqcCoaObservation {
  coa_group: string;
  sr: number;
  observation: string | null;
}

export interface RqcDetail {
  id: string;
  production_run_id: string;
  production_run_number: string | null;
  ipqc_id: string | null;
  shipment_number: string | null;
  manufacturer: string | null;
  sku_code: string | null;
  sku_version: string | null;
  total_fg_pallets: number | null;
  shift: string | null;
  date: string | null;
  overall_result: string | null;
  status: string;
  defect_results: RqcDefectResult[];
  coa_observations: RqcCoaObservation[];
}

// Payload for api.saveRqc -- the single atomic write for RQC (backend/
// app/api/rqc.py's PUT route).
export interface RqcSavePayload {
  manufacturer: string | null;
  overall_result: string | null;
  save_mode: "draft" | "final";
  defect_results: RqcDefectResult[];
  coa_observations: RqcCoaObservation[];
}

// ---------------------------------------------------------------------------
// Customer Shipment / Shipment Picking -- downstream of FG Storage:
//   FG Storage -> Customer Shipment -> Shipment Picking
// List/detail reads are direct-Supabase (see lib/api.ts); FastAPI is only
// used for the one atomic create transaction, delete, and the pick/undo-pick
// actions. Customer Shipment is create-once (no edit, no own status).
// ---------------------------------------------------------------------------

export interface CustomerShipmentListItem {
  id: string;
  shipment_number: string;
  container_number: string;
  customer: string;
  sku_summary: string; // e.g. "SKU-A / V1, SKU-B / V2"
  total_pallets: number;
  created_at: string;
}

export interface CustomerShipmentLineItem {
  id: string;
  sku_code_id: string | null;
  sku_version_id: string | null;
  sku_code: string | null;
  sku_version: string | null;
  pallets_required: number;
}

export interface ShipmentPickingRequestSummary {
  id: string;
  sku_code: string | null;
  sku_version: string | null;
  pallets_required: number;
  pallets_picked: number;
  status: string;
}

export interface CustomerShipmentDetail {
  id: string;
  shipment_number: string;
  container_number: string;
  customer: string;
  created_at: string;
  line_items: CustomerShipmentLineItem[];
  picking_requests: ShipmentPickingRequestSummary[];
}

// Draft-form line item shape, before save (no id yet -- keyed locally).
export interface CustomerShipmentLineItemDraft {
  key: string;
  sku_code_id: string | null;
  sku_version_id: string | null;
  pallets_required: string | number;
}

export interface CustomerShipmentCreatePayload {
  customer: string;
  line_items: { sku_code_id: string; sku_version_id: string; pallets_required: number }[];
}

export interface CustomerShipmentCreateResult {
  id: string;
  shipment_number: string;
  container_number: string;
  customer: string;
  line_items: { id: string; sku_code: string | null; sku_version: string | null; pallets_required: number }[];
}

export interface ShipmentPickingListItem {
  id: string;
  shipment_number: string | null;
  customer: string | null;
  sku_code: string | null;
  sku_version: string | null;
  pallets_required: number;
  pallets_picked: number;
  status: string;
  created_at: string;
}

export interface ShipmentPickingPick {
  id: string;
  pallet_id: string;
  pallet_display_id: string | null;
  picked_at: string;
}

export interface ShipmentPickingDetail {
  id: string;
  shipment_number: string | null;
  container_number: string | null;
  customer: string | null;
  sku_code: string | null;
  sku_version: string | null;
  pallets_required: number;
  status: string;
  picks: ShipmentPickingPick[];
}
