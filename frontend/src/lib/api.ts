import { getAuthHeader } from "./session";
import { supabase } from "./supabaseClient";
import { cachedList, invalidateListCache, listCacheKey } from "./listCache";
import type {
  InspectionDetail, InspectionListItem, SkuCode, SkuVersion, ChecklistItemRef, MeResponse, Category, ImageType,
  QcMeta, QcListItem, QcDetail, QcManualCategory, QcAttributeDefinition, QcFgtrayCriterion, QcSamplingPlanTier,
  Pallet, QrGenerationListItem, QrGenerationDetail, StorageRecordDetail, LocationRef, ProductionRun,
  Vendor, Machine, MaterialConsumptionListItem, MaterialConsumptionDetail, SecondaryMaterialCategory,
  MaterialConsumptionPalletRow, ProductionListItem, ProductionDetail, ProductionMachineEntry, ProductionSavePayload,
  IpqcListItem, IpqcDetail, IpqcSavePayload,
  RqcListItem, RqcDetail, RqcSavePayload,
  CustomerShipmentListItem, CustomerShipmentDetail, CustomerShipmentCreatePayload, CustomerShipmentCreateResult,
  ShipmentPickingListItem, ShipmentPickingDetail,
  AppUser, UserCreateInput, UserUpdateInput,
} from "./types";

// Static, never-changing business constants -- mirrored 1:1 from
// backend/app/domain/inward_qc_service.py's own hardcoded Python dicts
// (MANUAL_CATEGORIES, QC_COUNT_LABEL, CONCLUSION_LABEL). These never touch
// the DB on the backend either; GET /api/v1/inward-qc/meta was serving them
// over the network alongside three real table reads for no reason other
// than convenience of returning one bundled object.
// Alphabetical -- matches the backend's own `sorted(svc.MANUAL_CATEGORIES)`
// exactly, since CategoryPicker renders these in array order and a
// different order here would be a visible (if minor) UI change.
const QC_MANUAL_CATEGORIES: QcManualCategory[] = ["cfb", "glue", "pad", "polybag"];
const QC_COUNT_LABEL: Record<QcManualCategory, string> = {
  pad: "Number of pads to be checked", polybag: "Number of bags to be checked",
  cfb: "Number of bags to be checked", glue: "Number of units to be checked",
};
const QC_CONCLUSION_LABEL: Record<QcManualCategory, string> = {
  pad: "Suggestions", polybag: "Conclusion", cfb: "Conclusion", glue: "Conclusion",
};

// Reference/master data (machines, vendors, SKUs) changes only through the
// admin screens and is read on nearly every module's mount (Production and
// Material Consumption both fetch `machines`, the Inward Vehicle Inspection
// wizard fetches `vendors` per category, etc.) -- before this, every one of
// those mounts paid a full network round trip for data that's effectively
// static minute-to-minute. Same cachedList/staleMs convention already used
// for Inward QC's/Inward Vehicle Inspection's meta reads (see those
// page.tsx files' own REFERENCE_STALE_MS), just centralized here in api.ts
// so every caller of machines()/vendors()/skus() benefits without each page
// having to know caching exists. `ref:*`-prefixed keys are invalidated by
// the matching admin-screen create/update/delete mutation below, so an
// edit on /machines, /vendors, or /skus is visible on the very next read
// instead of waiting out the stale window.
const REFERENCE_STALE_MS = 5 * 60_000;

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

/** Default page size for every paginated list fetch below (Supabase
 * `.range()` and the FastAPI `page_size` query param alike) -- matches the
 * `inward_qc.py`/`inward_vehicle_inspections.py` reference pattern
 * (PERF_AUDIT.md findings #1-#6). */
const LIST_PAGE_SIZE = 50;

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

/** Same as `sbRequest`, but for a paginated `.range()` list query -- also
 * surfaces PostgREST's `{ count: "exact" }` total alongside the page of
 * rows, so callers can render "Showing X of Y" against the real filtered
 * total instead of `rows.length` (which is capped at the page size). */
