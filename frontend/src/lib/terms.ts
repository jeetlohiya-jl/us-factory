/**
 * The ONE source of display names across the Factory platform (and the US
 * Factory screens it shares). Every concept has exactly one name:
 *
 *   RM                      Raw Material -- the short form is the name, never spelled out
 *   FG                      Finished Goods -- likewise
 *   FNP Tray                never "FNPG" / "FG Non-Padded Tray" / "FNP"
 *   Base Tray
 *   SKU                     the product (e.g. 3P) -- never "SKU Name" / "SKU Code" for it
 *   SKU Code                only the item code (e.g. CMP0003P)
 *   SKU Version             never bare "Version"
 *   Shipment Number         never "Shipment No."
 *   Pallet Number           never "Pallet ID"
 *   Quantity                never "Qty"
 *   RM Consumption          never "Material Consumption" / "Raw Material Consumption"
 *   On Hold                 never "hold" / "Hold"
 *
 * Display text only: internal IDs, database values (e.g. category "fnp_tray",
 * status "hold"), routes and location zone codes (FNPGTRAY, FPG) are
 * unchanged. Plain constants -- no requests, no runtime cost.
 */

export const T = {
  rawMaterial: "RM",
  finishedGoods: "FG",
  baseTray: "Base Tray",
  fnpTray: "FNP Tray",
  sku: "SKU",
  skus: "SKUs",
  skuCode: "SKU Code",
  skuVersion: "SKU Version",
  shipmentNumber: "Shipment Number",
  palletNumber: "Pallet Number",
  palletNumbers: "Pallet Numbers",
  quantity: "Quantity",
  location: "Location",
  machine: "Machine",
  category: "Category",
  vendor: "Vendor",
  customer: "Customer",
  poNumber: "PO Number",
  batchCode: "Batch Code",
  status: "Status",
} as const;

/** Module / screen names: sidebar, page headings, permissions. */
export const MODULE_NAMES = {
  goods_receipt: "Goods Receipt",
  inward_vehicle_inspection: "Inward Vehicle Inspection",
  inward_qc: "Inward QC",
  rm_qr_generation: `${T.rawMaterial} QR Generation`,
  rm_storage: `${T.rawMaterial} Storage`,
  material_consumption: `${T.rawMaterial} Consumption`,
  production: "Production",
  ipqc: "IPQC",
  rqc: "RQC",
  rqc_fg_qr: `RQC & ${T.finishedGoods} QR`,
  fg_qr_generation: `${T.finishedGoods} QR Generation`,
  fg_storage: `${T.finishedGoods} Storage`,
  customer_shipment: "Customer Shipment",
  shipment_picking: "Shipment Picking",
  goods_outward: "Goods Outward",
  outward_vehicle_inspection: "Outward Vehicle Inspection",
  machine_downtime: "Machine Downtime",
  traceability: "Traceability",
  // Setup
  vendors: "Vendors",
  customers: "Customers",
  skus: T.skus,
  locations: "Locations",
  machines: "Machines",
  users: "Users",
  portfolio_access: "Portfolio Access",
} as const;

/** Category labels (database value -> name). "fgtray" is the legacy value
 * for FNP Tray; "fg" appears on finished-goods pallets. */
export const CATEGORY_LABELS: Record<string, string> = {
  tray: T.baseTray,
  fnp_tray: T.fnpTray,
  fgtray: T.fnpTray,
  film: "Film",
  pad: "Soaker Pad",
  polybag: "Polybag",
  cfb: "CFB",
  glue: "Glue",
  fg: T.finishedGoods,
};
export const categoryLabel = (c: string | null | undefined): string => (c ? CATEGORY_LABELS[c] ?? c : "—");

/** Record status labels (database value -> name), shared by every module.
 * ("partial" / "received" differ per module -- Goods Receipt and Shipment
 * Picking label those in their own badges.) */
export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending: "Pending",
  saved: "Saved",
  approved: "Approved",
  accepted: "Approved",   // Inward QC's "accepted" = passed, same as everywhere else
  hold: "On Hold",
  onhold: "On Hold",
  rejected: "Rejected",
  completed: "Completed",
  inwarded: "Inwarded",
  generated: "Generated",
  picked: "Picked",
  shipped: "Shipped",
};
export const statusLabel = (s: string | null | undefined): string => (s ? STATUS_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1) : "—");
