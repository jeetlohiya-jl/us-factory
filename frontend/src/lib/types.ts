// "tray" displays as "Base Tray" and "fnp_tray" as "FNP Tray" -- together
// these are Inward Vehicle Inspection's "tray options" (renamed/expanded
// per the updated spec); "film" is a new material option alongside them.
// See components/inward-vehicle-inspection/Wizard.tsx's CATEGORY_LABELS.
export type Category = "tray" | "fnp_tray" | "film" | "pad" | "polybag" | "cfb" | "glue";
export type InspectionStatus = "draft" | "hold" | "approved";

// An Inward QC record auto-created from an approved Tray-family Vehicle
// Inspection carries the SAME category the inspection used ("tray" or
// "fnp_tray") -- it is never remapped to a different label, so the same
// category flows unchanged from Inward Vehicle Inspection all the way
// through Inward QC, Material Consumption, Production, QR Generation and
// Storage. "fgtray" is kept in this set only so QC records created before
// this passthrough existed still render/behave correctly; no new record is
// ever created with that value. Every place that used to special-case
// `category === "fgtray"` should check `TRAY_FAMILY_QC_CATEGORIES.includes(category)`
// instead, and every category label lookup should go through
// QC_CATEGORY_LABELS so "Base Tray"/"FNP Tray" are never spelled a second,
// inconsistent way (the old "FG Non-Padded Tray" / "FG NonPadded Tray" /
// "FNPG" wording is retired).
export const TRAY_FAMILY_QC_CATEGORIES: string[] = ["tray", "fnp_tray", "fgtray"];

/** SKUs belong to a material FAMILY, not a stage: the same tray (3P) is a
 * Base Tray when raw, an FNP Tray with film attached and FG once padded --
 * one SKU. Every SKU picker matches on family (migration 0049). */
export function skuFamily(category: string | null | undefined): string {
  return category && TRAY_FAMILY_QC_CATEGORIES.includes(category) ? "tray" : (category || "");
}
export function skuMatchesCategory(skuCategory: string | null | undefined, recordCategory: string | null | undefined): boolean {
  return !!recordCategory && skuFamily(skuCategory) === skuFamily(recordCategory);
}
// Inward material categories, in US Factory's Inward Vehicle Inspection
// order and wording (its Wizard.tsx CATEGORY_LABELS) -- used by Factory's
// Goods Receipt Category picker.
export const INWARD_CATEGORY_LABELS: Record<Category, string> = {
  tray: "Base Tray", fnp_tray: "FNP Tray", film: "Film",
  pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};
export const QC_CATEGORY_LABELS: Record<string, string> = {
  tray: "Base Tray", fnp_tray: "FNP Tray", fgtray: "FNP Tray",
  pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};

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
  description?: string | null;
  category: Category;
  is_active: boolean;
  // Section 11 -- admin-supplied 5-digit SKU number, the first segment of
  // the FG Storage Batch Code. Populated later by the business.
  batch_number: string | null;
  // Section 11 (correction) -- a separate, alphanumeric "SKU Code" field.
  // Distinct from `code` (SKU Name, above) and from `batch_number` (numeric
  // -only): "my sku code has numbers and alphabets : batch number is onky
  // the numbers without the alphabet."
  sku_code: string | null;
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
  // "Vehicle arrived within scheduled time window" is informational only
  // (migration 0022) -- affects_status=false there. Carried through so
  // ChecklistStep's status-preview banner can exclude it from Hold/Approved,
  // matching the backend's compute_status() exactly.
  affects_status: boolean;
}

// "Pallets" | "Kgs" | "Units" | "Bags" -- migration 0031's quantity-unit
// dropdown, used wherever the app records a quantity (see api.ts's various
// Unit fields and QUANTITY_UNITS below). "Bags" added for the Material
// Consumption scanning redesign (partial-consumption quantity entry).
export type QuantityUnit = "Pallets" | "Kgs" | "Units" | "Bags";
export const QUANTITY_UNITS: QuantityUnit[] = ["Pallets", "Kgs", "Units", "Bags"];

