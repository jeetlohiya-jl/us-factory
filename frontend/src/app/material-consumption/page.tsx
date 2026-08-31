"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { MaterialConsumptionListItem, MaterialConsumptionDetail, Machine } from "@/lib/types";
import MaterialConsumptionWizard, { nowHHMM, formatTime12h } from "@/components/material-consumption/Wizard";

const CATEGORY_LABELS: Record<string, string> = { tray: "Base Tray", fgtray: "FG Non-Padded Tray" };

export default function MaterialConsumptionPage() {
  const me = useMe();
  const perms = me?.permissions.material_consumption;
  const [records, setRecords] = useState<MaterialConsumptionListItem[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [shifts, setShifts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [openMc, setOpenMc] = useState<MaterialConsumptionDetail | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [recs, machineList, shiftList] = await Promise.all([
        api.listMaterialConsumption({ search, category, date }),
        api.machines(),
        api.materialConsumptionShifts(),
      ]);
      setRecords(recs);
      setMachines(machineList);
      setShifts(shiftList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, category, date]);

  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
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

  async function handleDelete(id: string, ev: React.MouseEvent) {
    ev.stopPropagation();
    if (!confirm("Delete this Material Consumption record?")) return;
    try {
      await api.deleteMaterialConsumption(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete record");
    }
  }

  /**
   * "Record End Time" -- captures this device's current time as end_time
   * and saves (finalizes) the record in one click, directly from the list.
   * Placed here (rather than inside the wizard) so the worker doesn't need
   * to reopen a record just to close it out -- press this the moment the
   * shift is actually done, from wherever the record is visible.
   */
  async function handleRecordEndTime(id: string, ev: React.MouseEvent) {
    ev.stopPropagation();
    setEndingId(id);
    setError(null);
    try {
      await api.updateMaterialConsumptionBasic(id, { end_time: nowHHMM() });
      await api.finalizeMaterialConsumption(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record end time");
    } finally {
      setEndingId(null);
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
        <div className="showing-count">{loading ? "Loading…" : `Showing ${records.length} of ${records.length} records`}</div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card card-flush">
        <table className="data compact">
          <thead>
            <tr>
              <th>Category</th><th>SKU Code</th><th>SKU Version</th><th>Pallet Numbers</th>
              <th>Machine</th><th>Date</th><th>Start – End Time</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr className="empty-row"><td colSpan={9}>{loading ? "Loading…" : "No Material Consumption records yet."}</td></tr>
            ) : (
              records.map((r) => {
                const canRecordEnd = perms?.can_edit && r.status === "draft" && !!r.start_time && !r.end_time
                  && r.pallet_numbers !== "(none scanned)";
                return (
                  <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => openRecord(r.id)}>
                    <td>{r.category ? (CATEGORY_LABELS[r.category] || r.category) : "—"}</td>
                    <td className="mono">{r.sku_code || "—"}</td>
                    <td>{r.sku_version || "—"}</td>
                    <td className="mono">{r.pallet_numbers}</td>
                    <td className="mono">{r.machine || "—"}</td>
                    <td>{r.consumption_date}</td>
                    <td className="mono">
                      {r.start_time ? formatTime12h(r.start_time) : "—"}
                      {r.start_time && (r.end_time ? ` – ${formatTime12h(r.end_time)}` : " – …")}
                    </td>
                    <td><span className={`badge ${r.status === "saved" ? "approved" : "draft"}`}>{r.status === "saved" ? "Saved" : "Draft"}</span></td>
                    <td style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                      {canRecordEnd && (
                        <button
                          type="button" className="btn btn-primary"
                          style={{ padding: "6px 12px", fontSize: 12, whiteSpace: "nowrap" }}
                          disabled={endingId === r.id}
                          onClick={(e) => handleRecordEndTime(r.id, e)}
                        >
                          {endingId === r.id ? "Recording…" : "Record End Time"}
                        </button>
                      )}
                      <a className="btn-tertiary" style={{ whiteSpace: "nowrap" }}>View →</a>
                      {perms?.can_delete && (
                        <a className="btn-tertiary" style={{ color: "var(--red)", whiteSpace: "nowrap" }} onClick={(e) => handleDelete(r.id, e)}>Delete</a>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {openMc && (
        <MaterialConsumptionWizard
          mcId={openMc.id}
          initialDetail={openMc}
          machines={machines}
          shifts={shifts}
          permissions={perms || { can_view: true, can_create: false, can_edit: false, can_delete: false, can_approve: false, can_fill_section: false }}
          onClose={() => setOpenMc(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
}
