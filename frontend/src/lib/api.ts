import { getAuthHeader } from "./session";
import { supabase } from "./supabaseClient";
import type {
  InspectionDetail, InspectionListItem, SkuCode, SkuVersion, ChecklistItemRef, MeResponse, Category, ImageType,
  QcMeta, QcListItem, QcDetail, QcManualCategory,
  Pallet, QrGenerationListItem, QrGenerationDetail, StorageRecordDetail, LocationRef, ProductionRun,
  Vendor, Machine, MaterialConsumptionListItem, MaterialConsumptionDetail, SecondaryMaterialCategory,
} from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Hybrid architecture Phase 1/2 -- reads and simple master-data CRUD for
 * SKUs/Vendors/Machines/Locations/reference and every module's list/detail
 * now go straight to Supabase (RLS-enforced, see migration 0011) instead of
 * FastAPI. Every transactional/business-rule write (inspection submit, QC
 * calculations, COA parsing, QR generation, storage confirm, Material
 * Consumption scan/finalize, and every Phase-1 table's own create/update/
 * delete) still goes through FastAPI's `request()` below, unchanged.
 *
 * `sbRequest` wraps a Supabase call and throws the same ApiError shape
 * `request()` throws, translating the handful of Postgres error codes the
 * old FastAPI routes already turned into friendly messages (23505 unique
 * violation, 23503 FK violation, 42501 RLS/permission denial) so every
 * existing `catch (e) { e instanceof ApiError ... }` in the frontend keeps
 * working exactly as it did against FastAPI, with no page-level changes.
 */
async function sbRequest<T>(
  fn: () => Promise<{ data: T | null; error: { message: string; code?: string } | null }>,
  messages?: { conflict?: string; fk?: string; denied?: string }
): Promise<T> {
  const { data, error } = await fn();
  if (error) {
    if (error.code === "23505") throw new ApiError(409, messages?.conflict || error.message);
    if (error.code === "23503") throw new ApiError(409, messages?.fk || error.message);
    if (error.code === "42501") throw new ApiError(403, messages?.denied || "You do not have permission to do this.");
    throw new ApiError(500, error.message);
  }
  return data as T;
}

// Postgrest-style query builder -- structurally compatible with every
// `supabase.from(...)` chain used below. Deliberately NOT generic over the
// SDK's own (very deep) builder types: threading those through a shared
// helper via a type parameter blows up TS's instantiation depth. Every
// call site casts back to its real builder type (`as unknown as X`) right
// before awaiting, same pattern already used elsewhere in this file.
interface PgQuery {
  eq(col: string, val: unknown): PgQuery;
  or(expr: string): PgQuery;
  gte(col: string, val: unknown): PgQuery;
  lt(col: string, val: unknown): PgQuery;
}

/** `%search%`, ilike-quoted for a Postgrest filter value (commas and
 * parens are how Postgrest's `.or()` mini-language separates clauses, so
 * either would break a raw search term containing one). */
function ilikeTerm(search: string): string {
  return `%${search.replace(/[,()]/g, " ")}%`;
}

