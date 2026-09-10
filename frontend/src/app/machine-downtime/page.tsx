"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { Machine, MachineDowntimeRecord } from "@/lib/types";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import MachineDowntimePanel, { formatDuration } from "@/components/machine-downtime/MachineDowntimePanel";
import MachineDowntimeDetailPanel from "@/components/machine-downtime/MachineDowntimeDetailPanel";
import Pagination from "@/components/Pagination";

const MODULE = "machine-downtime";
const REFERENCE_STALE_MS = 5 * 60_000;

export default function MachineDowntimePage() {
  const me = useMe();
  const perms = me?.permissions.machine_downtime;

  const [machines, setMachines] = useState<Machine[]>([]);
  const [items, setItems] = useState<MachineDowntimeRecord[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fDate, setFDate] = useState("");
  const [fMachine, setFMachine] = useState("");
  const [fShift, setFShift] = useState("");
  const [page, setPage] = useState(1);

  const [panelState, setPanelState] = useState<{ record: MachineDowntimeRecord | null } | null>(null);
  const [detailRecord, setDetailRecord] = useState<MachineDowntimeRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MachineDowntimeRecord | null>(null);

  const activeFilterCount = (fDate ? 1 : 0) + (fMachine ? 1 : 0) + (fShift ? 1 : 0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = listCacheKey(MODULE, { search, date: fDate, machine: fMachine, shift: fShift, page });
      const res = await cachedList(key, () => api.listMachineDowntime({ search, date: fDate, machine: fMachine, shift: fShift, page }));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, fDate, fMachine, fShift, page]);

  useImmediateThenDebounced(refresh, [refresh]);

  useEffect(() => setPage(1), [search, fDate, fMachine, fShift]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  function openNewPanel() {
    if (machines.length === 0) {
      cachedList("machine-downtime-meta:machines", () => api.machines(), REFERENCE_STALE_MS).then(setMachines).catch(() => setMachines([]));
    }
    setPanelState({ record: null });
  }

  function openEditPanel(record: MachineDowntimeRecord) {
    if (machines.length === 0) {
      cachedList("machine-downtime-meta:machines", () => api.machines(), REFERENCE_STALE_MS).then(setMachines).catch(() => setMachines([]));
    }
    setPanelState({ record });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteMachineDowntime(deleteTarget.id);
      setDeleteTarget(null);
      refreshAfterMutation();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to delete record");
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Machine Downtime</h1>
          <div className="desc">Every machine downtime record created to date.</div>
        </div>
        <button
          className="btn btn-primary"
          disabled={!perms || !perms.can_create}
          title={perms && !perms.can_create ? "Only Admins can add new Machine Downtime records." : ""}
          onClick={openNewPanel}
        >
          + New Record
        </button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search machine, reason…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className={`filter-btn ${activeFilterCount ? "has-active" : ""}`} onClick={() => setFiltersOpen((v) => !v)}>
              Filters {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
            </button>
            <div className={`filter-panel ${filtersOpen ? "open" : ""}`}>
              <div className="f-row"><label>Date</label><input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} /></div>
              <div className="f-row"><label>Machine</label>
                <select value={fMachine} onChange={(e) => setFMachine(e.target.value)}>
                  <option value="">All</option>
                  {machines.map((m) => <option key={m.id} value={m.code}>{m.code}</option>)}
                </select>
              </div>
              <div className="f-row"><label>Shift</label>
                <select value={fShift} onChange={(e) => setFShift(e.target.value)}>
                  <option value="">All</option>
                  <option value="Shift A">Shift A</option>
                  <option value="Shift B">Shift B</option>
                  <option value="Shift C">Shift C</option>
                </select>
              </div>
              <div className="f-actions">
                <button className="btn-tertiary" onClick={() => { setFDate(""); setFMachine(""); setFShift(""); }}>Clear all</button>
              </div>
            </div>
          </div>
        </div>
        <div className="showing-count">
          {loading ? "Loading…" : `Showing ${matchedCount} record${matchedCount === 1 ? "" : "s"}`}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead>
            <tr><th>Machine</th><th>Shift</th><th>Start</th><th>End</th><th>Duration</th><th>Reason</th><th>Date</th><th></th></tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={8}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setDetailRecord(r)}>
                  <td>{r.machine || "—"}</td>
                  <td>{r.shift || "—"}</td>
                  <td>{r.start_time || "—"}</td>
                  <td>{r.end_time || "—"}</td>
                  <td>{formatDuration(r.duration_minutes)}</td>
                  <td>{r.reason || "—"}</td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu
                      canEdit={!!perms?.can_edit}
                      canDelete={!!perms?.can_delete}
                      onEdit={() => openEditPanel(r)}
                      onDelete={() => setDeleteTarget(r)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination page={page} pageSize={50} matchedCount={matchedCount} onPageChange={setPage} loading={loading} />
      </div>

      {panelState && (
        <MachineDowntimePanel
          machines={machines}
          record={panelState.record}
          onClose={() => setPanelState(null)}
          onSaved={refreshAfterMutation}
        />
      )}

      {detailRecord && (
        <MachineDowntimeDetailPanel record={detailRecord} onClose={() => setDetailRecord(null)} />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this record?"
          message={`This will permanently delete the Machine Downtime record for "${deleteTarget.machine || "this machine"}". This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