async function sbRequestPage<T>(
  fn: () => Promise<{ data: T[] | null; error: { message: string; code?: string } | null; count: number | null }>
): Promise<{ items: T[]; matched_count: number }> {
  const { data, error, count } = await fn();
  if (error) throw new ApiError(500, error.message);
  const items = data || [];
  return { items, matched_count: count ?? items.length };
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

function qrListQuery(qrType: "rm" | "fg", params: { search?: string; date?: string; sku?: string; page?: number }) {
  const page = params.page && params.page > 0 ? params.page : 1;
  let q = supabase
    .from("qr_generation_records")
    .select("id,batch_display_id,qr_type,shipment_number,sku_code_snapshot,sku_version_snapshot,country_code,quantity,status,created_at", { count: "exact" })
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
  return q.order("created_at", { ascending: false }).range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
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

async function pendingPalletsQuery(
  palletType: "rm" | "fg",
  params: { search?: string; sku?: string; page?: number }
): Promise<{ items: Pallet[]; matched_count: number }> {
  const page = params.page && params.page > 0 ? params.page : 1;
  let q = supabase
    .from("pallets")
    .select(PALLET_SELECT, { count: "exact" })
    .eq("pallet_type", palletType)
    .eq("lifecycle_status", "pending_storage");
  // sku is an exact match against the SKU snapshot (mirrors `p.sku_code_snapshot == sku`
  // in list_pending -- not a substring filter, unlike `search`).
  if (params.sku) q = q.eq("sku_code_snapshot", params.sku);
  if (params.search) {
    const like = ilikeTerm(params.search);
    q = q.or(`display_id.ilike.${like},sku_code_snapshot.ilike.${like}`);
  }
  const { data, error, count } = await q.order("created_at").range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
  if (error) throw new ApiError(500, error.message);
  const rows = ((data || []) as unknown as RawPallet[]).map(flattenPallet);
  return { items: rows, matched_count: count ?? rows.length };
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

async function storageRecordsQuery(
  storageType: "rm" | "fg",
  search: string,
  page = 1
): Promise<{ items: StorageRecordDetail[]; matched_count: number }> {
  // pallet_display_id/sku_code_snapshot live on the embedded `pallets`
  // resource -- `!inner` turns the embed into a real join so `.or()` can
  // filter the PARENT (storage_records) rows by it server-side, instead of
  // fetching the whole table and substring-matching in the browser.
  const selectClause = search ? STORAGE_RECORD_SELECT.replace("pallet:pallets(", "pallet:pallets!inner(") : STORAGE_RECORD_SELECT;
  let q = supabase
    .from("storage_records")
    .select(selectClause, { count: "exact" })
    .eq("storage_type", storageType);
  if (search) {
    const like = ilikeTerm(search);
    q = q.or(`display_id.ilike.${like},sku_code_snapshot.ilike.${like}`, { foreignTable: "pallets" });
  }
  const { data, error, count } = await q.order("stored_at", { ascending: false }).range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
  if (error) throw new ApiError(500, error.message);
  const rows = ((data || []) as unknown as RawStorageRecord[]).map(flattenStorageRecord);
  return { items: rows, matched_count: count ?? rows.length };
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

/** `MC_DETAIL_SELECT`'s embed of `material_consumption_machine_entries` as
 * `!inner` -- turns the embed into a real join Postgrest can filter the
 * PARENT (material_consumptions) rows by, instead of the old
 * fetch-everything-then-Array.filter() approach. */
const MC_DETAIL_SELECT_INNER = MC_DETAIL_SELECT.replace(
  "machine_entries:material_consumption_machine_entries(",
  "machine_entries:material_consumption_machine_entries!inner("
);

// `flattenMcListItem` above only ever reads, per machine entry: category,
// sku_code/sku_version (snapshots), machine.code, start_time, end_time, and
// sort_order (to order entries); per pallet: role, sort_order, and
// pallet.display_id. It never reads either level's own `id`, the raw
// machine_id/sku_code_id/sku_version_id, pallet quantity, or the pallet's
// own sku_code/sku_version/category/lifecycle_status -- all of that is
// MC_DETAIL_SELECT-only data that only the single-record detail view
// (getMaterialConsumptionSb) needs. The list also never reads
// production_run/production_run_id (ipqc_id and production_run_number are
// MaterialConsumptionDetail-only fields), so that embed is dropped too.
// Trimming the list's own select to exactly this shape removes 4 unused
// columns per pallet, 4 per machine entry, and an entire extra join
// (production_runs -> ipqc_records) from every list-page row.
const MC_LIST_PALLET_SELECT = "role,sort_order,pallet:pallets(display_id)";
const MC_LIST_ENTRY_SELECT =
  "machine:machines(code),category,sku_code:sku_code_snapshot,sku_version:sku_version_snapshot,start_time,end_time,sort_order," +
  `pallets:material_consumption_pallets(${MC_LIST_PALLET_SELECT})`;
const MC_LIST_SELECT =
  "id,consumption_date,shift,status," +
  `machine_entries:material_consumption_machine_entries(${MC_LIST_ENTRY_SELECT})`;
const MC_LIST_SELECT_INNER = MC_LIST_SELECT.replace(
  "machine_entries:material_consumption_machine_entries(",
  "machine_entries:material_consumption_machine_entries!inner("
);

async function listMaterialConsumptionSb(
  params: { search?: string; category?: string; date?: string; status?: string; page?: number }
): Promise<{ items: MaterialConsumptionListItem[]; matched_count: number }> {
  const page = params.page && params.page > 0 ? params.page : 1;
  // category/search need to filter by columns on the nested machine_entries
  // resource, so the embed switches to `!inner` (a real join) only when one
  // of those is active -- status/date alone stay on the plain embed since
  // they're columns on material_consumptions itself.
  const needsEntryJoin = !!(params.category || params.search);
  let q = supabase
    .from("material_consumptions")
    .select(needsEntryJoin ? MC_LIST_SELECT_INNER : MC_LIST_SELECT, { count: "exact" });
  if (params.status) q = q.eq("status", params.status);
  if (params.date) q = q.eq("consumption_date", params.date);
  if (params.category) q = q.eq("material_consumption_machine_entries.category", params.category);
  if (params.search) {
    const like = ilikeTerm(params.search);
    // Covers SKU code/version/category on the machine entry -- the primary
    // pallet display_id and machine code live two embed levels down
    // (machine_entries -> pallets -> pallet / machine_entries -> machine),
    // which Postgrest's single-level `.or(foreignTable:)` can't reach in
    // one filter; those two fields fall back to a client-side pass over
    // just the current page (50 rows, not the whole table) below.
    q = q.or(
      `sku_code_snapshot.ilike.${like},sku_version_snapshot.ilike.${like},category.ilike.${like}`,
      { foreignTable: "material_consumption_machine_entries" }
    );
  }
  const { data, error, count } = await q.order("created_at", { ascending: false }).range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
  if (error) throw new ApiError(500, error.message);
  let recs = (data || []) as unknown as RawMc[];
  if (params.search) {
    const s = params.search.toLowerCase();
    const alreadyMatchedByEntry = (r: RawMc) =>
      r.machine_entries.some(
        (e) => (e.sku_code || "").toLowerCase().includes(s) || (e.sku_version || "").toLowerCase().includes(s) || (e.category || "").toLowerCase().includes(s)
      );
    recs = recs.filter((r) => {
      if (alreadyMatchedByEntry(r)) return true;
      for (const e of r.machine_entries) {
        if ((e.machine?.code || "").toLowerCase().includes(s)) return true;
        for (const p of e.pallets) if (p.role === "primary" && (p.pallet?.display_id || "").toLowerCase().includes(s)) return true;
      }
      return false;
    });
  }
  return { items: recs.map(flattenMcListItem), matched_count: count ?? recs.length };
}

async function getMaterialConsumptionSb(id: string): Promise<MaterialConsumptionDetail> {
  const { data, error } = await supabase.from("material_consumptions").select(MC_DETAIL_SELECT).eq("id", id).single();
  if (error || !data) throw new ApiError(404, "Material Consumption record not found");
  return flattenMcDetail(data as unknown as RawMc);
}

// -- Production: read-only, direct Supabase -------------------------------
// Every Production Run is auto-created by Material Consumption's finalize()
// (find_or_create_production_run in material_consumption_service.py) --
// there is no manual "New Record" flow and therefore no write function
// here at all. "Machines" on the list comes from production_run_machines
// (visible independent of Material Consumption view permission, same as
// the run itself); the per-machine drill-down on the detail view comes
// from the linked material_consumptions -> machine_entries (gracefully
// empty if the viewer can't see Material Consumption data).

type RawProdMcPalletShallow = { role: string; pallet: { shipment_number: string | null } | null };
type RawProdMcShallowEntry = {
  pallets: RawProdMcPalletShallow[];
  sku_version_ref: { prod_total_pcs_per_pallet: number | null } | null;
};
type RawProdMcShallow = { machine_entries: RawProdMcShallowEntry[] };

type RawProductionRunList = {
  id: string; run_number: string; shipment_number: string | null; shift: string | null;
  production_date: string | null; status: string;
  sku_code: { code: string } | null;
  machines: { machine: { code: string } | null }[];
  created_by_user: { full_name: string } | null;
  material_consumptions: RawProdMcShallow[];
  rejection_damage: number | string; rejection_misplaced_glue: number | string;
  rejection_misplaced_pad: number | string; rejection_glue_on_pad: number | string;
  rejection_pad_placement_direction: number | string; rejection_adhesion_issue: number | string;
};

const PRODUCTION_LIST_SELECT =
  "id,run_number,shipment_number,shift,production_date,status," +
  "rejection_damage,rejection_misplaced_glue,rejection_misplaced_pad,rejection_glue_on_pad,rejection_pad_placement_direction,rejection_adhesion_issue," +
  "sku_code:sku_codes(code)," +
  "machines:production_run_machines(machine:machines(code))," +
  "created_by_user:app_users!production_runs_created_by_fkey(full_name)," +
  "material_consumptions(machine_entries:material_consumption_machine_entries(pallets:material_consumption_pallets(role,pallet:pallets(shipment_number)),sku_version_ref:sku_versions(prod_total_pcs_per_pallet)))";

function sumRejections(raw: {
  rejection_damage: number | string; rejection_misplaced_glue: number | string; rejection_misplaced_pad: number | string;
  rejection_glue_on_pad: number | string; rejection_pad_placement_direction: number | string; rejection_adhesion_issue: number | string;
}): number {
  return [
    raw.rejection_damage, raw.rejection_misplaced_glue, raw.rejection_misplaced_pad,
    raw.rejection_glue_on_pad, raw.rejection_pad_placement_direction, raw.rejection_adhesion_issue,
  ].reduce((sum: number, v) => sum + (Number(v) || 0), 0);
}

/** Total PCS/Pallet for a run's list row: sum of each distinct machine
 * entry's SKU-derived Production Details value -- one machine, one SKU
 * Version's worth of pcs/pallet, summed across every machine on the run. */
function sumTotalPcsPerPallet(mcs: RawProdMcShallow[]): number | null {
  let total = 0;
  let any = false;
  for (const mc of mcs || []) {
    for (const e of mc.machine_entries || []) {
      const v = e.sku_version_ref?.prod_total_pcs_per_pallet;
      if (v != null) { total += Number(v) || 0; any = true; }
    }
  }
  return any ? total : null;
}

/** Production Runs never store their own shipment number (nothing in the
 * current workflow enters one) -- but every primary pallet a linked
 * Material Consumption entry consumed carries its own shipment_number
 * snapshot, so it's derivable through the existing FK chain rather than
 * left blank when it doesn't have to be. */
function deriveShipmentNumber(mcs: RawProdMcShallow[]): string | null {
  for (const mc of mcs || []) {
    for (const e of mc.machine_entries || []) {
      for (const p of e.pallets || []) {
        if (p.role === "primary" && p.pallet?.shipment_number) return p.pallet.shipment_number;
      }
    }
  }
  return null;
}

function flattenProductionListItem(raw: RawProductionRunList): ProductionListItem {
  return {
    id: raw.id, run_number: raw.run_number,
    shipment_number: raw.shipment_number ?? deriveShipmentNumber(raw.material_consumptions),
    machines: (raw.machines || []).filter((m) => m.machine).map((m) => m.machine!.code).join(", "),
    shift: raw.shift, sku_code: raw.sku_code?.code ?? null,
    operator: raw.created_by_user?.full_name ?? null,
    status: raw.status, date: raw.production_date,
    total_pcs_per_pallet: sumTotalPcsPerPallet(raw.material_consumptions),
    total_rejections: sumRejections(raw),
  };
}

/** `production_runs`'s `sku_code`/`created_by_user` embeds as `!inner` for
 * server-side `.or()` search across those two (one-level-deep, so a real
 * Postgrest join filter reaches them cleanly); `machines`/
 * `material_consumptions` stay two levels deep and can't be reached by a
 * single-level `.or(foreignTable:)` filter, so a `machine` filter and the
 * "search matches a machine code" case are applied client-side below --
 * over just the current page (`LIST_PAGE_SIZE` rows), not the whole table. */
const PRODUCTION_LIST_SELECT_INNER = PRODUCTION_LIST_SELECT
  .replace("sku_code:sku_codes(code)", "sku_code:sku_codes!inner(code)")
  .replace("created_by_user:app_users!production_runs_created_by_fkey(full_name)", "created_by_user:app_users!production_runs_created_by_fkey!inner(full_name)");

async function listProductionSb(
  params: { search?: string; date?: string; shift?: string; machine?: string; page?: number } = {}
): Promise<{ items: ProductionListItem[]; matched_count: number }> {
  const page = params.page && params.page > 0 ? params.page : 1;
  const needsJoin = !!params.search;
  let q = supabase.from("production_runs").select(needsJoin ? PRODUCTION_LIST_SELECT_INNER : PRODUCTION_LIST_SELECT, { count: "exact" });
  if (params.date) q = q.eq("production_date", params.date);
  if (params.shift) q = q.eq("shift", params.shift);
  if (params.search) {
    const like = ilikeTerm(params.search);
    // A single `.or()` with embed-qualified paths (`table.column.op.value`)
    // -- NOT two separate `.or({foreignTable})` calls, which Postgrest ANDs
    // together instead of OR-ing across tables.
    q = q.or(`sku_codes.code.ilike.${like},app_users.full_name.ilike.${like}`);
  }
  const { data, error, count } = await q.order("created_at", { ascending: false }).range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
  if (error) throw new ApiError(500, error.message);
  let rows = ((data || []) as unknown as RawProductionRunList[]).map(flattenProductionListItem);
  if (params.machine) rows = rows.filter((r) => r.machines.split(", ").includes(params.machine!));
  if (params.search) {
    const s = params.search.toLowerCase();
    // sku_code/operator are already guaranteed matches (server-side `.or()`
    // above); this only ADDS BACK rows the join-based `.or()` might have
    // excluded that match on machine code instead (Postgrest's multiple
    // `.or(foreignTable:)` calls combine as AND-of-ORs across tables, not a
    // single flat OR) -- re-fetch is avoided by keeping the union client-side.
    rows = rows.filter((r) => [r.machines, r.sku_code, r.operator].some((v) => (v || "").toLowerCase().includes(s)));
  }
  return { items: rows, matched_count: count ?? rows.length };
}

type RawProductionRun = {
  id: string; run_number: string; shipment_number: string | null; category: string;
  total_fg_pallets: number; status: string;
  sku_code: { code: string } | null; sku_version: { version: string } | null;
  fg_qr: { id: string }[] | null;
};

/**
 * `GET /api/v1/production-runs` was plain FastAPI for a plain read -- no
 * business logic, no multi-table write, just a SELECT with two joins and a
 * computed EXISTS flag -- the exact kind of endpoint the hybrid architecture
 * says belongs on Supabase-direct, same as `listProductionSb` right above
 * (which already reads this same table for the paginated Production list).
 * It's also unbounded by design (this is the full dropdown source for FG QR
 * Generation's "eligible runs" picker, not a paginated list), and Postgrest
 * RLS on `production_runs` (migration 0012) already gates SELECT on
 * `app_can('production', 'view')` -- stricter than the FastAPI route this
 * replaces, which had no permission check of its own beyond authentication.
 */
async function listProductionRunsSb(): Promise<ProductionRun[]> {
  const { data, error } = await supabase
    .from("production_runs")
    .select(
      "id,run_number,shipment_number,category,total_fg_pallets,status," +
        "sku_code:sku_codes(code),sku_version:sku_versions(version)," +
        "fg_qr:qr_generation_records!source_production_run_id(id)"
    )
    .order("created_at", { ascending: false }) as unknown as {
    data: RawProductionRun[] | null;
    error: { message: string } | null;
  };
  if (error) throw new ApiError(500, error.message);
  return (data || []).map((r) => ({
    id: r.id, run_number: r.run_number, shipment_number: r.shipment_number,
    sku_code: r.sku_code?.code ?? null, sku_version: r.sku_version?.version ?? null,
    category: r.category, total_fg_pallets: r.total_fg_pallets, status: r.status,
    has_fg_qr: !!(r.fg_qr && r.fg_qr.length > 0),
  }));
}

type RawProdPallet = {
  id: string; role: string; pallet_id: string; quantity: string | number; sort_order: number;
  pallet: { display_id: string; sku_code: string | null; sku_version: string | null; category: string | null; lifecycle_status: string; shipment_number: string | null } | null;
};

const PRODUCTION_PALLET_SELECT =
  "id,role,pallet_id,quantity,sort_order," +
  "pallet:pallets(display_id,sku_code:sku_code_snapshot,sku_version:sku_version_snapshot,category,lifecycle_status,shipment_number)";

function prodFlattenPallet(row: RawProdPallet): MaterialConsumptionPalletRow {
  return {
    id: row.id, role: row.role as MaterialConsumptionPalletRow["role"], pallet_id: row.pallet_id,
    pallet_display_id: row.pallet?.display_id ?? "",
    sku_code: row.pallet?.sku_code ?? null, sku_version: row.pallet?.sku_version ?? null,
    category: row.pallet?.category ?? null, quantity: row.quantity,
    status: (row.pallet?.lifecycle_status ?? "generated") as MaterialConsumptionPalletRow["status"],
  };
}

type RawProdSkuVersionDetails = {
  prod_weight: string | null; prod_pcs_per_sleeve: string | null; prod_sleeve_per_case: string | null;
  prod_total_pcs_per_pallet: number | null; prod_total_pallets: number | null; prod_target_shots: string | null;
  prod_pad_type: string | null; prod_pad_color: string | null; prod_case_type: string | null;
} | null;

type RawProdMachineEntry = {
  id: string; machine: { code: string } | null; category: string | null;
  sku_code: string | null; sku_version: string | null; sku_version_id: string | null;
  start_time: string | null; end_time: string | null;
  sort_order: number; pallets: RawProdPallet[];
  sku_version_ref: RawProdSkuVersionDetails;
};

// sku_version_ref is the SKU-derived Production Details lookup (migration
// 0013) -- joined via the entry's own sku_version_id FK, autopopulated and
// read-only per run, exactly matching the prototype's SKU_PRODUCTION_DETAILS.
const PRODUCTION_MACHINE_ENTRY_SELECT =
  "id,machine:machines(code),category,sku_code:sku_code_snapshot,sku_version:sku_version_snapshot,sku_version_id,start_time,end_time,sort_order," +
  `pallets:material_consumption_pallets(${PRODUCTION_PALLET_SELECT}),` +
  "sku_version_ref:sku_versions(prod_weight,prod_pcs_per_sleeve,prod_sleeve_per_case,prod_total_pcs_per_pallet,prod_total_pallets,prod_target_shots,prod_pad_type,prod_pad_color,prod_case_type)";

type RawProdMc = { id: string; status: string; machine_entries: RawProdMachineEntry[] };

const PRODUCTION_WASTAGE_SELECT = "id,machine_id,machine:machines(code),trays,reason,sort_order";

const PRODUCTION_DETAIL_SELECT =
  "id,run_number,shipment_number,shift,production_date,status,total_fg_pallets,completed_at," +
  "rejection_damage,rejection_misplaced_glue,rejection_misplaced_pad,rejection_glue_on_pad,rejection_pad_placement_direction,rejection_adhesion_issue," +
  "created_by_user:app_users!production_runs_created_by_fkey(full_name)," +
  "completed_by_user:app_users!production_runs_completed_by_fkey(full_name)," +
  "ipqc_record:ipqc_records(id,status)," +
  "rqc_record:rqc_records(id,status)," +
  "fg_qr_batches:qr_generation_records(id,batch_display_id,status,qr_type)," +
  `wastage_entries:production_wastage_entries(${PRODUCTION_WASTAGE_SELECT}),` +
  `material_consumptions(id,status,machine_entries:material_consumption_machine_entries(${PRODUCTION_MACHINE_ENTRY_SELECT}))`;

type RawProdWastageEntry = {
  id: string; machine_id: string | null; machine: { code: string } | null; trays: number | string | null; reason: string | null; sort_order: number;
};

type RawProductionRunDetail = {
  id: string; run_number: string; shipment_number: string | null; shift: string | null; production_date: string | null; status: string;
  total_fg_pallets: number; completed_at: string | null;
  rejection_damage: number | string; rejection_misplaced_glue: number | string;
  rejection_misplaced_pad: number | string; rejection_glue_on_pad: number | string;
  rejection_pad_placement_direction: number | string; rejection_adhesion_issue: number | string;
  created_by_user: { full_name: string } | null;
  completed_by_user: { full_name: string } | null;
  ipqc_record: { id: string; status: string } | { id: string; status: string }[] | null;
  rqc_record: { id: string; status: string } | { id: string; status: string }[] | null;
  fg_qr_batches: { id: string; batch_display_id: string; status: string; qr_type: string }[];
  wastage_entries: RawProdWastageEntry[];
  material_consumptions: RawProdMc[];
};

function deriveShipmentNumberFromEntries(mcs: RawProdMc[]): string | null {
  for (const mc of mcs || []) {
    for (const e of sortedBySortOrder(mc.machine_entries || [])) {
      for (const p of sortedBySortOrder(e.pallets || [])) {
        if (p.role === "primary" && p.pallet?.shipment_number) return p.pallet.shipment_number;
      }
    }
  }
  return null;
}

/** run -> ProductionDetail. Machine entries are flattened straight from the
 * linked Material Consumption record(s)' own machine_entries -- a
 * Production Run's machine breakdown IS its source Material Consumption
 * data, per the task's "each machine must have its own corresponding
 * Production entry, with the correct linked machine/material data". */
function flattenProductionDetail(raw: RawProductionRunDetail): ProductionDetail {
  const ipqc = raw.ipqc_record;
  const ipqcObj = Array.isArray(ipqc) ? ipqc[0] ?? null : ipqc;
  const rqc = raw.rqc_record;
  const rqcObj = Array.isArray(rqc) ? rqc[0] ?? null : rqc;
  const mcs = raw.material_consumptions || [];
  const machineEntries: ProductionMachineEntry[] = [];
  for (const mc of mcs) {
    for (const e of sortedBySortOrder(mc.machine_entries || [])) {
      machineEntries.push({
        machine_consumption_id: e.id, material_consumption_id: mc.id,
        machine: e.machine?.code ?? null, category: e.category,
        sku_code: e.sku_code, sku_version: e.sku_version, sku_version_id: e.sku_version_id,
        start_time: e.start_time, end_time: e.end_time,
        pallets: sortedBySortOrder(e.pallets || []).filter((p) => p.role === "primary").map(prodFlattenPallet),
        production_details: e.sku_version_ref ? { ...e.sku_version_ref } : null,
      });
    }
  }
  const skuCodes = Array.from(new Set(machineEntries.map((e) => e.sku_code).filter((v): v is string => !!v)));
  return {
    id: raw.id, run_number: raw.run_number,
    shipment_number: raw.shipment_number ?? deriveShipmentNumberFromEntries(mcs),
    shift: raw.shift, date: raw.production_date, status: raw.status,
    operator: raw.created_by_user?.full_name ?? null,
    sku_codes: skuCodes.join(", "),
    machine_entries: machineEntries,
    total_fg_pallets: raw.total_fg_pallets ?? 0,
    rejection_classification: {
      damage: Number(raw.rejection_damage) || 0,
      misplaced_glue: Number(raw.rejection_misplaced_glue) || 0,
      misplaced_pad: Number(raw.rejection_misplaced_pad) || 0,
      glue_on_pad: Number(raw.rejection_glue_on_pad) || 0,
      pad_placement_direction: Number(raw.rejection_pad_placement_direction) || 0,
      adhesion_issue: Number(raw.rejection_adhesion_issue) || 0,
    },
    wastage_entries: sortedBySortOrder(raw.wastage_entries || []).map((w) => ({
      id: w.id, machine_id: w.machine_id, machine: w.machine?.code ?? null,
      trays: w.trays == null ? null : Number(w.trays), reason: w.reason, sort_order: w.sort_order,
    })),
    completed_by: raw.completed_by_user?.full_name ?? null,
    completed_at: raw.completed_at,
    ipqc_id: ipqcObj?.id ?? null, ipqc_status: ipqcObj?.status ?? null,
    rqc_id: rqcObj?.id ?? null, rqc_status: rqcObj?.status ?? null,
    fg_qr_batches: (raw.fg_qr_batches || []).filter((b) => b.qr_type === "fg").map((b) => ({ id: b.id, batch_display_id: b.batch_display_id, status: b.status })),
  };
}

async function getProductionSb(id: string): Promise<ProductionDetail> {
  const { data, error } = await supabase.from("production_runs").select(PRODUCTION_DETAIL_SELECT).eq("id", id).single();
  if (error || !data) throw new ApiError(404, "Production record not found");
  return flattenProductionDetail(data as unknown as RawProductionRunDetail);
}

// -- IPQC: list/detail via Supabase, save via FastAPI ------------------------
// Records are auto-created (never manually) by Material Consumption's
// finalize() -- see material_consumption_service.find_or_create_ipqc --
// so there is no create function here, only list/detail reads and the one
// editable-fields save (Shift Incharge + Check Time blocks).

type RawIpqcListItem = {
  id: string; shipment_number: string | null; sku_code_snapshot: string | null; sku_version_snapshot: string | null;
  shift_incharge: string | null; status: string; production_date: string | null; shift: string | null;
};

const IPQC_LIST_SELECT =
  "id,shipment_number,sku_code_snapshot,sku_version_snapshot,shift_incharge,status,production_date,shift";

function flattenIpqcListItem(raw: RawIpqcListItem): IpqcListItem {
  return {
    id: raw.id, shipment_number: raw.shipment_number,
    sku_code: raw.sku_code_snapshot, sku_version: raw.sku_version_snapshot,
    shift_incharge: raw.shift_incharge, status: raw.status,
    date: raw.production_date, shift: raw.shift,
  };
}

async function listIpqcSb(
  params: { search?: string; date?: string; shift?: string; status?: string; page?: number } = {}
): Promise<{ items: IpqcListItem[]; matched_count: number }> {
  const page = params.page && params.page > 0 ? params.page : 1;
  let q = supabase.from("ipqc_records").select(IPQC_LIST_SELECT, { count: "exact" }).order("created_at", { ascending: false });
  if (params.date) q = q.eq("production_date", params.date);
  if (params.shift) q = q.eq("shift", params.shift);
  if (params.status) q = q.eq("status", params.status);
  if (params.search) {
    const like = ilikeTerm(params.search);
    q = q.or(`sku_code_snapshot.ilike.${like},shift_incharge.ilike.${like},shipment_number.ilike.${like}`);
  }
  const { data, error, count } = await q.range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
  if (error) throw new ApiError(500, error.message);
  const rows = ((data || []) as unknown as RawIpqcListItem[]).map(flattenIpqcListItem);
  return { items: rows, matched_count: count ?? rows.length };
}

type RawIpqcBlockDefect = { defect_sr: number; failure: number | string | null; reason: string | null };
type RawIpqcCheckBlock = { id: string; check_time: string | null; overall_result: string | null; sort_order: number; defects: RawIpqcBlockDefect[] };
type RawIpqcRecordDetail = {
  id: string; production_run_id: string; shipment_number: string | null; batch_code: string | null;
  manufacturer: string | null; shift: string | null; production_date: string | null;
  pad_color: string | null; weight: string | null; dimensions: string | null; absorption_rate: string | null;
  sku_code_snapshot: string | null; sku_version_snapshot: string | null; shift_incharge: string | null; status: string;
  production_run: { run_number: string; material_consumptions: { id: string; status: string }[] } | { run_number: string; material_consumptions: { id: string; status: string }[] }[] | null;
  check_blocks: RawIpqcCheckBlock[];
};

const IPQC_DETAIL_SELECT =
  "id,production_run_id,shipment_number,batch_code,manufacturer,shift,production_date," +
  "pad_color,weight,dimensions,absorption_rate,sku_code_snapshot,sku_version_snapshot,shift_incharge,status," +
  "production_run:production_runs(run_number,material_consumptions(id,status))," +
  "check_blocks:ipqc_check_blocks(id,check_time,overall_result,sort_order,defects:ipqc_block_defects(defect_sr,failure,reason))";

function flattenIpqcDetail(raw: RawIpqcRecordDetail): IpqcDetail {
  const runObj = Array.isArray(raw.production_run) ? raw.production_run[0] ?? null : raw.production_run;
  return {
    id: raw.id, production_run_id: raw.production_run_id, production_run_number: runObj?.run_number ?? null,
    shipment_number: raw.shipment_number, batch_code: raw.batch_code, manufacturer: raw.manufacturer,
    shift: raw.shift, date: raw.production_date,
    pad_color: raw.pad_color, weight: raw.weight, dimensions: raw.dimensions, absorption_rate: raw.absorption_rate,
    sku_code: raw.sku_code_snapshot, sku_version: raw.sku_version_snapshot,
    shift_incharge: raw.shift_incharge, status: raw.status,
    check_blocks: sortedBySortOrder(raw.check_blocks || []).map((b) => ({
      id: b.id, check_time: b.check_time, overall_result: b.overall_result, sort_order: b.sort_order,
      defects: (b.defects || []).map((d) => ({
        defect_sr: d.defect_sr, failure: d.failure == null ? null : Number(d.failure), reason: d.reason,
      })).sort((a, c) => a.defect_sr - c.defect_sr),
    })),
    material_consumptions: runObj?.material_consumptions ?? [],
  };
}

async function getIpqcSb(id: string): Promise<IpqcDetail> {
  const { data, error } = await supabase.from("ipqc_records").select(IPQC_DETAIL_SELECT).eq("id", id).single();
  if (error || !data) throw new ApiError(404, "IPQC record not found");
  return flattenIpqcDetail(data as unknown as RawIpqcRecordDetail);
}

// -- RQC: list/detail via Supabase, save via FastAPI ------------------------
// Records are auto-created (never manually) the moment their Production
// Run's IPQC record reaches Approved -- see rqc_service.find_or_create_rqc
// -- so there is no create function here, only list/detail reads and the
// one editable-fields save (Manufacturer + defect grid + COA observations).

type RawRqcListItem = {
  id: string; shipment_number: string | null; sku_code_snapshot: string | null; sku_version_snapshot: string | null;
  manufacturer: string | null; status: string; created_at: string | null;
};

const RQC_LIST_SELECT = "id,shipment_number,sku_code_snapshot,sku_version_snapshot,manufacturer,status,created_at";

function flattenRqcListItem(raw: RawRqcListItem): RqcListItem {
  return {
    id: raw.id, shipment_number: raw.shipment_number,
    sku_code: raw.sku_code_snapshot, sku_version: raw.sku_version_snapshot,
    manufacturer: raw.manufacturer, status: raw.status, date: raw.created_at,
  };
}

async function listRqcSb(
  params: { search?: string; status?: string; page?: number } = {}
): Promise<{ items: RqcListItem[]; matched_count: number }> {
  const page = params.page && params.page > 0 ? params.page : 1;
  let q = supabase.from("rqc_records").select(RQC_LIST_SELECT, { count: "exact" }).order("created_at", { ascending: false });
  if (params.status) q = q.eq("status", params.status);
  if (params.search) {
    const like = ilikeTerm(params.search);
    q = q.or(`sku_code_snapshot.ilike.${like},manufacturer.ilike.${like},shipment_number.ilike.${like}`);
  }
  const { data, error, count } = await q.range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
  if (error) throw new ApiError(500, error.message);
  const rows = ((data || []) as unknown as RawRqcListItem[]).map(flattenRqcListItem);
  return { items: rows, matched_count: count ?? rows.length };
}

type RawRqcDefectResult = { defect_sr: number; found: number | string | null; remarks: string | null };
type RawRqcCoaObservation = { coa_group: string; sr: number; observation: string | null };
type RawRqcRecordDetail = {
  id: string; production_run_id: string; shipment_number: string | null; manufacturer: string | null;
  sku_code_snapshot: string | null; sku_version_snapshot: string | null; overall_result: string | null; status: string;
  ipqc_record_id: string | null;
  production_run: { run_number: string; total_fg_pallets: number; shift: string | null; production_date: string | null } |
    { run_number: string; total_fg_pallets: number; shift: string | null; production_date: string | null }[] | null;
  defect_results: RawRqcDefectResult[];
  coa_observations: RawRqcCoaObservation[];
};

const RQC_DETAIL_SELECT =
  "id,production_run_id,shipment_number,manufacturer,sku_code_snapshot,sku_version_snapshot,overall_result,status,ipqc_record_id," +
  "production_run:production_runs(run_number,total_fg_pallets,shift,production_date)," +
  "defect_results:rqc_defect_results(defect_sr,found,remarks)," +
  "coa_observations:rqc_coa_observations(coa_group,sr,observation)";

function flattenRqcDetail(raw: RawRqcRecordDetail): RqcDetail {
  const runObj = Array.isArray(raw.production_run) ? raw.production_run[0] ?? null : raw.production_run;
  return {
    id: raw.id, production_run_id: raw.production_run_id, production_run_number: runObj?.run_number ?? null,
    ipqc_id: raw.ipqc_record_id,
    shipment_number: raw.shipment_number, manufacturer: raw.manufacturer,
    sku_code: raw.sku_code_snapshot, sku_version: raw.sku_version_snapshot,
    total_fg_pallets: runObj?.total_fg_pallets ?? null,
    shift: runObj?.shift ?? null, date: runObj?.production_date ?? null,
    overall_result: raw.overall_result, status: raw.status,
    defect_results: (raw.defect_results || [])
      .map((d) => ({ defect_sr: d.defect_sr, found: d.found == null ? null : Number(d.found), remarks: d.remarks }))
      .sort((a, c) => a.defect_sr - c.defect_sr),
    coa_observations: (raw.coa_observations || []).map((o) => ({ coa_group: o.coa_group, sr: o.sr, observation: o.observation })),
  };
}

async function getRqcSb(id: string): Promise<RqcDetail> {
  const { data, error } = await supabase.from("rqc_records").select(RQC_DETAIL_SELECT).eq("id", id).single();
  if (error || !data) throw new ApiError(404, "RQC record not found");
  return flattenRqcDetail(data as unknown as RawRqcRecordDetail);
}

// -- Customer Shipment / Shipment Picking: list/detail via Supabase --------
// Downstream of FG Storage: FG Storage -> Customer Shipment -> Shipment
// Picking. Customer Shipment is create-once (no edit route at all); the
// only FastAPI routes are the one atomic create transaction and delete for
// Customer Shipment, and pick/undo-pick for Shipment Picking -- everything
// else here is a lightweight direct-Supabase read, per spec point 15.

type RawCsListItem = {
  id: string; shipment_number: string; container_number: string; customer: string; created_at: string;
  line_items: { sku_code_snapshot: string | null; sku_version_snapshot: string | null; pallets_required: number }[];
};

// List reads fetch ONLY what the table needs (Shipment Number, Container
// Number, Customer, SKU summary, Total pallets, Date) -- never the full
// nested detail -- per spec point 15's "do not over-fetch for the list".
const CS_LIST_SELECT =
  "id,shipment_number,container_number,customer,created_at," +
  "line_items:customer_shipment_line_items(sku_code_snapshot,sku_version_snapshot,pallets_required)";

function flattenCsListItem(raw: RawCsListItem): CustomerShipmentListItem {
  const items = raw.line_items || [];
  const sku_summary = items
    .map((li) => [li.sku_code_snapshot, li.sku_version_snapshot].filter(Boolean).join(" / "))
    .filter(Boolean)
    .join(", ");
  const total_pallets = items.reduce((sum, li) => sum + (li.pallets_required || 0), 0);
  return {
    id: raw.id, shipment_number: raw.shipment_number, container_number: raw.container_number,
    customer: raw.customer, sku_summary, total_pallets, created_at: raw.created_at,
  };
}

async function listCustomerShipmentsSb(
  params: { search?: string; date?: string; page?: number } = {}
): Promise<{ items: CustomerShipmentListItem[]; matched_count: number }> {
  const page = params.page && params.page > 0 ? params.page : 1;
  let q = supabase.from("customer_shipments").select(CS_LIST_SELECT, { count: "exact" }).order("created_at", { ascending: false });
  if (params.search) {
    const like = ilikeTerm(params.search);
    q = q.or(`customer.ilike.${like},container_number.ilike.${like},shipment_number.ilike.${like}`);
  }
  if (params.date) {
    q = q.gte("created_at", `${params.date}T00:00:00`).lte("created_at", `${params.date}T23:59:59`);
  }
  const { data, error, count } = await q.range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
  if (error) throw new ApiError(500, error.message);
  const rows = ((data || []) as unknown as RawCsListItem[]).map(flattenCsListItem);
  return { items: rows, matched_count: count ?? rows.length };
}

type RawCsLineItem = {
  id: string; sku_code_id: string | null; sku_version_id: string | null;
  sku_code_snapshot: string | null; sku_version_snapshot: string | null; pallets_required: number;
};
type RawCsPickingRequest = {
  id: string; sku_code_snapshot: string | null; sku_version_snapshot: string | null;
  pallets_required: number; status: string; picks: { id: string }[];
};
type RawCsDetail = {
  id: string; shipment_number: string; container_number: string; customer: string; created_at: string;
  line_items: RawCsLineItem[];
  picking_requests: RawCsPickingRequest[];
};

// Detail only fetched when the user opens a record (spec point 15) -- full
// line items + linked Shipment Picking requests, for traceability.
const CS_DETAIL_SELECT =
  "id,shipment_number,container_number,customer,created_at," +
  "line_items:customer_shipment_line_items(id,sku_code_id,sku_version_id,sku_code_snapshot,sku_version_snapshot,pallets_required)," +
  "picking_requests:shipment_picking_requests(id,sku_code_snapshot,sku_version_snapshot,pallets_required,status,picks:shipment_picking_picks(id))";

function flattenCsDetail(raw: RawCsDetail): CustomerShipmentDetail {
  return {
    id: raw.id, shipment_number: raw.shipment_number, container_number: raw.container_number,
    customer: raw.customer, created_at: raw.created_at,
    line_items: (raw.line_items || []).map((li) => ({
      id: li.id, sku_code_id: li.sku_code_id, sku_version_id: li.sku_version_id,
      sku_code: li.sku_code_snapshot, sku_version: li.sku_version_snapshot, pallets_required: li.pallets_required,
    })),
    picking_requests: (raw.picking_requests || []).map((r) => ({
      id: r.id, sku_code: r.sku_code_snapshot, sku_version: r.sku_version_snapshot,
      pallets_required: r.pallets_required, pallets_picked: (r.picks || []).length, status: r.status,
    })),
  };
}

async function getCustomerShipmentSb(id: string): Promise<CustomerShipmentDetail> {
  const { data, error } = await supabase.from("customer_shipments").select(CS_DETAIL_SELECT).eq("id", id).single();
  if (error || !data) throw new ApiError(404, "Customer Shipment record not found");
  return flattenCsDetail(data as unknown as RawCsDetail);
}

/**
 * Non-incrementing preview of the next Shipment/Container numbers, for the
 * create panel to display before save (spec point 8) -- a plain SELECT
 * against display_id_counters (RLS-opened read-only in migration 0020),
 * never the atomic next_seq() UPSERT the backend uses at actual save time.
 * "next_value" already IS "the next number that will be issued" (next_seq
 * returns next_value - 1 *after* incrementing) -- a counter row that
 * doesn't exist yet simply hasn't issued anything, so this defaults to 1.
 */
async function peekNextCsNumbers(): Promise<{ shipment: string; container: string }> {
  const yymm = new Date().toISOString().slice(2, 7).replace("-", "");
  const { data, error } = await supabase
    .from("display_id_counters")
    .select("counter_key, next_value")
    .in("counter_key", ["cs_shipment", "cs_container"]);
  if (error) throw new ApiError(500, error.message);
  const byKey = new Map((data || []).map((r: { counter_key: string; next_value: number }) => [r.counter_key, r.next_value]));
  const shipmentSeq = byKey.get("cs_shipment") ?? 1;
  const containerSeq = byKey.get("cs_container") ?? 1;
  return {
    shipment: `US-SHP-${yymm}-${String(shipmentSeq).padStart(4, "0")}`,
    container: `US-CTN-${yymm}-${String(containerSeq).padStart(4, "0")}`,
  };
}

type RawSpListItem = {
  id: string; shipment_number: string | null; customer: string | null;
  sku_code_snapshot: string | null; sku_version_snapshot: string | null;
  pallets_required: number; status: string; created_at: string;
  picks: { id: string }[];
};

const SP_LIST_SELECT =
  "id,shipment_number,customer,sku_code_snapshot,sku_version_snapshot,pallets_required,status,created_at," +
  "picks:shipment_picking_picks(id)";

function flattenSpListItem(raw: RawSpListItem): ShipmentPickingListItem {
  return {
    id: raw.id, shipment_number: raw.shipment_number, customer: raw.customer,
    sku_code: raw.sku_code_snapshot, sku_version: raw.sku_version_snapshot,
    pallets_required: raw.pallets_required, pallets_picked: (raw.picks || []).length,
    status: raw.status, created_at: raw.created_at,
  };
}

async function listShipmentPickingSb(
  params: { search?: string; status?: string; page?: number } = {}
): Promise<{ items: ShipmentPickingListItem[]; matched_count: number }> {
  const page = params.page && params.page > 0 ? params.page : 1;
  let q = supabase.from("shipment_picking_requests").select(SP_LIST_SELECT, { count: "exact" }).order("created_at", { ascending: false });
  if (params.status) q = q.eq("status", params.status);
  if (params.search) {
    const like = ilikeTerm(params.search);
    q = q.or(`customer.ilike.${like},sku_code_snapshot.ilike.${like},shipment_number.ilike.${like}`);
  }
  const { data, error, count } = await q.range((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE - 1);
  if (error) throw new ApiError(500, error.message);
  const rows = ((data || []) as unknown as RawSpListItem[]).map(flattenSpListItem);
  return { items: rows, matched_count: count ?? rows.length };
}

type RawSpDetail = {
  id: string; shipment_number: string | null; container_number: string | null; customer: string | null;
  sku_code_snapshot: string | null; sku_version_snapshot: string | null; pallets_required: number; status: string;
  picks: { id: string; pallet_id: string; picked_at: string; pallet: { display_id: string } | { display_id: string }[] | null }[];
};

const SP_DETAIL_SELECT =
  "id,shipment_number,container_number,customer,sku_code_snapshot,sku_version_snapshot,pallets_required,status," +
  "picks:shipment_picking_picks(id,pallet_id,picked_at,pallet:pallets(display_id))";

function flattenSpDetail(raw: RawSpDetail): ShipmentPickingDetail {
  return {
    id: raw.id, shipment_number: raw.shipment_number, container_number: raw.container_number, customer: raw.customer,
    sku_code: raw.sku_code_snapshot, sku_version: raw.sku_version_snapshot, pallets_required: raw.pallets_required,
    status: raw.status,
    picks: (raw.picks || []).map((p) => {
      const pallet = Array.isArray(p.pallet) ? p.pallet[0] ?? null : p.pallet;
      return { id: p.id, pallet_id: p.pallet_id, pallet_display_id: pallet?.display_id ?? null, picked_at: p.picked_at };
    }),
  };
}

async function getShipmentPickingSb(id: string): Promise<ShipmentPickingDetail> {
  const { data, error } = await supabase.from("shipment_picking_requests").select(SP_DETAIL_SELECT).eq("id", id).single();
  if (error || !data) throw new ApiError(404, "Shipment Picking request not found");
  return flattenSpDetail(data as unknown as RawSpDetail);
}

// Sku_codes rows always come back with their versions embedded via
// PostgREST's nested-resource select -- matches the joinedload(versions)
// every FastAPI /skus and /reference/sku-codes route already did, with the
// exact same "all versions, not just active ones" shape (see LineItemsEditor,
// which itself does no active-filtering on the versions it's handed).
const SKU_SELECT =
  "id, code, category, is_active, " +
  "versions:sku_versions(id, version, is_active, prod_weight, prod_pcs_per_sleeve, prod_sleeve_per_case, " +
  "prod_total_pcs_per_pallet, prod_total_pallets, prod_target_shots, prod_pad_type, prod_pad_color, prod_case_type, " +
  "prod_dimensions, prod_absorption_rate)";

/**
 * `GET /api/v1/inward-qc/meta` was FastAPI for a plain read: three ordered/
 * filtered SELECTs (attribute definitions, fgtray criteria, sampling plan
 * tiers) plus a few hardcoded constant dicts bundled into one response --
 * no business logic, no write, no privileged access. Moved to three
 * parallel Supabase-direct reads (RLS already grants these three tables'
 * SELECT to authenticated users -- migration 0011's
 * qc_attribute_definitions_select / qc_fgtray_criteria_select /
 * qc_sampling_plan_tiers_select policies), with the constant dicts mirrored
 * client-side (see QC_MANUAL_CATEGORIES etc. above) instead of fetched.
 */
async function qcMetaSb(): Promise<QcMeta> {
  const [{ data: attrRows, error: attrErr }, { data: criteriaRows, error: critErr }, { data: tierRows, error: tierErr }] =
    await Promise.all([
      supabase
        .from("inward_qc_attribute_definitions")
        .select("id,category,label,field_type,options_json,is_required,sort_order")
        .eq("is_active", true)
        .order("category")
        .order("sort_order") as unknown as Promise<{ data: QcAttributeDefinition[] | null; error: { message: string } | null }>,
      supabase
        .from("inward_qc_fgtray_criteria")
        .select("id,label,sort_order")
        .eq("is_active", true)
        .order("sort_order") as unknown as Promise<{ data: QcFgtrayCriterion[] | null; error: { message: string } | null }>,
      supabase
        .from("inward_qc_sampling_plan_tiers")
        .select("category,qty_label,min_qty,max_qty,sample_size,upper_limit,note")
        .order("category")
        .order("sort_order") as unknown as Promise<{ data: QcSamplingPlanTier[] | null; error: { message: string } | null }>,
    ]);
  const err = attrErr || critErr || tierErr;
  if (err) throw new ApiError(500, err.message);

  const attribute_definitions = QC_MANUAL_CATEGORIES.reduce((acc, cat) => {
    acc[cat] = (attrRows || []).filter((a) => a.category === cat);
    return acc;
  }, {} as Record<QcManualCategory, QcAttributeDefinition[]>);

  // First tier row per category is this category's qty_label -- same
  // "first match wins" lookup `quantity_label_for()` does server-side.
  const quantity_labels: Record<string, string> = { fgtray: "No. of Pallets" };
  for (const cat of QC_MANUAL_CATEGORIES) {
    quantity_labels[cat] = (tierRows || []).find((t) => t.category === cat)?.qty_label || "Quantity";
  }

  return {
    manual_categories: QC_MANUAL_CATEGORIES,
    attribute_definitions,
    fgtray_criteria: criteriaRows || [],
    sampling_plan_tiers: tierRows || [],
    quantity_labels,
    conclusion_labels: QC_CONCLUSION_LABEL,
    count_labels: QC_COUNT_LABEL,
  };
}

export const api = {
  me: () => request<MeResponse>("/api/v1/me"),

  // -- Users (Setup -> Users, admin-only) -- privileged multi-table
  // (app_users + module_permissions) writes, so unlike Vendors/SKUs/
  // Machines these go through FastAPI's `request()`, not direct Supabase.
  users: () => request<AppUser[]>("/api/v1/users"),
  createUser: (payload: UserCreateInput) =>
    request<AppUser>("/api/v1/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (id: string, patch: UserUpdateInput) =>
    request<AppUser>(`/api/v1/users/${id}`, { method: "PUT", body: JSON.stringify(patch) }),

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
    cachedList(
      listCacheKey("ref:vendors", { category: params?.category, includeInactive: params?.includeInactive }),
      () =>
        sbRequest<Vendor[]>(() => {
          let q = supabase.from("vendors").select("id, category, name, country, is_active");
          if (params?.category) q = q.eq("category", params.category);
          if (!params?.includeInactive) q = q.eq("is_active", true);
          return q.order("category").order("name") as unknown as Promise<{ data: Vendor[] | null; error: { message: string; code?: string } | null }>;
        }),
      REFERENCE_STALE_MS
    ),

  skus: (params?: { category?: string; includeInactive?: boolean }) =>
    cachedList(
      listCacheKey("ref:skus", { category: params?.category, includeInactive: params?.includeInactive }),
      () =>
        sbRequest<SkuCode[]>(() => {
          let q = supabase.from("sku_codes").select(SKU_SELECT);
          if (params?.category) q = q.eq("category", params.category);
          if (!params?.includeInactive) q = q.eq("is_active", true);
          return q.order("category").order("code") as unknown as Promise<{ data: SkuCode[] | null; error: { message: string; code?: string } | null }>;
        }),
      REFERENCE_STALE_MS
    ),
  // Every SKU/version mutation below invalidates the `ref:skus` cache key
  // (see the `skus()` read above) so the admin screen's own next read, and
  // every other module's cached dropdown data, sees the change immediately
  // instead of serving up to REFERENCE_STALE_MS of stale SKU data.
  createSku: (category: string, code: string) =>
    sbVoid(
      () => supabase.from("sku_codes").insert({ category, code, is_active: true }),
      { conflict: `"${code}" already exists.` }
    ).then(() => invalidateListCache("ref:skus")),
  updateSku: (id: string, patch: { code?: string; is_active?: boolean }) =>
    sbVoid(
      () => supabase.from("sku_codes").update(patch).eq("id", id),
      { conflict: `"${patch.code}" already exists.` }
    ).then(() => invalidateListCache("ref:skus")),
  deleteSku: (id: string) =>
    sbVoid(
      () => supabase.from("sku_codes").delete().eq("id", id),
      { fk: "This SKU is referenced by existing records and can't be deleted — deactivate it instead." }
    ).then(() => invalidateListCache("ref:skus")),
  addSkuVersion: (
    skuId: string,
    version: string,
    productionDetails?: Partial<Omit<SkuVersion, "id" | "version" | "is_active">>
  ) =>
    sbVoid(
      () => supabase.from("sku_versions").insert({ sku_code_id: skuId, version, is_active: true, ...productionDetails }),
      { conflict: `Version "${version}" already exists for this SKU.` }
    ).then(() => invalidateListCache("ref:skus")),
  updateSkuVersion: (
    versionId: string,
    patch: Partial<Omit<SkuVersion, "id">> & { version?: string; is_active?: boolean }
  ) =>
    sbVoid(
      () => supabase.from("sku_versions").update(patch).eq("id", versionId),
      { conflict: `Version "${patch.version}" already exists for this SKU.` }
    ).then(() => invalidateListCache("ref:skus")),
  deleteSkuVersion: (versionId: string) =>
    sbVoid(
      () => supabase.from("sku_versions").delete().eq("id", versionId),
      { fk: "This version is referenced by existing records and can't be deleted — deactivate it instead." }
    ).then(() => invalidateListCache("ref:skus")),
  // Unlike every other Phase 1 mutation, this one's return value is used
  // directly (Wizard.tsx's inline "add a new vendor" flow appends it to
  // the dropdown and selects it without a full refetch) -- so this is the
  // one create/update call that needs `.select().single()` chained rather
  // than the fire-and-forget sbVoid the admin screen's own equivalent call
  // uses. Still invalidates `ref:vendors` (after resolving, so the return
  // value Wizard.tsx depends on is untouched) so any OTHER already-mounted
  // vendor dropdown picks up the addition on its next read too.
  createVendor: (category: Category, name: string, country: string) =>
    sbRequest<Vendor>(
      () => supabase.from("vendors").insert({ category, name, country, is_active: true }).select("id, category, name, country, is_active").single() as unknown as Promise<{ data: Vendor | null; error: { message: string; code?: string } | null }>,
      { conflict: `"${name}" already exists for this category.` }
    ).then((v) => { invalidateListCache("ref:vendors"); return v; }),
  updateVendor: (id: string, patch: { name?: string; country?: string; is_active?: boolean }) =>
    sbVoid(
      () => supabase.from("vendors").update(patch).eq("id", id),
      { conflict: `"${patch.name}" already exists for this category.` }
    ).then(() => invalidateListCache("ref:vendors")),
  deleteVendor: (id: string) =>
    sbVoid(
      () => supabase.from("vendors").delete().eq("id", id),
      { fk: "This vendor is referenced by existing records and can't be deleted — deactivate it instead." }
    ).then(() => invalidateListCache("ref:vendors")),

  // -- Phase 2: Inward Vehicle Inspection list/detail, direct Supabase ----
  listInspections: async (params: { search?: string; status?: string; category?: string; date?: string }) => {
    const base = supabase
      .from("inward_vehicle_inspections")
      .select("id,shipment_number,invoice_number,container_number,status,category,created_at", { count: "exact" });
    const filtered = applyIviFilters(base as unknown as PgQuery, params);
    const ordered = (filtered as unknown as typeof base).order("created_at", { ascending: false }).range(0, 49);
    const { data, error, count } = await ordered;
    if (error) throw new ApiError(500, error.message);
    // total_count is the GRAND total regardless of filters, while
    // matched_count (`count` above) is scoped to whatever filters are
    // active -- those are genuinely different numbers whenever a filter is
    // active, so a second query is unavoidable then. But with no filters
    // active (the common case: opening the module with a blank search/no
    // filters) they're the same number by definition, so the extra
    // unfiltered-count round trip this used to always fire is now skipped
    // and `count` is reused directly.
    const hasActiveFilter = !!(params.search || params.status || params.category || params.date);
    const total_count = hasActiveFilter ? await countAll("inward_vehicle_inspections") : count ?? 0;
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
  qcMeta: () => qcMetaSb(),

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
  listRmQr: async (params: { search?: string; date?: string; sku?: string; page?: number } = {}) =>
    cachedList(listCacheKey("rm-qr", params), () =>
      sbRequestPage<QrGenerationListItem>(() => qrListQuery("rm", params) as unknown as Promise<{ data: QrGenerationListItem[] | null; error: { message: string; code?: string } | null; count: number | null }>)
    ),
  getRmQr: (id: string) => qrGetDetail("rm", id),
  generateRmQr: async (id: string) => {
    const res = await request<QrGenerationDetail>(`/api/v1/rm-qr/${id}/generate`, { method: "POST" });
    invalidateListCache("rm-qr");
    return res;
  },
  deleteRmQr: async (id: string) => {
    const res = await request<{ ok: boolean }>(`/api/v1/rm-qr/${id}`, { method: "DELETE" });
    invalidateListCache("rm-qr");
    return res;
  },

  // -- FG QR Generation --------------------------------------------------
  listFgQr: async (params: { search?: string; date?: string; sku?: string; page?: number } = {}) =>
    cachedList(listCacheKey("fg-qr", params), () =>
      sbRequestPage<QrGenerationListItem>(() => qrListQuery("fg", params) as unknown as Promise<{ data: QrGenerationListItem[] | null; error: { message: string; code?: string } | null; count: number | null }>)
    ),
  getFgQr: (id: string) => qrGetDetail("fg", id),
  generateFgQr: async (id: string) => {
    const res = await request<QrGenerationDetail>(`/api/v1/fg-qr/${id}/generate`, { method: "POST" });
    invalidateListCache("fg-qr");
    return res;
  },
  deleteFgQr: async (id: string) => {
    const res = await request<{ ok: boolean }>(`/api/v1/fg-qr/${id}`, { method: "DELETE" });
    invalidateListCache("fg-qr");
    return res;
  },
  createFgQrFromRun: async (runId: string) => {
    const res = await request<QrGenerationDetail>(`/api/v1/fg-qr/from-production-run/${runId}`, { method: "POST" });
    invalidateListCache("fg-qr");
    return res;
  },

  // -- Production Runs (minimal, feeds FG QR Generation) ------------------
  listProductionRuns: () => listProductionRunsSb(),

  // -- RM Storage ----------------------------------------------------------
  listRmPending: (params: { search?: string; sku?: string; page?: number } = {}) =>
    cachedList(listCacheKey("rm-storage-pending", params), () => pendingPalletsQuery("rm", params)),
  listRmStorageRecords: (search = "") =>
    cachedList(listCacheKey("rm-storage-records", { search }), () => storageRecordsQuery("rm", search)),
  getRmStorageRecord: (id: string) => storageRecordDetail("rm", id),
  scanRmPallet: (payload: string) => request<Pallet>("/api/v1/rm-storage/scan-pallet", { method: "POST", body: JSON.stringify({ payload }) }),
  scanRmLocation: (payload: string) => request<{ id: string; display_id: string; zone: string }>("/api/v1/rm-storage/scan-location", { method: "POST", body: JSON.stringify({ payload }) }),
  confirmRmStorage: async (palletPayload: string, locationPayload: string) => {
    const res = await request<StorageRecordDetail>("/api/v1/rm-storage/confirm", { method: "POST", body: JSON.stringify({ pallet_payload: palletPayload, location_payload: locationPayload }) });
    invalidateListCache("rm-storage-pending");
    invalidateListCache("rm-storage-records");
    return res;
  },

  // -- FG Storage ------------------------------------------------------------
  listFgPending: (params: { search?: string; sku?: string; page?: number } = {}) =>
    cachedList(listCacheKey("fg-storage-pending", params), () => pendingPalletsQuery("fg", params)),
  listFgStorageRecords: (search = "") =>
    cachedList(listCacheKey("fg-storage-records", { search }), () => storageRecordsQuery("fg", search)),
  getFgStorageRecord: (id: string) => storageRecordDetail("fg", id),
  scanFgPallet: (payload: string) => request<Pallet>("/api/v1/fg-storage/scan-pallet", { method: "POST", body: JSON.stringify({ payload }) }),
  scanFgLocation: (payload: string) => request<{ id: string; display_id: string; zone: string }>("/api/v1/fg-storage/scan-location", { method: "POST", body: JSON.stringify({ payload }) }),
  confirmFgStorage: async (palletPayload: string, locationPayload: string) => {
    const res = await request<StorageRecordDetail>("/api/v1/fg-storage/confirm", { method: "POST", body: JSON.stringify({ pallet_payload: palletPayload, location_payload: locationPayload }) });
    invalidateListCache("fg-storage-pending");
    invalidateListCache("fg-storage-records");
    return res;
  },

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
  // Fetched fresh on nearly every module mount (Production, Material
  // Consumption) despite being a small, rarely-changing list -- cached like
  // vendors()/skus() above, invalidated by the three mutations right below.
  machines: (includeInactive = false) =>
    cachedList(
      listCacheKey("ref:machines", { includeInactive }),
      () =>
        sbRequest<Machine[]>(() => {
          let q = supabase.from("machines").select("id, code, is_active");
          if (!includeInactive) q = q.eq("is_active", true);
          return q.order("code") as unknown as Promise<{ data: Machine[] | null; error: { message: string; code?: string } | null }>;
        }),
      REFERENCE_STALE_MS
    ),
  createMachine: (code: string) =>
    sbVoid(
      () => supabase.from("machines").insert({ code, is_active: true }),
      { conflict: `"${code}" already exists.` }
    ).then(() => invalidateListCache("ref:machines")),
  updateMachine: (id: string, patch: { code?: string; is_active?: boolean }) =>
    sbVoid(
      () => supabase.from("machines").update(patch).eq("id", id),
      { conflict: `"${patch.code}" already exists.` }
    ).then(() => invalidateListCache("ref:machines")),
  deleteMachine: (id: string) =>
    sbVoid(
      () => supabase.from("machines").delete().eq("id", id),
      { fk: "This machine is referenced by an existing Material Consumption or Production record and cannot be deleted. Deactivate it instead." }
    ).then(() => invalidateListCache("ref:machines")),

  // -- Material Consumption -------------------------------------------------
  // list/detail go direct to Supabase (Phase 2); every draft/scan/finalize
  // write below stays on FastAPI, unchanged.
  listMaterialConsumption: (params: { search?: string; category?: string; date?: string; status?: string; page?: number } = {}) =>
    cachedList(listCacheKey("material-consumption", params), () => listMaterialConsumptionSb(params)),
  materialConsumptionShifts: () => request<string[]>("/api/v1/material-consumption/shifts"),
  createMaterialConsumptionDraft: async () => {
    const res = await request<MaterialConsumptionDetail>("/api/v1/material-consumption/draft", { method: "POST" });
    invalidateListCache("material-consumption");
    return res;
  },
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
  removeMaterialConsumptionPallet: (id: string, rowId: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/pallets/${rowId}`, { method: "DELETE" }),
  setMaterialConsumptionPalletQuantity: (id: string, rowId: string, quantity: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/pallets/${rowId}/quantity`, { method: "PUT", body: JSON.stringify({ quantity }) }),
  saveMaterialConsumptionDraft: (id: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/save-draft`, { method: "POST" }),
  finalizeMaterialConsumption: async (id: string) => {
    const res = await request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/finalize`, { method: "POST" });
    invalidateListCache("material-consumption");
    invalidateListCache("production");
    invalidateListCache("ipqc");
    return res;
  },
  discardMaterialConsumptionIfBlank: async (id: string) => {
    const res = await request<void>(`/api/v1/material-consumption/${id}/if-blank`, { method: "DELETE" });
    invalidateListCache("material-consumption");
    return res;
  },
  deleteMaterialConsumption: async (id: string) => {
    const res = await request<{ ok: boolean }>(`/api/v1/material-consumption/${id}`, { method: "DELETE" });
    invalidateListCache("material-consumption");
    return res;
  },

  // -- Production -------------------------------------------------------
  // List/detail reads are Supabase-direct (every record is auto-created by
  // Material Consumption's finalize()); the one editable-fields save goes
  // through FastAPI, matching the hybrid split -- reads direct, transactional
  // writes through the backend.
  listProduction: (params: { search?: string; date?: string; shift?: string; machine?: string; page?: number } = {}) =>
    cachedList(listCacheKey("production", params), () => listProductionSb(params)),
  getProduction: (id: string) => getProductionSb(id),
  saveProduction: async (id: string, payload: ProductionSavePayload) => {
    const res = await request<{ id: string; status: string }>(`/api/v1/production-runs/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    invalidateListCache("production");
    return res;
  },

  // -- IPQC -----------------------------------------------------------
  // Same split as Production: list/detail reads Supabase-direct (every
  // record is auto-created by Material Consumption's finalize()), the one
  // editable-fields save (Shift Incharge + Check Time blocks) through
  // FastAPI.
  listIpqc: (params: { search?: string; date?: string; shift?: string; status?: string; page?: number } = {}) =>
    cachedList(listCacheKey("ipqc", params), () => listIpqcSb(params)),
  getIpqc: (id: string) => getIpqcSb(id),
  saveIpqc: async (id: string, payload: IpqcSavePayload) => {
    const res = await request<{ id: string; status: string }>(`/api/v1/ipqc-records/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    invalidateListCache("ipqc");
    // An IPQC save that reaches Approved auto-creates RQC (see
    // rqc_service.find_or_create_rqc) -- invalidate RQC's list cache too so
    // the new Pending record shows up without a hard refresh.
    invalidateListCache("rqc");
    return res;
  },

  // -- RQC (Final Quality Control) --------------------------------------
  // Same split as IPQC: list/detail reads Supabase-direct (every record is
  // auto-created the moment its Production Run's IPQC reaches Approved),
  // the one editable-fields save (Manufacturer + defect grid + COA
  // observations) through FastAPI.
  listRqc: (params: { search?: string; status?: string; page?: number } = {}) =>
    cachedList(listCacheKey("rqc", params), () => listRqcSb(params)),
  getRqc: (id: string) => getRqcSb(id),
  saveRqc: async (id: string, payload: RqcSavePayload) => {
    const res = await request<{ id: string; status: string }>(`/api/v1/rqc-records/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    invalidateListCache("rqc");
    // A save that reaches Approved auto-creates/refreshes the FG QR
    // Generation record for this run (see api/rqc.py's save route) --
    // invalidate its list cache too so the new Pending record shows up
    // without a hard refresh.
    invalidateListCache("fg-qr");
    return res;
  },

  // -- Customer Shipment / Shipment Picking ------------------------------
  // List/detail reads are direct-Supabase (spec point 15); the atomic
  // create transaction, delete, and pick/undo-pick actions go through
  // FastAPI since they're privileged multi-table writes.
  listCustomerShipments: (params: { search?: string; date?: string; page?: number } = {}) =>
    cachedList(listCacheKey("customer-shipment", params), () => listCustomerShipmentsSb(params)),
  getCustomerShipment: (id: string) => getCustomerShipmentSb(id),
  peekNextCsNumbers: () => peekNextCsNumbers(),
  createCustomerShipment: async (payload: CustomerShipmentCreatePayload) => {
    const res = await request<CustomerShipmentCreateResult>("/api/v1/customer-shipments", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    invalidateListCache("customer-shipment");
    // Every Customer Shipment save fans out new Shipment Picking requests
    // (see customer_shipment_service.create_customer_shipment) -- invalidate
    // its list cache too so they show up without a hard refresh.
    invalidateListCache("shipment-picking");
    return res;
  },
  deleteCustomerShipment: async (id: string) => {
    await request<void>(`/api/v1/customer-shipments/${id}`, { method: "DELETE" });
    invalidateListCache("customer-shipment");
  },

  listShipmentPicking: (params: { search?: string; status?: string; page?: number } = {}) =>
    cachedList(listCacheKey("shipment-picking", params), () => listShipmentPickingSb(params)),
  getShipmentPicking: (id: string) => getShipmentPickingSb(id),
  pickPallet: async (requestId: string, payload: string) => {
    const res = await request<{ request_id: string; status: string; pallet_display_id: string; pallets_picked: number; pallets_required: number }>(
      `/api/v1/shipment-picking/${requestId}/pick`,
      { method: "POST", body: JSON.stringify({ payload }) }
    );
    invalidateListCache("shipment-picking");
    return res;
  },
  removePick: async (requestId: string, pickId: string) => {
    await request<void>(`/api/v1/shipment-picking/${requestId}/picks/${pickId}`, { method: "DELETE" });
    invalidateListCache("shipment-picking");
  },
};