export interface LineItem {
  id: string;
  sku_code_id: string | null;
  sku_version_id: string | null;
  quantity: string | number;
  unit: QuantityUnit;
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
  affects_status: boolean;
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
  outward_vehicle_inspection: Permissions;
  machine_downtime: Permissions;
  goods_receipt: Permissions;
  // Factory's own permission rows (migration 0047) -- see lib/currentProduct.ts.
  factory_rm_storage: Permissions;
  factory_material_consumption: Permissions;
  factory_production: Permissions;
  factory_rqc_fg_qr: Permissions;
  factory_fg_storage: Permissions;
  factory_goods_outward: Permissions;
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
  "customer_shipment", "shipment_picking", "outward_vehicle_inspection", "machine_downtime",
  "goods_receipt",
  "factory_rm_storage", "factory_material_consumption", "factory_production",
  "factory_rqc_fg_qr", "factory_fg_storage", "factory_goods_outward",
];

// Setup -> Users groups the permission matrix by product.
export const US_FACTORY_MODULES: ModuleKey[] = [
  "inward_vehicle_inspection", "inward_qc",
  "rm_qr_generation", "rm_storage", "material_consumption", "production", "ipqc", "rqc", "fg_qr_generation", "fg_storage",
  "customer_shipment", "shipment_picking", "outward_vehicle_inspection", "machine_downtime",
];
export const FACTORY_MODULES: ModuleKey[] = [
  "goods_receipt", "factory_rm_storage", "factory_material_consumption", "factory_production",
  "factory_rqc_fg_qr", "factory_fg_storage", "factory_goods_outward",
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
// Portfolio Access (post-login "Factory" / "US Factory" picker,
// admin-managed via Setup -> Portfolio Access)
// ---------------------------------------------------------------------------

export interface PortfolioAccessMe {
  access_factory: boolean;
  access_us_factory: boolean;
}

export interface PortfolioAccess {
  id: string;
  email: string;
  access_factory: boolean;
  access_us_factory: boolean;
  created_at: string;
}

export interface PortfolioAccessInput {
  email: string;
  access_factory?: boolean;
  access_us_factory?: boolean;
}

export interface PortfolioAccessUpdateInput {
  access_factory?: boolean;
  access_us_factory?: boolean;
}

// ---------------------------------------------------------------------------
// Inward QC
// ---------------------------------------------------------------------------

export type QcCategory = "tray" | "fnp_tray" | "fgtray" | "pad" | "polybag" | "cfb" | "glue";
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
  quantity_unit: string;
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
  // The JSON the pallet's QR encodes. Factory pallets (Goods Receipt) have
  // no stored image -- PalletTile draws the QR from this in the browser.
  qr_payload?: string | null;
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
  // Factory Module 1 -- set when the batch came from one Goods Receipt entry.
  source_goods_receipt_entry_id?: string | null;
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
  // FG pallets only, Section 11.
  batch_code: string | null;
  // Factory Module 1 -- RM pallets received through Goods Receipt.
  goods_receipt_po_number?: string | null;
  goods_receipt_vendor_name?: string | null;
}

export interface LocationRef {
  id: string;
  display_id: string;
  zone: string;
  qr_url: string | null;
}

