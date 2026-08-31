import { getAuthHeader } from "./session";
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      Authorization: getAuthHeader(),
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

export const api = {
  me: () => request<MeResponse>("/api/v1/me"),
  skuCodes: (category?: string) =>
    request<SkuCode[]>(`/api/v1/reference/sku-codes${category ? `?category=${category}` : ""}`),
  checklistItems: () => request<ChecklistItemRef[]>("/api/v1/reference/checklist-items"),

  vendors: (params?: { category?: string; includeInactive?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set("category", params.category);
    if (params?.includeInactive) qs.set("include_inactive", "true");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<Vendor[]>(`/api/v1/vendors${suffix}`);
  },

  skus: (params?: { category?: string; includeInactive?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set("category", params.category);
    if (params?.includeInactive) qs.set("include_inactive", "true");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<SkuCode[]>(`/api/v1/skus${suffix}`);
  },
  createSku: (category: string, code: string) =>
    request<SkuCode>("/api/v1/skus", { method: "POST", body: JSON.stringify({ category, code }) }),
  updateSku: (id: string, patch: { code?: string; is_active?: boolean }) =>
    request<SkuCode>(`/api/v1/skus/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteSku: (id: string) => request<void>(`/api/v1/skus/${id}`, { method: "DELETE" }),
  addSkuVersion: (skuId: string, version: string) =>
    request<SkuCode>(`/api/v1/skus/${skuId}/versions`, { method: "POST", body: JSON.stringify({ version }) }),
  updateSkuVersion: (versionId: string, patch: { version?: string; is_active?: boolean }) =>
    request<SkuVersion>(`/api/v1/skus/versions/${versionId}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteSkuVersion: (versionId: string) =>
    request<void>(`/api/v1/skus/versions/${versionId}`, { method: "DELETE" }),
  createVendor: (category: Category, name: string, country: string) =>
    request<Vendor>("/api/v1/vendors", { method: "POST", body: JSON.stringify({ category, name, country }) }),
  updateVendor: (id: string, patch: { name?: string; country?: string; is_active?: boolean }) =>
    request<Vendor>(`/api/v1/vendors/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteVendor: (id: string) =>
    request<void>(`/api/v1/vendors/${id}`, { method: "DELETE" }),

  listInspections: (params: { search?: string; status?: string; category?: string; date?: string }) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.status) qs.set("status", params.status);
    if (params.category) qs.set("category", params.category);
    if (params.date) qs.set("date", params.date);
    return request<{ items: InspectionListItem[]; matched_count: number; total_count: number }>(
      `/api/v1/inward-vehicle-inspections?${qs.toString()}`
    );
  },

  createDraft: (category: Category) =>
    request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/draft?category=${category}`, { method: "POST" }),

  getInspection: (id: string) => request<InspectionDetail>(`/api/v1/inward-vehicle-inspections/${id}`),

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

  listQc: (params: { search?: string; status?: string; category?: string; date?: string }) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.status) qs.set("status", params.status);
    if (params.category) qs.set("category", params.category);
    if (params.date) qs.set("date", params.date);
    return request<{ items: QcListItem[]; matched_count: number; total_count: number }>(
      `/api/v1/inward-qc?${qs.toString()}`
    );
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
  listRmQr: (params: { search?: string; date?: string; sku?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<QrGenerationListItem[]>(`/api/v1/rm-qr?${qs}`);
  },
  getRmQr: (id: string) => request<QrGenerationDetail>(`/api/v1/rm-qr/${id}`),
  generateRmQr: (id: string) => request<QrGenerationDetail>(`/api/v1/rm-qr/${id}/generate`, { method: "POST" }),
  deleteRmQr: (id: string) => request<{ ok: boolean }>(`/api/v1/rm-qr/${id}`, { method: "DELETE" }),

  // -- FG QR Generation --------------------------------------------------
  listFgQr: (params: { search?: string; date?: string; sku?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<QrGenerationListItem[]>(`/api/v1/fg-qr?${qs}`);
  },
  getFgQr: (id: string) => request<QrGenerationDetail>(`/api/v1/fg-qr/${id}`),
  generateFgQr: (id: string) => request<QrGenerationDetail>(`/api/v1/fg-qr/${id}/generate`, { method: "POST" }),
  deleteFgQr: (id: string) => request<{ ok: boolean }>(`/api/v1/fg-qr/${id}`, { method: "DELETE" }),
  createFgQrFromRun: (runId: string) => request<QrGenerationDetail>(`/api/v1/fg-qr/from-production-run/${runId}`, { method: "POST" }),

  // -- Production Runs (minimal, feeds FG QR Generation) ------------------
  listProductionRuns: () => request<ProductionRun[]>("/api/v1/production-runs"),

  // -- RM Storage ----------------------------------------------------------
  listRmPending: (params: { search?: string; sku?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<Pallet[]>(`/api/v1/rm-storage/pending?${qs}`);
  },
  listRmStorageRecords: (search = "") => request<StorageRecordDetail[]>(`/api/v1/rm-storage/records?search=${encodeURIComponent(search)}`),
  getRmStorageRecord: (id: string) => request<StorageRecordDetail>(`/api/v1/rm-storage/records/${id}`),
  scanRmPallet: (payload: string) => request<Pallet>("/api/v1/rm-storage/scan-pallet", { method: "POST", body: JSON.stringify({ payload }) }),
  scanRmLocation: (payload: string) => request<{ id: string; display_id: string; zone: string }>("/api/v1/rm-storage/scan-location", { method: "POST", body: JSON.stringify({ payload }) }),
  confirmRmStorage: (palletPayload: string, locationPayload: string) =>
    request<StorageRecordDetail>("/api/v1/rm-storage/confirm", { method: "POST", body: JSON.stringify({ pallet_payload: palletPayload, location_payload: locationPayload }) }),

  // -- FG Storage ------------------------------------------------------------
  listFgPending: (params: { search?: string; sku?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<Pallet[]>(`/api/v1/fg-storage/pending?${qs}`);
  },
  listFgStorageRecords: (search = "") => request<StorageRecordDetail[]>(`/api/v1/fg-storage/records?search=${encodeURIComponent(search)}`),
  getFgStorageRecord: (id: string) => request<StorageRecordDetail>(`/api/v1/fg-storage/records/${id}`),
  scanFgPallet: (payload: string) => request<Pallet>("/api/v1/fg-storage/scan-pallet", { method: "POST", body: JSON.stringify({ payload }) }),
  scanFgLocation: (payload: string) => request<{ id: string; display_id: string; zone: string }>("/api/v1/fg-storage/scan-location", { method: "POST", body: JSON.stringify({ payload }) }),
  confirmFgStorage: (palletPayload: string, locationPayload: string) =>
    request<StorageRecordDetail>("/api/v1/fg-storage/confirm", { method: "POST", body: JSON.stringify({ pallet_payload: palletPayload, location_payload: locationPayload }) }),

  // -- Locations (reference, shared by RM + FG storage) --------------------
  listLocations: () => request<LocationRef[]>("/api/v1/locations"),

  // -- Machines (master data for Material Consumption) ---------------------
  machines: (includeInactive = false) =>
    request<Machine[]>(`/api/v1/machines${includeInactive ? "?include_inactive=true" : ""}`),
  createMachine: (code: string) => request<Machine>("/api/v1/machines", { method: "POST", body: JSON.stringify({ code }) }),
  updateMachine: (id: string, patch: { code?: string; is_active?: boolean }) =>
    request<Machine>(`/api/v1/machines/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteMachine: (id: string) => request<void>(`/api/v1/machines/${id}`, { method: "DELETE" }),

  // -- Material Consumption -------------------------------------------------
  listMaterialConsumption: (params: { search?: string; category?: string; date?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return request<MaterialConsumptionListItem[]>(`/api/v1/material-consumption?${qs}`);
  },
  materialConsumptionShifts: () => request<string[]>("/api/v1/material-consumption/shifts"),
  createMaterialConsumptionDraft: () =>
    request<MaterialConsumptionDetail>("/api/v1/material-consumption/draft", { method: "POST" }),
  getMaterialConsumption: (id: string) => request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}`),
  updateMaterialConsumptionBasic: (id: string, patch: { machine_id?: string; shift?: string; start_time?: string; end_time?: string }) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/basic`, { method: "PUT", body: JSON.stringify(patch) }),
  scanMaterialConsumptionPallet: (id: string, payload: string, clientTime?: string) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/scan-pallet`, { method: "POST", body: JSON.stringify({ payload, client_time: clientTime }) }),
  scanMaterialConsumptionSecondary: (id: string, payload: string, category: SecondaryMaterialCategory) =>
    request<MaterialConsumptionDetail>(`/api/v1/material-consumption/${id}/scan-secondary`, { method: "POST", body: JSON.stringify({ payload, category }) }),
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
