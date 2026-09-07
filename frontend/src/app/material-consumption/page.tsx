"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { MaterialConsumptionListItem, MaterialConsumptionDetail, Machine } from "@/lib/types";
import MaterialConsumptionWizard, { formatTime12h } from "@/components/material-consumption/Wizard";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";

const CATEGORY_LABELS: Record<string, string> = { tray: "Base Tray", fgtray: "FG Non-Padded Tray" };
const MODULE = "material-consumption";
// A static, never-changing list -- same constant Production's and IPQC's own
// pages already hardcode client-side (see app/production/page.tsx). It was
// previously served from `GET /api/v1/material-consumption/shifts`, whose
// entire implementation was `return SHIFTS` against a hardcoded Python list
// with no DB query and no business logic -- a full network round trip on
// every page load for a constant. Hardcoding it here removes that call.
const SHIFTS = ["Shift A", "Shift B", "Shift C"];

export default function MaterialConsumptionPage() {
  return (
    <Suspense fallback={null}>
      <MaterialConsumptionPageContent />
    </Suspense>
  );
}

function MaterialConsumptionPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const perms = me?.permissions.material_consumption;
  const [records, setRecords] = useState<MaterialConsumptionListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [openMc, setOpenMc] = useState<MaterialConsumptionDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MaterialConsumptionListItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = listCacheKey(MODULE, { search, category, date });
      const [recs, machineList] = await cachedList(key, () =>
        Promise.all([
          api.listMaterialConsumption({ search, category, date }),
          api.machines(),
        ])
      );
      setRecords(recs.items);
      setMatchedCount(recs.matched_count);
      setMachines(machineList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, category, date]);

  useImmediateThenDebounced(refresh, [refresh]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  async function handleNewRecord() {
    setError(null);
    try {
      const mc = await api.createMaterialConsumptionDraft();
      setOpenMc(mc);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create record");
    }
  }

  async function openRecord(id: string) {
    try {
      const mc = await api.getMaterialConsumption(id);
      setOpenMc(mc);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  // Deep-link support: Production's detail panel links to a machine
  // entry's source record as /material-consumption?open=<id>.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (openId) {
      openRecord(openId);
      router.replace("/material-consumption");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteMaterialConsumption(deleteTarget.id);
      setDeleteTarget(null);
      refreshAfterMutation();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete record");
    }
  }

  const filterCount = (category ? 1 : 0) + (date ? 1 : 0);

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Material Consumption</h1>
          <div className="desc">Every material consumption record created to date.</div>
        </div>
        <button className="btn btn-primary" disabled={!perms?.can_create} onClick={handleNewRecord}>+ New Record</button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search SKU, pallet, machine…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className="filter-btn" onClick={() => setShowFilters((v) => !v)}>
              Filters {filterCount > 0 && <span className="filter-count">{filterCount}</span>}
            </button>
            {showFilters && (
              <div className="filter-panel" style={{ display: "block" }}>
                <div className="field">
                  <label>Category</label>
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    <option value="">All</option>
                    <option value="tray">Base Tray</option>
                    <option value="fgtray">FG Non-Padded Tray</option>
                  </select>
                </div>
                <div className="field">
                  <label>Date</label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div className="f-actions">
                  <button className="btn-tertiary" onClick={() => { setCategory(""); setDate(""); }}>Clear all</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${records.length} of ${matchedCount} records`}</div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card card-flush">
        <table className="data compact">
          <thead>
            <tr>
              <th>Category</th><th>SKU Code</th><th>SKU Version</th><th>Pallet Numbers</th>
              <th>Shift</th><th>Date</th><th>Machines · Start – End Time</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr className="empty-row"><td colSpan={9}>{loading ? "Loading…" : "No Material Consumption records yet."}</td></tr>
            ) : (
              records.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => openRecord(r.id)}>
                  <td>{r.category ? (CATEGORY_LABELS[r.category] || r.category) : "—"}</td>
                  <td className="mono">{r.sku_code || "—"}</td>
                  <td>{r.sku_version || "—"}</td>
                  <td className="mono">{r.pallet_numbers}</td>
                  <td>{r.shift || "—"}</td>
                  <td>{r.consumption_date}</td>
                  <td className="mono">
                    {r.entries.length === 0 ? "—" : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {r.entries.map((e, i) => (
                          <div key={i}>
                            {e.machine || `Machine #${i + 1}`}: {e.start_time ? formatTime12h(e.start_time) : "—"}
                            {e.start_time && (e.end_time ? ` – ${formatTime12h(e.end_time)}` : " – …")}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td><span className={`badge ${r.status === "saved" ? "approved" : "draft"}`}>{r.status === "saved" ? "Saved" : "Draft"}</span></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu
                      canDelete={!!perms?.can_delete}
                      onDelete={() => setDeleteTarget(r)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openMc && (
        <MaterialConsumptionWizard
          mcId={openMc.id}
          initialDetail={openMc}
          machines={machines}
          shifts={SHIFTS}
          permissions={perms || { can_view: true, can_create: false, can_edit: false, can_delete: false, can_approve: false, can_fill_section: false }}
          onClose={() => setOpenMc(null)}
          onSaved={refreshAfterMutation}
        />
      )}

      {deleteTarget && !deleteError && (
        <ConfirmDialog
          title="Delete this record?"
          message="This will permanently delete this Material Consumption record. This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {deleteError && (
        <ConfirmDialog
          title="Can't delete this record"
          message=""
          blockedNote={deleteError}
          onCancel={() => { setDeleteError(null); setDeleteTarget(null); }}
        />
      )}
    </>
  );
}
