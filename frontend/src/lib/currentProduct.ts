import type { ModuleKey, ModulePermissionsMap } from "./types";

/**
 * Factory and US Factory are two independent working units with separate
 * permissions (and separate sequence numbers). Factory's modules 2-6 reuse
 * US Factory's screens, so every request says which product it comes from
 * -- the X-Product header, added to every Supabase call (supabaseClient.ts)
 * and every FastAPI call (api.ts request()) -- and the permission for a
 * shared module is then read from its Factory row.
 *
 * Plain module state (not React), because the data layer needs it outside
 * components. AppShell sets it from the post-login product choice.
 */
export type Product = "factory" | "us_factory";

let current: Product | null = null;

export function setCurrentProduct(p: Product | null) {
  current = p;
}

export function getCurrentProduct(): Product | null {
  return current;
}

/** Shared (US Factory) permission key -> its Factory row. Keep in sync with
 * app_effective_module() (migration 0047) and FACTORY_PERMISSION_MAP in
 * backend/app/api/deps.py. */
export const FACTORY_PERMISSION_MAP: Partial<Record<ModuleKey, ModuleKey>> = {
  // Setup -> Vendors / SKU Names are gated on this in US Factory; in
  // Factory they serve Goods Receipt (RLS mirrors it, migration 0048).
  inward_vehicle_inspection: "goods_receipt",
  rm_storage: "factory_rm_storage",
  rm_qr_generation: "goods_receipt",
  material_consumption: "factory_material_consumption",
  production: "factory_production",
  ipqc: "factory_production",
  rqc: "factory_rqc_fg_qr",
  fg_qr_generation: "factory_rqc_fg_qr",
  fg_storage: "factory_fg_storage",
  customer_shipment: "factory_goods_outward",
  shipment_picking: "factory_goods_outward",
};

/** In Factory, every shared screen reading e.g. permissions.rm_storage
 * transparently gets the person's Factory RM Storage permission instead. */
export function permissionsForProduct(perms: ModulePermissionsMap, product: Product | null): ModulePermissionsMap {
  if (product !== "factory") return perms;
  const out = { ...perms };
  for (const [usKey, factoryKey] of Object.entries(FACTORY_PERMISSION_MAP) as [ModuleKey, ModuleKey][]) {
    if (perms[factoryKey]) out[usKey] = perms[factoryKey];
  }
  return out;
}