/** Setup -> Locations row (migration 0048: per unit). */
export interface LocationAdmin {
  id: string;
  display_id: string;
  zone: string;
  is_active: boolean;
  qr_url: string | null;
  qr_payload: string | null;
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
  // Section 11 -- admin-supplied 2-digit number used as the M<nn> segment
  // of the FG Storage Batch Code. Populated later by the business.
  batch_number: string | null;
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
  // Section 8 -- partial pallet consumption.
  unit: QuantityUnit;
  fully_consumed: boolean;
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
  shipment_number: string | null;
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
  shipment_number: string | null;
  operator: string | null;
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
  // own SKU Version (migration 0013). As of Section 12 (migration 0034),
  // each of these has an operator-editable override on this one machine
  // entry -- these fields already reflect the override where one is set
  // (see api.ts's flattenProductionDetail), so the UI can always just
  // display/edit `production_details` directly.
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
  // Section 12 -- genuinely new fields, no upstream source, entered per
  // machine entry.
  machine_no: string | null;
  auto_padding: string | null;
  container_order_no: string | null;
  // Rejection Classification, per machine entry (migration 0038) -- was a
  // single flat value shared by the whole run; now each machine gets its
  // own independently-editable set of counts, same as production_details.
  rejection_classification: ProductionRejectionClassification;
  // Migration 0039, task section 1 -- FG pallets actually produced on this
  // machine for this run's shift. Source of truth for "Pallets Produced";
  // distinct from and never overwritten by RQC's approved_pallets.
  pallets_produced: number;
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
  // DEPRECATED as of migration 0038 -- Rejection Classification moved to
  // per-machine-entry fields in machine_entry_attributes below. Kept only
  // for backward-compatible payload shape; the backend ignores these.
  rejection_damage: number;
  rejection_misplaced_glue: number;
  rejection_misplaced_pad: number;
  rejection_glue_on_pad: number;
  rejection_pad_placement_direction: number;
  rejection_adhesion_issue: number;
  total_fg_pallets: number;
  wastage_entries: { machine_id: string | null; trays: number | null; reason: string | null }[];
  // Section 12 -- per-machine-entry attribute overrides / new fields. A
  // field left undefined is not touched; "" explicitly clears an override
  // back to "use the SKU Version's own value". Rejection Classification
  // fields (migration 0038) follow the same "undefined = don't touch"
  // convention, except "" there means 0, not "use a reference value".
  machine_entry_attributes: {
    machine_entry_id: string;
    weight?: string; pcs_per_sleeve?: string; sleeve_per_case?: string; total_pcs_per_pallet?: string;
    pad_type?: string; pad_color?: string; case_type?: string;
    machine_no?: string; auto_padding?: string; container_order_no?: string;
    rejection_damage?: string; rejection_misplaced_glue?: string; rejection_misplaced_pad?: string;
    rejection_glue_on_pad?: string; rejection_pad_placement_direction?: string; rejection_adhesion_issue?: string;
    pallets_produced?: string;
  }[];
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
  // Migration 0039 -- sum of machine_entries[].pallets_produced. The real
  // "how many FG pallets did Production make" figure; total_fg_pallets
  // above is legacy/display-only (see its own comment upstream).
  total_pallets_produced: number;
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

// Factory OS Module 4 -- the QMP05 spreadsheet's exact 4-item quality
// testing list ("QMP05 - CIROVERWRAP PADDED FG V0 05.08.2026.xlsx", Quality
// Testing sheet), used only by the Factory product's combined RQC + FG QR
// page (frontend/src/app/rqc-fg-qr/page.tsx). This does NOT replace
// RQC_DEFECT_GROUPS above -- US Factory's own /rqc page keeps the full
// 15-item list unchanged. All 4 QMP05 items already exist verbatim in
// RQC_DEFECT_GROUPS (sr 1, 6, 7, 8), with the exact same classification and
// AQL accept/reject thresholds the QMP05 Sampling Plan sheet specifies
// (Critical 14/15, Major 21/22) -- so this is a pure filter, not a
// reinvented numbering space or a new set of thresholds. Item 3 (Placement
// Side of the Pad) has no acceptance criteria typed into the QMP05 sheet's
// own row; it is grouped under "Critical" there, so it uses the Critical
// group's own 14/15 threshold (the same one Stickiness of the Pad uses) --
// not invented, derived from the QMP05 Sampling Plan sheet's Critical row.
export const RQC_DEFECT_GROUPS_QMP05: RqcDefectGroupDef[] = RQC_DEFECT_GROUPS
  .map((group) => ({ ...group, items: group.items.filter((i) => [1, 6, 7, 8].includes(i.sr)) }))
  .filter((group) => group.items.length > 0);

// QMP05's own Sampling Plan sheet, transcribed verbatim -- shown as a
// read-only reference table on the Factory RQC page so the user never has
// to recreate it by hand. Kept clearly separate from "Number of Pallets"
// (pallets_tested)/"Approved Pallets" (fg_pallets_generated), which are
// this specific activity's own counts, not the sampling plan itself.
export interface RqcSamplingPlanRow {
  level: string;
  sampleSize: number;
  aql: number;
  acceptReject: string;
}
export const RQC_SAMPLING_PLAN: RqcSamplingPlanRow[] = [
  { level: "Minor | Level 1", sampleSize: 800, aql: 4, acceptReject: "53 | 54" },
  { level: "Major | Level 2", sampleSize: 800, aql: 1.5, acceptReject: "21 | 22" },
  { level: "Critical | Level 3", sampleSize: 800, aql: 1, acceptReject: "14 | 15" },
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

// Factory OS Module 4 -- same Base Material COA group as RQC_COA_BASE
// above, except sr 3's label follows the QMP05 COA sheet exactly ("Tray
// Weight with Pad (g)", not "with liner"). Used only by the Factory
// product's FactoryCoaEntryPanel; US Factory's own CoaEntryPanel keeps
// RQC_COA_BASE unchanged. The Functional/Packing/Printing groups are
// identical in QMP05, so those three constants above are reused as-is.
export const RQC_COA_BASE_FACTORY: RqcCoaParamDef[] = [
  { sr: 1, param: "Tray Colour", spec: "Natural" },
  { sr: 2, param: "Tray Dimensions (L x W x H) mm", spec: "As per specs" },
  { sr: 3, param: "Tray Weight with Pad (g)", spec: "As per specs" },
  { sr: 4, param: "Pad color", spec: "As per specs" },
  { sr: 5, param: "Base material of Pad", spec: "As per specs" },
  { sr: 6, param: "Dimensions of Pad", spec: "As per specs" },
  { sr: 7, param: "Weight of pad with Base material", spec: "As per specs" },
  { sr: 8, param: "Absorption Rate", spec: "As per specs" },
];

export interface RqcListItem {
  id: string;
  shipment_number: string | null;
  sku_code: string | null;
  sku_version: string | null;
  manufacturer: string | null;
  status: string;
  date: string | null;
  // Additive (2026-09-23, Factory Module 4) -- this activity's own Machine/
  // Shift/Date/Number Tested/Approved Pallets/Table-Person, so the Factory
  // combined RQC + FG QR list can show them without a second query per row.
  // US Factory's own /rqc list ignores these; nothing about that page reads
  // them, so this is a pure addition to the existing type/select, not a
  // behavior change for it.
  machine: string | null;
  activity_shift: string | null;
  activity_date: string | null;
  pallets_tested: number | null;
  fg_pallets_generated: number | null;
  table_person_number: string | null;
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

export interface RqcMachineAllocation {
  machine_id: string;
  machine: string | null;
  fg_pallets_count: number;
}

// Migration 0039 -- one incremental RQC approval activity (date + operator +
// approved pallet count). A shipment's RQC record can accumulate many of
// these over time; each independently drives its own FG QR Generation batch
// (see qr_generation_service.get_or_create_fg_qr_for_rqc_approval_entry).
// Immutable once created -- no edit route, only "+ Add Approval Entry".
export interface RqcApprovalEntry {
  id: string;
  entry_date: string;
  operator_user_id: string | null;
  operator_name: string | null;
  approved_pallets: number;
  table_person_number: string | null;
  created_at: string | null;
  machine_allocations: RqcMachineAllocation[];
  // Whether FG QR Generation has already produced a batch for this entry --
  // purely informational (idempotency itself lives server-side).
  fg_qr_status: string | null;
}

export interface RqcDetail {
  id: string;
  production_run_id: string | null;
  production_run_number: string | null;
  ipqc_id: string | null;
  shipment_number: string | null;
  manufacturer: string | null;
  sku_code: string | null;
  sku_version: string | null;
  // Legacy/display fallback only -- read live from production_runs.total_fg_pallets,
  // which Production no longer collects (see migration 0030). Prefer
  // fg_pallets_generated below, RQC's own editable field and the value
  // FG QR Generation actually uses.
  total_fg_pallets: number | null;
  // Production's own count -- sum of pallets_produced across every machine
  // entry feeding the linked run (migration 0039, task section 1). RQC's
  // approved pallets (fg_pallets_generated below) may never exceed this;
  // null when there's no linked Production Run to sum.
  total_pallets_produced: number | null;
  // "Number of FG Pallets Generated" -- as of migration 0039 this is a
  // denormalized running total (sum of approval_entries[].approved_pallets),
  // kept in sync by the backend purely for cheap display/back-compat.
  // approval_entries below is the real source of truth.
  fg_pallets_generated: number | null;
  // Section 11 -- brand-new field, manually entered here (never derived
  // from the logged-in user). The T<value> segment of the Batch Code.
  // Migration 0039: this is now just the default/last-used value shown when
  // adding a new approval entry -- each entry carries its own copy.
  table_person_number: string | null;
  // Section 11 -- every machine actually on the linked Production Run
  // (via production_run_machines), for the Machine Allocation dropdown.
  production_run_machines: { id: string; code: string }[];
  // Migration 0039 -- the incremental approval ledger. Replaces the old
  // single machine_allocations list below as the primary UI (kept for
  // back-compat with anything still reading the whole-record total).
  approval_entries: RqcApprovalEntry[];
  // Section 11 -- how fg_pallets_generated splits across those machines.
  // Deprecated by migration 0039's per-entry machine_allocations; kept only
  // for the legacy whole-run path (dev/test endpoint, Hold & Release).
  machine_allocations: RqcMachineAllocation[];
  shift: string | null;
  date: string | null;
  overall_result: string | null;
  status: string;
  defect_results: RqcDefectResult[];
  coa_observations: RqcCoaObservation[];
  // 2026-09-17 -- per-activity fields (RQC redesign, migration 0041/0042).
  // Each RqcRecord is now one dated inspection/approval activity: Number of
  // Pallets (tested), the one Machine these pallets came from, this
  // activity's own Shift and Date -- distinct from `shift`/`date` above,
  // which are the linked Production Run's values, shown as read-only
  // context/defaults on Page 1 of the wizard.
  pallets_tested: number | null;
  machine_id: string | null;
  activity_shift: string | null;
  activity_date: string | null;
}

// Payload for api.saveRqc -- the single atomic write for RQC (backend/
// app/api/rqc.py's PUT route). 2026-09-17: fg_pallets_generated,
// table_person_number, pallets_tested, machine_id, shift and activity_date
// are all written again (per-activity RQC redesign) -- manufacturer is
// still accepted for back-compat but the backend always overwrites it with
// the fixed "Cirkla INC" placeholder regardless of what's sent.
export interface RqcSavePayload {
  manufacturer: string | null;
  overall_result: string | null;
  fg_pallets_generated: number | null;
  table_person_number: string | null;
  pallets_tested: number | null;
  machine_id: string | null;
  shift: string | null;
  activity_date: string | null;
  save_mode: "draft" | "final";
  defect_results: RqcDefectResult[];
  coa_observations: RqcCoaObservation[];
}

// 2026-09-17 -- COA, decoupled from RqcRecord: one entry per SHIPMENT (see
// backend/app/api/rqc_coa.py). Find-or-create by shipment_number (POST),
// atomic whole-table save (PUT).
export interface RqcCoaEntry {
  id: string;
  shipment_number: string;
  coa_observations: RqcCoaObservation[];
}

// Payload for api.createRqcApprovalEntry -- backend POST
// /rqc/{record_id}/approval-entries (migration 0039).
export interface RqcApprovalEntryPayload {
  entry_date: string;
  approved_pallets: number;
  table_person_number: string | null;
  machine_allocations: { machine_id: string; fg_pallets_count: number }[];
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
  // Section 13.
  pcs: number | null;
  pcs_per_sleeve: string | null;
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
  // Section 13.
  pcs: string | number;
  pcs_per_sleeve: string;
}

export interface CustomerShipmentCreatePayload {
  customer: string;
  shipment_number: string; // user-entered, not system-generated
  line_items: { sku_code_id: string; sku_version_id: string; pallets_required: number; pcs?: number | null; pcs_per_sleeve?: string | null }[];
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

// ---------------------------------------------------------------------------
// Factory OS Module 6 -- Goods Outward: Customer Shipment + Shipment
// Picking combined into ONE module/page for the Factory product. Reuses
// the exact same customer_shipments / customer_shipment_line_items /
// shipment_picking_requests / shipment_picking_picks tables and the exact
// same FastAPI routes (create, delete, pick, undo-pick) as US Factory's own
// separate Customer Shipment / Shipment Picking pages -- no new tables, no
// new backend routes. Only the read shape is new (a combined Supabase
// select joining a shipment's line items straight to each one's own
// picking request and its individual picks), and a client-side aggregate
// "status" (pending/partial/complete) computed the same way
// shipment_picking_service._recompute_status computes each line item's own
// status, just rolled up: complete only when every line item's own request
// is complete, pending only when none has been picked at all, else partial.
// ---------------------------------------------------------------------------

export interface GoodsOutwardPick {
  id: string;
  pallet_id: string;
  pallet_display_id: string | null;
  batch_code: string | null;
  picked_at: string;
}

export interface GoodsOutwardLineItem {
  id: string; // CustomerShipmentLineItem id
  sku_code_id: string | null;
  sku_version_id: string | null;
  sku_code: string | null;
  sku_version: string | null;
  pallets_required: number;
  pcs: number | null;
  pcs_per_sleeve: string | null;
  // The 1:1 ShipmentPickingRequest fanned out for this line item at create
  // time (always present -- see customer_shipment_service.create_
  // customer_shipment). Null only in the impossible case of a line item
  // predating that fan-out guarantee.
  picking_request_id: string | null;
  status: "pending" | "partial" | "complete";
  picks: GoodsOutwardPick[];
}

export interface GoodsOutwardListItem {
  id: string;
  shipment_number: string;
  container_number: string;
  customer: string;
  sku_summary: string;
  pallets_required_total: number;
  pallets_picked_total: number;
  status: "pending" | "partial" | "complete";
  created_at: string;
}

// Minimal shape for a scanned pallet's read-only preview (api.
// previewScannedFgPallet), used only to route a Goods Outward scan to the
// right line item's picking request before the real pick call. Deliberately
// not the shared `Pallet` type -- that type carries only SKU snapshot text
// (for display), while this needs the real sku_code_id/sku_version_id FKs
// to match against GoodsOutwardLineItem's own ids, the same identity
// comparison shipment_picking_service.pick_pallet_for_request performs
// server-side (never a text/snapshot comparison).
export interface GoodsOutwardScannedPallet {
  id: string;
  display_id: string;
  sku_code_id: string | null;
  sku_version_id: string | null;
  sku_code: string | null;
  sku_version: string | null;
  lifecycle_status: PalletLifecycleStatus;
}

export interface GoodsOutwardDetail {
  id: string;
  shipment_number: string;
  container_number: string;
  customer: string;
  created_at: string;
  line_items: GoodsOutwardLineItem[];
  status: "pending" | "partial" | "complete";
}

// ---------------------------------------------------------------------------
// Outward Vehicle Inspection -- auto-created (never manually) the instant a
// Customer Shipment is recorded. NOT linked to RQC. List/detail reads are
// direct-Supabase; the one editable-fields save (Truck/Invoice/Transporter/
// Seal/Quantity + the 7-question checklist + Remarks) goes through FastAPI,
// same split as RQC/IPQC.
// ---------------------------------------------------------------------------

export const OVI_QUESTIONS: { sr: number; label: string }[] = [
  { sr: 1, label: "Clean, dry & dust free" },
  { sr: 2, label: "No objectionable odour" },
  { sr: 3, label: "No insects/rodents" },
  { sr: 4, label: "No floor damage or contamination risk" },
  { sr: 5, label: "No water leakage" },
  { sr: 6, label: "No rust inside the container" },
  { sr: 7, label: "Boxes are in intact condition (no damages)" },
];

export interface OviListItem {
  id: string;
  shipment_number: string | null;
  invoice_number: string | null;
  status: string;
  date: string | null;
}

export interface OviAnswer {
  question_sr: number;
  answer: "ok" | "not_ok" | null;
}

// Fixed loading-photo slots, transcribed from the "Loading Container
// Process" template -- same list/order as OVI_IMAGE_TYPES in
// ovi_service.py. Each slot holds at most one photo (replace, not
// add-more), same convention as Inward Vehicle Inspection's single-image
// fields (container/truck/seal/condition/empty_container).
export type OviImageType =
  | "license_plate" | "container_number" | "before_loading"
  | "row_1" | "row_2" | "row_3" | "row_4" | "row_5" | "row_6" | "row_7" | "row_8" | "row_9" | "row_10" | "row_11"
  | "seal_half" | "seal_entire" | "lead_seal" | "weighbridge_record";

export const OVI_IMAGE_TYPES: { key: OviImageType; label: string }[] = [
  { key: "license_plate", label: "License Plate" },
  { key: "container_number", label: "Container Number" },
  { key: "before_loading", label: "Before Loading" },
  { key: "row_1", label: "First Row" },
  { key: "row_2", label: "Second Row" },
  { key: "row_3", label: "Third Row" },
  { key: "row_4", label: "Fourth Row" },
  { key: "row_5", label: "Fifth Row" },
  { key: "row_6", label: "Sixth Row" },
  { key: "row_7", label: "Seventh Row" },
  { key: "row_8", label: "Eighth Row" },
  { key: "row_9", label: "Ninth Row" },
  { key: "row_10", label: "Tenth Row" },
  { key: "row_11", label: "Eleventh Row" },
  { key: "seal_half", label: "Seal Half of the Container" },
  { key: "seal_entire", label: "Seal the Entire Container" },
  { key: "lead_seal", label: "Lead Seal" },
  { key: "weighbridge_record", label: "Weigh Bridge Record" },
];

export interface OviImage {
  id: string;
  image_type: OviImageType;
  public_url: string | null;
  sort_order: number;
}

export interface OviDetail {
  id: string;
  customer_shipment_id: string;
  shipment_number: string | null;
  customer_name: string | null;
  quantity: string | null;
  quantity_unit: string;
  truck_number: string | null;
  invoice_number: string | null;
  transporter_name: string | null;
  seal_number: string | null;
  remarks: string | null;
  status: string;
  answers: OviAnswer[];
  images: OviImage[];
}

export interface OviSavePayload {
  truck_number: string | null;
  invoice_number: string | null;
  transporter_name: string | null;
  seal_number: string | null;
  quantity: string | null;
  quantity_unit: string;
  remarks: string | null;
  save_mode: "draft" | "final";
  answers: OviAnswer[];
}

// ---------------------------------------------------------------------------
// Machine Downtime -- fully independent of the shipment workflow. Full CRUD
// direct-Supabase (RLS-gated: Create/Delete Admin-only, Edit open to any
// user with edit permission), no FastAPI at all.
// ---------------------------------------------------------------------------

export interface MachineDowntimeRecord {
  id: string;
  machine_id: string | null;
  machine: string | null;
  shift: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  reason: string | null;
  status: string;
  created_at: string;
}

export interface MachineDowntimeSavePayload {
  machine_id: string | null;
  machine: string | null;
  shift: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  reason: string | null;
  status: "draft" | "saved";
}

// -- Hold & Release ----------------------------------------------------
// The five modules a "hold" status can occur in -- each with its own
// existing module_permissions scope, reused here (see migration 0024).
export type HoldReleaseModule = "inward_vehicle_inspection" | "inward_qc" | "ipqc" | "rqc" | "outward_vehicle_inspection";

export interface HoldReleaseRecord {
  id: string;
  module: HoldReleaseModule;
  record_id: string;
  date_of_hold: string | null;
  product_name: string | null;
  batch_code: string | null;
  point_of_detection: string | null;
  qty_of_hold: string | null;
  reason_for_hold: string | null;
  record_filled_by: string | null;
  date_of_decision: string | null;
  disposition: string | null;
  reason_of_disposition: string | null;
  qty_decided: string | null;
  done_by: string | null;
  approved_by: string | null;
  status: "draft" | "completed";
}

export type HoldReleaseSavePayload = Omit<HoldReleaseRecord, "id" | "module" | "record_id">;


// ---------------------------------------------------------------------------
// Factory OS Module 1 -- Goods Receipt (migration 0045)
// ---------------------------------------------------------------------------

export type GoodsReceiptStatus = "draft" | "pending" | "partial" | "received";
export type GoodsReceiptEntryStatus = "pending" | "inwarded";

export interface GoodsReceiptEntry {
  id: string;
  // The PO line's own identifier (HA1, V6, ...) -- this IS the shipment number.
  shipment_number: string;
  sku_code_id: string;
  sku_version_id: string | null;
  sku_code: string | null;
  sku_version: string | null;
  po_quantity: number;
  received_quantity: number | null;
  unit: QuantityUnit;
  pallet_count: number | null;
  status: GoodsReceiptEntryStatus;
  inwarded_at: string | null;
  qr_batch: { id: string; batch_display_id: string; status: "pending" | "generated"; quantity: number } | null;
}

export interface GoodsReceiptDetail {
  id: string;
  po_number: string;
  category: Category | null;
  vendor_id: string | null;
  vendor_name: string;
  status: GoodsReceiptStatus;
  created_at: string;
  updated_at: string | null;
  entries: GoodsReceiptEntry[];
}

export interface GoodsReceiptListItem {
  id: string;
  po_number: string;
  category: Category | null;
  vendor_name: string;
  status: GoodsReceiptStatus;
  created_at: string;
  container_count: number;
  inwarded_count: number;
  pallet_total: number;
  sku_summary: string;
}

/** Local-only editing row in the New/Edit panel. `id` is set for a row
 * that already exists server-side; `locked` for one already inwarded. */
export interface GoodsReceiptEntryDraft {
  key: string;
  id: string | null;
  locked: boolean;
  shipment_number: string;
  sku_code_id: string | null;
  sku_version_id: string | null;
  po_quantity: string;
  unit: QuantityUnit;
}

export interface GoodsReceiptSavePayload {
  po_number: string;
  category: Category;
  vendor_id: string;
  as_draft: boolean;
  entries: {
    id?: string | null; shipment_number: string;
    sku_code_id: string; sku_version_id: string | null; po_quantity: number; unit: QuantityUnit;
  }[];
}

export interface GoodsReceiptInwardPayload {
  received_quantity: number;
  unit: QuantityUnit;
  pallet_count: number;
}