function applyListFilters(
  q: PgQuery,
  params: { search?: string; status?: string; category?: string; date?: string },
  searchColumns: string[]
): PgQuery {
  if (params.search && searchColumns.length) {
    const like = ilikeTerm(params.search);
    q = q.or(searchColumns.map((c) => `${c}.ilike.${like}`).join(","));
  }
  if (params.status) q = q.eq("status", params.status);
  if (params.category) q = q.eq("category", params.category);
  if (params.date) {
    const next = new Date(`${params.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    q = q.gte("created_at", `${params.date}T00:00:00`).lt("created_at", next.toISOString().slice(0, 19));
  }
  return q;
}

function applyIviFilters(q: PgQuery, params: { search?: string; status?: string; category?: string; date?: string }): PgQuery {
  return applyListFilters(q, params, ["shipment_number", "invoice_number", "container_number", "truck_number"]);
}

const PALLET_SELECT =
  "id,display_id,pallet_type,category,sku_code:sku_code_snapshot,sku_version:sku_version_snapshot,shipment_number,lifecycle_status,qr_url:qr_public_url," +
  "current_location:locations(display_id),storage_record:storage_records(id)";

type RawPallet = {
  current_location: { display_id: string } | null;
  storage_record: { id: string }[] | { id: string } | null;
} & Omit<Pallet, "location_display_id" | "storage_id">;

/** Flattens the embedded current_location/storage_record objects PostgREST
 * returns into PalletOut's flat location_display_id/storage_id fields --
 * matches serialize_pallet() in pallet_serialization.py exactly. */
function flattenPallet(raw: RawPallet): Pallet {
  const storage = Array.isArray(raw.storage_record) ? raw.storage_record[0] : raw.storage_record;
  return {
    id: raw.id, display_id: raw.display_id, pallet_type: raw.pallet_type, category: raw.category,
    sku_code: raw.sku_code, sku_version: raw.sku_version, shipment_number: raw.shipment_number,
    lifecycle_status: raw.lifecycle_status, qr_url: raw.qr_url,
    location_display_id: raw.current_location?.display_id ?? null,
    storage_id: storage?.id ?? null,
  };
}

function qrListQuery(qrType: "rm" | "fg", params: { search?: string; date?: string; sku?: string }) {
  let q = supabase
    .from("qr_generation_records")
    .select("id,batch_display_id,qr_type,shipment_number,sku_code_snapshot,sku_version_snapshot,country_code,quantity,status,created_at")
    .eq("qr_type", qrType);
  if (params.search) {
    const like = ilikeTerm(params.search);
    q = q.or(`shipment_number.ilike.${like},sku_code_snapshot.ilike.${like}`);
  }
  if (params.sku) q = q.ilike("sku_code_snapshot", ilikeTerm(params.sku));
  if (params.date) {
    const next = new Date(`${params.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    q = q.gte("created_at", `${params.date}T00:00:00`).lt("created_at", next.toISOString().slice(0, 19));
  }
  return q.order("created_at", { ascending: false });
}

async function qrGetDetail(qrType: "rm" | "fg", id: string): Promise<QrGenerationDetail> {
  const { data, error } = await supabase
    .from("qr_generation_records")
    .select(
      "id,batch_display_id,qr_type,category,shipment_number,sku_code_snapshot,sku_version_snapshot,country_code,quantity,status,created_at,generated_at," +
        "source_inward_qc_id,source_production_run_id," +
        "source_inward_qc:inward_qc_records(shipment_number),source_production_run:production_runs(run_number)," +
        `pallets(${PALLET_SELECT})`
    )
    .eq("id", id)
    .eq("qr_type", qrType)
    .single();
  if (error || !data) throw new ApiError(404, `${qrType.toUpperCase()} QR Generation record not found`);
  const raw = data as unknown as {
    id: string; batch_display_id: string; qr_type: "rm" | "fg"; category: string | null; shipment_number: string | null;
    sku_code_snapshot: string | null; sku_version_snapshot: string | null; country_code: string | null; quantity: number;
    status: "pending" | "generated"; created_at: string; generated_at: string | null;
    source_inward_qc_id: string | null; source_production_run_id: string | null;
    source_inward_qc: { shipment_number: string } | null; source_production_run: { run_number: string } | null;
    pallets: RawPallet[];
  };
  return {
    id: raw.id, batch_display_id: raw.batch_display_id, qr_type: raw.qr_type, category: raw.category,
    shipment_number: raw.shipment_number, sku_code_snapshot: raw.sku_code_snapshot, sku_version_snapshot: raw.sku_version_snapshot,
    country_code: raw.country_code, quantity: raw.quantity, status: raw.status, created_at: raw.created_at,
    generated_at: raw.generated_at, source_locked: !!(raw.source_inward_qc_id || raw.source_production_run_id),
    source_inward_qc_id: raw.source_inward_qc_id, source_production_run_id: raw.source_production_run_id,
    source_display_id: raw.source_inward_qc?.shipment_number ?? raw.source_production_run?.run_number ?? null,
    pallets: (raw.pallets || []).map(flattenPallet),
  };
}

async function pendingPalletsQuery(palletType: "rm" | "fg", params: { search?: string; sku?: string }): Promise<Pallet[]> {
  let q = supabase.from("pallets").select(PALLET_SELECT).eq("pallet_type", palletType).eq("lifecycle_status", "pending_storage");
  // sku is an exact match against the SKU snapshot (mirrors `p.sku_code_snapshot == sku`
  // in list_pending -- not a substring filter, unlike `search`).
  if (params.sku) q = q.eq("sku_code_snapshot", params.sku);
  const { data, error } = await q;
  if (error) throw new ApiError(500, error.message);
  let rows = ((data || []) as unknown as RawPallet[]).map(flattenPallet);
  if (params.search) {
    const s = params.search.toLowerCase();
    rows = rows.filter((p) => p.display_id.toLowerCase().includes(s) || (p.sku_code || "").toLowerCase().includes(s));
  }
  return rows;
}

const STORAGE_RECORD_SELECT =
  "id,storage_type,stored_at," +
  "pallet:pallets(display_id,sku_code:sku_code_snapshot,sku_version:sku_version_snapshot,shipment_number,lifecycle_status)," +
  "location:locations(display_id)," +
  "source_qr_generation:qr_generation_records(batch_display_id)," +
  "source_inward_qc_id,source_production_run_id," +
  "stored_by_user:app_users!storage_records_stored_by_fkey(full_name)";

type RawStorageRecord = {
  id: string; storage_type: "rm" | "fg"; stored_at: string;
  pallet: { display_id: string; sku_code: string | null; sku_version: string | null; shipment_number: string | null; lifecycle_status: string } | null;
  location: { display_id: string } | null;
  source_qr_generation: { batch_display_id: string } | null;
  source_inward_qc_id: string | null; source_production_run_id: string | null;
  stored_by_user: { full_name: string } | null;
};

function flattenStorageRecord(raw: RawStorageRecord): StorageRecordDetail {
  return {
    id: raw.id, storage_type: raw.storage_type,
    pallet_display_id: raw.pallet?.display_id ?? "",
    sku_code: raw.pallet?.sku_code ?? null, sku_version: raw.pallet?.sku_version ?? null,
    shipment_number: raw.pallet?.shipment_number ?? null,
    location_display_id: raw.location?.display_id ?? "",
    source_batch_display_id: raw.source_qr_generation?.batch_display_id ?? "",
    source_inward_qc_id: raw.source_inward_qc_id, source_production_run_id: raw.source_production_run_id,
    stored_by_name: raw.stored_by_user?.full_name ?? null,
    stored_at: raw.stored_at,
    pallet_status: (raw.pallet?.lifecycle_status ?? "generated") as StorageRecordDetail["pallet_status"],
  };
}

async function storageRecordsQuery(storageType: "rm" | "fg", search: string): Promise<StorageRecordDetail[]> {
  const { data, error } = await supabase
    .from("storage_records")
    .select(STORAGE_RECORD_SELECT)
    .eq("storage_type", storageType)
    .order("stored_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);
  let rows = ((data || []) as unknown as RawStorageRecord[]).map(flattenStorageRecord);
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((r) => r.pallet_display_id.toLowerCase().includes(s) || (r.sku_code || "").toLowerCase().includes(s));
  }
  return rows;
}

async function storageRecordDetail(storageType: "rm" | "fg", id: string): Promise<StorageRecordDetail> {
  const { data, error } = await supabase.from("storage_records").select(STORAGE_RECORD_SELECT).eq("id", id).eq("storage_type", storageType).single();
  if (error || !data) throw new ApiError(404, `${storageType.toUpperCase()} Storage record not found`);
  return flattenStorageRecord(data as unknown as RawStorageRecord);
}

/** Unfiltered row count for a table -- used for InspectionListItem's/
 * QcListItem's `total_count` (always the grand total regardless of the
 * current search/filter, exactly like FastAPI's own separate `total_all`
 * query in list_inspections/list_qc). */
async function countAll(table: string): Promise<number> {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  if (error) throw new ApiError(500, error.message);
  return count ?? 0;
}

/**
 * Same error translation as sbRequest, for mutations whose caller only
 * cares whether the call succeeded (every Phase 1 admin-screen mutation --
 * skus/page.tsx, vendors/page.tsx, machines/page.tsx -- always immediately
 * re-fetches its own list afterward rather than using the mutation's
 * return value, matching the old FastAPI-backed behaviour exactly).
 */
async function sbVoid(
  fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>,
  messages?: { conflict?: string; fk?: string; denied?: string }
): Promise<void> {
  const { error } = await fn();
  if (error) {
    if (error.code === "23505") throw new ApiError(409, messages?.conflict || error.message);
    if (error.code === "23503") throw new ApiError(409, messages?.fk || error.message);
    if (error.code === "42501") throw new ApiError(403, messages?.denied || "You do not have permission to do this.");
    throw new ApiError(500, error.message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeader = await getAuthHeader();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      Authorization: authHeader,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail || JSON.stringify(data);
    } catch {
      // ignore
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

// -- Material Consumption: list/detail via Supabase -------------------------
// Machine entries and their pallets are ordered by sort_order (mirrors
// `order_by="...sort_order"` on both relationships in models.py) -- sorted
// client-side below rather than via Postgrest's embedded `.order()` (which
// needs a `foreignTable` path per nesting level and is easy to get subtly
// wrong two levels deep); sort_order itself is selected only to sort by and
// dropped from the flattened shape, which doesn't expose it.

type RawMcPallet = {
  id: string; role: "primary" | SecondaryMaterialCategory; pallet_id: string; quantity: string | number; sort_order: number;
  pallet: { display_id: string; sku_code: string | null; sku_version: string | null; category: string | null; lifecycle_status: string } | null;
};

const MC_PALLET_SELECT =
  "id,role,pallet_id,quantity,sort_order," +
  "pallet:pallets(display_id,sku_code:sku_code_snapshot,sku_version:sku_version_snapshot,category,lifecycle_status)";

type RawMcMachineEntry = {
  id: string; machine_id: string | null; machine: { code: string } | null; category: string | null;
  sku_code_id: string | null; sku_version_id: string | null;
  sku_code: string | null; sku_version: string | null; start_time: string | null; end_time: string | null;
  sort_order: number; pallets: RawMcPallet[];
};

const MC_MACHINE_ENTRY_SELECT =
  "id,machine_id,machine:machines(code),category,sku_code_id,sku_version_id," +
  "sku_code:sku_code_snapshot,sku_version:sku_version_snapshot,start_time,end_time,sort_order," +
  `pallets:material_consumption_pallets(${MC_PALLET_SELECT})`;

type RawMc = {
  id: string; consumption_date: string; shift: string | null; status: "draft" | "saved";
  production_run_id: string | null;
  production_run: { run_number: string; ipqc_record: { id: string } | { id: string }[] | null } | null;
  machine_entries: RawMcMachineEntry[];
};

const MC_DETAIL_SELECT =
  "id,consumption_date,shift,status,production_run_id," +
  "production_run:production_runs(run_number,ipqc_record:ipqc_records(id))," +
  `machine_entries:material_consumption_machine_entries(${MC_MACHINE_ENTRY_SELECT})`;

/** Row -> MaterialConsumptionPalletOut, matches serialize_mc_pallet() exactly. */
function mcFlattenPallet(row: RawMcPallet): import("./types").MaterialConsumptionPalletRow {
  return {
    id: row.id, role: row.role, pallet_id: row.pallet_id,
    pallet_display_id: row.pallet?.display_id ?? "",
    sku_code: row.pallet?.sku_code ?? null, sku_version: row.pallet?.sku_version ?? null,
    category: row.pallet?.category ?? null, quantity: row.quantity,
    status: (row.pallet?.lifecycle_status ?? "generated") as import("./types").MaterialConsumptionPalletRow["status"],
  };
}

function sortedBySortOrder<T extends { sort_order: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order);
}

/** entry -> MaterialConsumptionMachineEntryOut, matches serialize_mc_machine_entry() exactly. */
function mcFlattenEntry(entry: RawMcMachineEntry) {
  const pallets = sortedBySortOrder(entry.pallets || []);
  const secondary = { cfb: [] as import("./types").MaterialConsumptionPalletRow[], pad: [] as import("./types").MaterialConsumptionPalletRow[], glue: [] as import("./types").MaterialConsumptionPalletRow[], polybag: [] as import("./types").MaterialConsumptionPalletRow[] };
  for (const row of pallets) {
    if (row.role === "cfb" || row.role === "pad" || row.role === "glue" || row.role === "polybag") secondary[row.role].push(mcFlattenPallet(row));
  }
  return {
    id: entry.id, machine_id: entry.machine_id, machine: entry.machine?.code ?? null,
    category: entry.category, sku_code_id: entry.sku_code_id, sku_version_id: entry.sku_version_id,
    sku_code: entry.sku_code, sku_version: entry.sku_version, start_time: entry.start_time, end_time: entry.end_time,
    pallets: pallets.filter((p) => p.role === "primary").map(mcFlattenPallet),
    secondary_materials: secondary,
  };
}

/** mc -> MaterialConsumptionDetailOut, matches serialize_mc_detail() exactly. */
function flattenMcDetail(raw: RawMc): MaterialConsumptionDetail {
  const ipqc = raw.production_run?.ipqc_record ?? null;
  const ipqcId = Array.isArray(ipqc) ? ipqc[0]?.id ?? null : ipqc?.id ?? null;
  return {
    id: raw.id, consumption_date: raw.consumption_date, shift: raw.shift, status: raw.status,
    production_run_id: raw.production_run_id,
    production_run_number: raw.production_run?.run_number ?? null,
    ipqc_id: ipqcId,
    machine_entries: sortedBySortOrder(raw.machine_entries || []).map(mcFlattenEntry),
  };
}

/** mc -> MaterialConsumptionListItemOut, matches serialize_mc_list_item() exactly:
 * category/sku_code/sku_version come from the first machine entry that HAS a
 * category set (not necessarily entry #1); pallet_numbers/machine are
 * comma-joined across every entry's primary pallets/machines respectively. */
function flattenMcListItem(raw: RawMc): MaterialConsumptionListItem {
  const entries = sortedBySortOrder(raw.machine_entries || []);
  const allPrimary = entries.flatMap((e) => sortedBySortOrder(e.pallets || []).filter((p) => p.role === "primary"));
  const firstWithSku = entries.find((e) => e.category) ?? null;
  const machines = entries.filter((e) => e.machine).map((e) => e.machine!.code);
  return {
    id: raw.id, consumption_date: raw.consumption_date,
    category: firstWithSku?.category ?? null, sku_code: firstWithSku?.sku_code ?? null, sku_version: firstWithSku?.sku_version ?? null,
    pallet_numbers: allPrimary.map((p) => p.pallet?.display_id ?? "").join(", ") || "(none scanned)",
    machine: machines.join(", ") || null, shift: raw.shift,
    entries: entries.map((e) => ({ machine: e.machine?.code ?? null, start_time: e.start_time, end_time: e.end_time })),
    status: raw.status,
  };
}

async function listMaterialConsumptionSb(params: { search?: string; category?: string; date?: string; status?: string }): Promise<MaterialConsumptionListItem[]> {
  const { data, error } = await supabase
    .from("material_consumptions")
    .select(MC_DETAIL_SELECT)
    .order("created_at", { ascending: false });
  if (error) throw new ApiError(500, error.message);
  let recs = (data || []) as unknown as RawMc[];
  // Filtering replicates list_material_consumption()'s Python-side logic
  // exactly (not a Postgrest filter) since it spans nested machine_entries/
  // pallets and needs identical any(...) / substring semantics.
  if (params.category) recs = recs.filter((r) => r.machine_entries.some((e) => e.category === params.category));
  if (params.date) recs = recs.filter((r) => r.consumption_date === params.date);
  if (params.status) recs = recs.filter((r) => r.status === params.status);
  if (params.search) {
    const s = params.search.toLowerCase();
    recs = recs.filter((r) => {
      const haystack: string[] = [];
      for (const e of r.machine_entries) {
        haystack.push(e.sku_code || "", e.sku_version || "", e.category || "", e.machine?.code || "");
        for (const p of e.pallets) if (p.role === "primary") haystack.push(p.pallet?.display_id || "");
      }
      return haystack.some((h) => h.toLowerCase().includes(s));
    });
  }
  return recs.map(flattenMcListItem);
}

async function getMaterialConsumptionSb(id: string): Promise<MaterialConsumptionDetail> {
  const { data, error } = await supabase.from("material_consumptions").select(MC_DETAIL_SELECT).eq("id", id).single();
  if (error || !data) throw new ApiError(404, "Material Consumption record not found");
  return flattenMcDetail(data as unknown as RawMc);
}

// Sku_codes rows always come back with their versions embedded via
// PostgREST's nested-resource select -- matches the joinedload(versions)
// every FastAPI /skus and /reference/sku-codes route already did, with the
// exact same "all versions, not just active ones" shape (see LineItemsEditor,
// which itself does no active-filtering on the versions it's handed).
const SKU_SELECT = "id, code, category, is_active, versions:sku_versions(id, version, is_active)";

export const api = {
  me: () => request<MeResponse>("/api/v1/me"),

  // -- Phase 1: reference/master data, direct Supabase (RLS-enforced) -----
  skuCodes: (category?: string) =>
    sbRequest<SkuCode[]>(() => {
      let q = supabase.from("sku_codes").select(SKU_SELECT).eq("is_active", true);
      if (category) q = q.eq("category", category);
      return q.order("code") as unknown as Promise<{ data: SkuCode[] | null; error: { message: string; code?: string } | null }>;
    }),

  checklistItems: () =>
    sbRequest<ChecklistItemRef[]>(() =>
      supabase
        .from("inward_vehicle_inspection_checklist_items")
        .select("id, label, sort_order")
        .eq("is_active", true)
        .order("sort_order") as unknown as Promise<{ data: ChecklistItemRef[] | null; error: { message: string; code?: string } | null }>
    ),

  vendors: (params?: { category?: string; includeInactive?: boolean }) =>
    sbRequest<Vendor[]>(() => {
      let q = supabase.from("vendors").select("id, category, name, country, is_active");
      if (params?.category) q = q.eq("category", params.category);
      if (!params?.includeInactive) q = q.eq("is_active", true);
      return q.order("category").order("name") as unknown as Promise<{ data: Vendor[] | null; error: { message: string; code?: string } | null }>;
    }),

  skus: (params?: { category?: string; includeInactive?: boolean }) =>
    sbRequest<SkuCode[]>(() => {
      let q = supabase.from("sku_codes").select(SKU_SELECT);
      if (params?.category) q = q.eq("category", params.category);
      if (!params?.includeInactive) q = q.eq("is_active", true);
      return q.order("category").order("code") as unknown as Promise<{ data: SkuCode[] | null; error: { message: string; code?: string } | null }>;
    }),
  createSku: (category: string, code: string) =>
    sbVoid(
      () => supabase.from("sku_codes").insert({ category, code, is_active: true }),
      { conflict: `"${code}" already exists.` }
    ),
  updateSku: (id: string, patch: { code?: string; is_active?: boolean }) =>
    sbVoid(
      () => supabase.from("sku_codes").update(patch).eq("id", id),
      { conflict: `"${patch.code}" already exists.` }
    ),
  deleteSku: (id: string) =>
    sbVoid(
      () => supabase.from("sku_codes").delete().eq("id", id),
      { fk: "This SKU is referenced by existing records and can't be deleted — deactivate it instead." }
    ),
  addSkuVersion: (skuId: string, version: string) =>
    sbVoid(
      () => supabase.from("sku_versions").insert({ sku_code_id: skuId, version, is_active: true }),
      { conflict: `Version "${version}" already exists for this SKU.` }
    ),
  updateSkuVersion: (versionId: string, patch: { version?: string; is_active?: boolean }) =>
    sbVoid(
      () => supabase.from("sku_versions").update(patch).eq("id", versionId),
      { conflict: `Version "${patch.version}" already exists for this SKU.` }
    ),
  deleteSkuVersion: (versionId: string) =>
    sbVoid(
      () => supabase.from("sku_versions").delete().eq("id", versionId),
      { fk: "This version is referenced by existing records and can't be deleted — deactivate it instead." }
    ),
  // Unlike every other Phase 1 mutation, this one's return value is used
  // directly (Wizard.tsx's inline "add a new vendor" flow appends it to
  // the dropdown and selects it without a full refetch) -- so this is the
  // one create/update call that needs `.select().single()` chained rather
  // than the fire-and-forget sbVoid the admin screen's own equivalent call
  // uses.
  createVendor: (category: Category, name: string, country: string) =>
    sbRequest<Vendor>(
      () => supabase.from("vendors").insert({ category, name, country, is_active: true }).select("id, category, name, country, is_active").single() as unknown as Promise<{ data: Vendor | null; error: { message: string; code?: string } | null }>,
      { conflict: `"${name}" already exists for this category.` }
    ),
  updateVendor: (id: string, patch: { name?: string; country?: string; is_active?: boolean }) =>
    sbVoid(
      () => supabase.from("vendors").update(patch).eq("id", id),
      { conflict: `"${patch.name}" already exists for this category.` }
    ),
  deleteVendor: (id: string) =>
    sbVoid(
      () => supabase.from("vendors").delete().eq("id", id),
      { fk: "This vendor is referenced by existing records and can't be deleted — deactivate it instead." }
    ),

  // -- Phase 2: Inward Vehicle Inspection list/detail, direct Supabase ----
  listInspections: async (params: { search?: string; status?: string; category?: string; date?: string }) => {
    const base = supabase
      .from("inward_vehicle_inspections")
      .select("id,shipment_number,invoice_number,container_number,status,category,created_at", { count: "exact" });
    const filtered = applyIviFilters(base as unknown as PgQuery, params);
    const ordered = (filtered as unknown as typeof base).order("created_at", { ascending: false }).range(0, 49);
    const { data, error, count } = await ordered;
    if (error) throw new ApiError(500, error.message);
    const total_count = await countAll("inward_vehicle_inspections");
    return { items: (data || []) as InspectionListItem[], matched_count: count ?? 0, total_count };
  },

  createDraft: (category: Category) =>
    request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/draft?category=${category}`, { method: "POST" }),

  getInspection: (id: string) =>
    sbRequest<InspectionDetail>(async () => {
      const [{ data: inspection, error }, { data: checklistItems }, { data: linkedQc }] = await Promise.all([
        supabase
          .from("inward_vehicle_inspections")
          .select(
            "id,shipment_number,is_auto_shipment_number,category,truck_number,container_number,vendor_name," +
              "invoice_number,transporter_name,seal_number,total_quantity,inspection_passed_quantity,remarks," +
              "status,created_at,updated_at," +
              "line_items:inward_vehicle_inspection_line_items(id,sku_code_id,sku_version_id,quantity,sku_code:sku_codes(code),sku_version:sku_versions(version))," +
              "images:inward_vehicle_inspection_images(id,image_type,public_url,ocr_extracted_value,ocr_confidence,ocr_status,sort_order)," +
              "checklist_answers:inward_vehicle_inspection_checklist_answers(checklist_item_id,answer)"
          )
          .eq("id", id)
          .single(),
        supabase.from("inward_vehicle_inspection_checklist_items").select("id,label,sort_order").eq("is_active", true).order("sort_order"),
        supabase.from("inward_qc_records").select("id,shipment_number").eq("linked_vehicle_inspection_id", id).limit(1),
      ]);
      if (error || !inspection) return { data: null, error: error || { message: "Inward Vehicle Inspection record not found." } };
      // line_items' embedded sku_code/sku_version come back as {code}/{version}
      // objects (or null) -- flatten to the plain string shape InspectionDetail
      // expects, matching LineItemOut's sku_code/sku_version fields exactly.
      type RawLineItem = { id: string; sku_code_id: string | null; sku_version_id: string | null; quantity: string | number; sku_code: { code: string } | null; sku_version: { version: string } | null };
      const rawInspection = inspection as unknown as Record<string, unknown>;
      const line_items = ((rawInspection.line_items as RawLineItem[]) || []).map((li) => ({
        id: li.id, sku_code_id: li.sku_code_id, sku_version_id: li.sku_version_id, quantity: li.quantity,
        sku_code: li.sku_code?.code ?? null, sku_version: li.sku_version?.version ?? null,
      }));
      // checklist_answers must list every active checklist item -- including
      // ones this inspection has never answered -- exactly like the old
      // FastAPI route's merge-against-checklist_items loop (answer: null for
      // anything not yet answered), not just the rows that happen to exist.
      const answersByItem = new Map(((rawInspection.checklist_answers as { checklist_item_id: string; answer: "ok" | "not_ok" | null }[]) || []).map((a) => [a.checklist_item_id, a.answer]));
      const checklist_answers: InspectionDetail["checklist_answers"] = (checklistItems || []).map((ci) => ({
        checklist_item_id: ci.id, label: ci.label, answer: answersByItem.get(ci.id) ?? null,
      }));
      const linked = (linkedQc || [])[0] as { id: string; shipment_number: string } | undefined;
      const result: InspectionDetail = {
        ...(rawInspection as unknown as InspectionDetail),
        line_items,
        checklist_answers,
        linked_qc_id: linked?.id ?? null,
        linked_qc_shipment_number: linked?.shipment_number ?? null,
      };
      return { data: result, error: null };
    }),

  updateInspection: (id: string, payload: Record<string, unknown>) =>
    request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  saveChecklist: (id: string, answers: Record<string, "ok" | "not_ok">) =>
    request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/${id}/checklist`, {
      method: "PUT",
      body: JSON.stringify({ answers }),
    }),

  submit: (id: string) =>
    request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/${id}/submit`, { method: "POST" }),

  saveDraft: (id: string) =>
    request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/${id}/save-draft`, { method: "POST" }),

  discardIfBlank: (id: string) =>
    request<void>(`/api/v1/inward-vehicle-inspections/${id}/if-blank`, { method: "DELETE" }),

  deleteInspection: (id: string) =>
    request<{ deleted: boolean }>(`/api/v1/inward-vehicle-inspections/${id}`, { method: "DELETE" }),

  uploadImage: (id: string, imageType: ImageType, file: File) => {
    const form = new FormData();
    form.append("image_type", imageType);
    form.append("file", file);
    return request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/${id}/images`, {
      method: "POST",
      body: form,
    });
  },

  replaceImage: (id: string, imageId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/${id}/images/${imageId}`, {
      method: "PUT",
      body: form,
    });
  },

  deleteImage: (id: string, imageId: string) =>
    request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/${id}/images/${imageId}`, { method: "DELETE" }),

  mediaUrl: (path: string) => (path.startsWith("http") ? path : `${BASE}${path}`),

  // -- Inward QC --------------------------------------------------------
  qcMeta: () => request<QcMeta>("/api/v1/inward-qc/meta"),

  // getQc (the detail read that seeds the QC edit flow) deliberately stays
  // on FastAPI: QcDetailOut's coa_url is built from a bare storage path
  // whose URL shape depends on which storage adapter is live
  // (`/media/<path>` locally vs. a real Supabase Storage public URL in
  // production -- see the "swap this... once Supabase Storage is live"
  // note in inward_qc.py's _serialize_detail), and every mutation on that
  // same detail (COA upload, attribute save, submit) already round-trips
  // through FastAPI and returns its own freshly built coa_url. Switching
  // only the initial read risks a URL-shape mismatch FastAPI itself
  // hasn't resolved yet; listQc has no coa_url field at all, so it's free
  // of that ambiguity.
  listQc: async (params: { search?: string; status?: string; category?: string; date?: string }) => {
    const base = supabase
      .from("inward_qc_records")
      .select("id,shipment_number,category,coa_filename,status,created_at", { count: "exact" });
    const filtered = applyListFilters(base as unknown as PgQuery, params, ["shipment_number"]);
    const ordered = (filtered as unknown as typeof base).order("created_at", { ascending: false }).range(0, 49);
    const { data, error, count } = await ordered;
    if (error) throw new ApiError(500, error.message);
    const total_count = await countAll("inward_qc_records");
    return { items: (data || []) as QcListItem[], matched_count: count ?? 0, total_count };
  },

  createQcDraft: (category: QcManualCategory) =>
    request<QcDetail>(`/api/v1/inward-qc/draft?category=${category}`, { method: "POST" }),

  getQc: (id: string) => request<QcDetail>(`/api/v1/inward-qc/${id}`),

  updateQcBasic: (id: string, payload: Record<string, unknown>) =>
    request<QcDetail>(`/api/v1/inward-qc/${id}`, { method: "PUT", body: JSON.stringify(payload) }),

  uploadQcCoa: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<QcDetail>(`/api/v1/inward-qc/${id}/coa`, { method: "POST", body: form });
  },

  deleteQcCoa: (id: string) => request<QcDetail>(`/api/v1/inward-qc/${id}/coa`, { method: "DELETE" }),

  saveFgtrayAnswers: (id: string, answers: { criteria_id: string; answer: "ok" | "not_ok" | null; remarks?: string | null }[]) =>
    request<QcDetail>(`/api/v1/inward-qc/${id}/fgtray-answers`, { method: "PUT", body: JSON.stringify(answers) }),

  saveQcAttributes: (
    id: string,
    values: { attribute_definition_id: string; value: string | null }[],
    conclusionOrSuggestions: string
  ) =>
    request<QcDetail>(
      `/api/v1/inward-qc/${id}/attributes?conclusion_or_suggestions=${encodeURIComponent(conclusionOrSuggestions)}`,
      { method: "PUT", body: JSON.stringify(values) }
    ),

  saveQcDraft: (id: string) => request<QcDetail>(`/api/v1/inward-qc/${id}/save-draft`, { method: "POST" }),

  submitQc: (id: string) => request<QcDetail>(`/api/v1/inward-qc/${id}/submit`, { method: "POST" }),

  discardQcIfBlank: (id: string) => request<void>(`/api/v1/inward-qc/${id}/if-blank`, { method: "DELETE" }),

  deleteQc: (id: string) => request<{ deleted: boolean }>(`/api/v1/inward-qc/${id}`, { method: "DELETE" }),

  // -- RM QR Generation --------------------------------------------------
  listRmQr: async (params: { search?: string; date?: string; sku?: string } = {}) =>
    sbRequest<QrGenerationListItem[]>(() => qrListQuery("rm", params) as unknown as Promise<{ data: QrGenerationListItem[] | null; error: { message: string; code?: string } | null }>),
  getRmQr: (id: string) => qrGetDetail("rm", id),
  generateRmQr: (id: string) => request<QrGenerationDetail>(`/api/v1/rm-qr/${id}/generate`, { method: "POST" }),
  deleteRmQr: (id: string) => request<{ ok: boolean }>(`/api/v1/rm-qr/${id}`, { method: "DELETE" }),

  // -- FG QR Generation --------------------------------------------------
  listFgQr: async (params: { search?: string; date?: string; sku?: string } = {}) =>
    sbRequest<QrGenerationListItem[]>(() => qrListQuery("fg", params) as unknown as Promise<{ data: QrGenerationListItem[] | null; error: { message: string; code?: string } | null }>),
  getFgQr: (id: string) => qrGetDetail("fg", id),
  generateFgQr: (id: string) => request<QrGenerationDetail>(`/api/v1/fg-qr/${id}/generate`, { method: "POST" }),
  deleteFgQr: (id: string) => request<{ ok: boolean }>(`/api/v1/fg-qr/${id}`, { method: "DELETE" }),
  createFgQrFromRun: (runId: string) => request<QrGenerationDetail>(`/api/v1/fg-qr/from-production-run/${runId}`, { method: "POST" }),

  // -- Production Runs (minimal, feeds FG QR Generation) ------------------
  listProductionRuns: () => request<ProductionRun[]>("/api/v1/production-runs"),

  // -- RM Storage ----------------------------------------------------------
  listRmPending: (params: { search?: string; sku?: string } = {}) => pendingPalletsQuery("rm", params),
  listRmStorageRecords: (search = "") => storageRecordsQuery("rm", search),
  getRmStorageRecord: (id: string) => storageRecordDetail("rm", id),
  scanRmPallet: (payload: string) => request<Pallet>("/api/v1/rm-storage/scan-pallet", { method: "POST", body: JSON.stringify({ payload }) }),
  scanRmLocation: (payload: string) => request<{ id: string; display_id: string; zone: string }>("/api/v1/rm-storage/scan-location", { method: "POST", body: JSON.stringify({ payload }) }),
  confirmRmStorage: (palletPayload: string, locationPayload: string) =>
    request<StorageRecordDetail>("/api/v1/rm-storage/confirm", { method: "POST", body: JSON.stringify({ pallet_payload: palletPayload, location_payload: locationPayload }) }),

  // -- FG Storage ------------------------------------------------------------
  listFgPending: (params: { search?: string; sku?: string } = {}) => pendingPalletsQuery("fg", params),
  listFgStorageRecords: (search = "") => storageRecordsQuery("fg", search),
  getFgStorageRecord: (id: string) => storageRecordDetail("fg", id),
  scanFgPallet: (payload: string) => request<Pallet>("/api/v1/fg-storage/scan-pallet", { method: "POST", body: JSON.stringify({ payload }) }),
  scanFgLocation: (payload: string) => request<{ id: string; display_id: string; zone: string }>("/api/v1/fg-storage/scan-location", { method: "POST", body: JSON.stringify({ payload }) }),
  confirmFgStorage: (palletPayload: string, locationPayload: string) =>
    request<StorageRecordDetail>("/api/v1/fg-storage/confirm", { method: "POST", body: JSON.stringify({ pallet_payload: palletPayload, location_payload: locationPayload }) }),

  // -- Locations (reference, shared by RM + FG storage) --------------------
  // Every location is seeded once via migration with its QR already
  // generated (no `models.Location(...)` create path exists anywhere in
  // the app), so the lazy "generate QR on first read" side effect the old
  // FastAPI route had is a permanent no-op today -- confirmed against the
  // real dev DB (all 15 rows already carry qr_public_url) -- and dropping
  // it here loses nothing.
  listLocations: () =>
    sbRequest<LocationRef[]>(() =>
      supabase
        .from("locations")
        .select("id, display_id, zone, qr_url:qr_public_url")
        .eq("is_active", true)
        .order("display_id") as unknown as Promise<{ data: LocationRef[] | null; error: { message: string; code?: string } | null }>
    ),

  // -- Machines (master data for Material Consumption) ---------------------
  machines: (includeInactive = false) =>
    sbRequest<Machine[]>(() => {
      let q = supabase.from("machines").select("id, code, is_active");
      if (!includeInactive) q = q.eq("is_active", true);
      return q.order("code") as unknown as Promise<{ data: Machine[] | null; error: { message: string; code?: string } | null }>;
    }),
  createMachine: (code: string) =>
    sbVoid(
      () => supabase.from("machines").insert({ code, is_active: true }),
      { conflict: `"${code}" already exists.` }
    ),
  updateMachine: (id: string, patch: { code?: string; is_active?: boolean }) =>
    sbVoid(
      () => supabase.from("machines").update(patch).eq("id", id),
      { conflict: `"${patch.code}" already exists.` }
    ),
  deleteMachine: (id: string) =>
    sbVoid(
      () => supabase.from("machines").delete().eq("id", id),
      { fk: "This machine is referenced by an existing Material Consumption or Production record and cannot be deleted. Deactivate it instead." }
    ),

  // -- Material Consumption -------------------------------------------------
  // list/detail go direct to Supabase (Phase 2); every draft/scan/finalize
  // write below stays on FastAPI, unchanged.
  listMaterialConsumption: (params: { search?: string; category?: string; date?: string; status?: string } = {}) =>
    listMaterialConsumptionSb(params),
  materialConsumptionShifts: () => request<string[]>("/api/v1/material-consumption/shifts"),
  createMaterialConsumptionDraft: () =>
    request<MaterialConsumptionDetail>("/api/v1/material-consumption/draft", { method: "POST" }),
  getMaterialConsumption: (id: string) => getMaterialConsumptionSb(id),
  updateMaterialConsumptionBasic: (id: string, patch: { shift?: string }) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/basic`, { method: "PUT", body: JSON.stringify(patch) }),
  addMaterialConsumptionMachineEntry: (id: string, machineId?: string | null) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/machine-entries`, { method: "POST", body: JSON.stringify({ machine_id: machineId ?? null }) }),
  removeMaterialConsumptionMachineEntry: (id: string, entryId: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/machine-entries/${entryId}`, { method: "DELETE" }),
  setMaterialConsumptionMachineEntryMachine: (id: string, entryId: string, machineId: string | null) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/machine-entries/${entryId}`, { method: "PUT", body: JSON.stringify({ machine_id: machineId }) }),
  scanMaterialConsumptionPallet: (id: string, entryId: string, payload: string, clientTime?: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/machine-entries/${entryId}/scan-pallet`, { method: "POST", body: JSON.stringify({ payload, client_time: clientTime }) }),
  scanMaterialConsumptionSecondary: (id: string, entryId: string, payload: string, category: SecondaryMaterialCategory) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/machine-entries/${entryId}/scan-secondary`, { method: "POST", body: JSON.stringify({ payload, category }) }),
  recordMaterialConsumptionEntryEndTime: (id: string, entryId: string, endTime: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/machine-entries/${entryId}/end-time`, { method: "PUT", body: JSON.stringify({ end_time: endTime }) }),
  removeMaterialConsumptionPallet: (id: string, rowId: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/pallets/${rowId}`, { method: "DELETE" }),
  setMaterialConsumptionPalletQuantity: (id: string, rowId: string, quantity: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/pallets/${rowId}/quantity`, { method: "PUT", body: JSON.stringify({ quantity }) }),
  saveMaterialConsumptionDraft: (id: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/save-draft`, { method: "POST" }),
  finalizeMaterialConsumption: (id: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/finalize`, { method: "POST" }),
  discardMaterialConsumptionIfBlank: (id: string) =>
    request<void>(`/api/v1/material-consumption/${id}/if-blank`, { method: "DELETE" }),
  deleteMaterialConsumption: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/material-consumption/${id}`, { method: "DELETE" }),
};
