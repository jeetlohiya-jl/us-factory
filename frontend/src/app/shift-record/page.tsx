"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { ShiftRecordDetail, ShiftRecordListItem } from "@/lib/types";
import ShiftRecordForm from "@/components/shift-record/ShiftRecordForm";
import ShiftRecordDetailPanel from "@/components/shift-record/ShiftRecordDetail";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import Pagination from "@/components/Pagination";
import { MODULE_NAMES } from "@/lib/terms";

const MODULE = "shift-record";

/** Shift Record -- per shift and machine: materials used, FG trays produced, scrap. Migration 0103. */
export default function ShiftRecordPage() {
  const me = useMe();
  const perms = me?.permissions.shift_record;
  const [items, setItems] = useState<ShiftRecordListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);
  const [open, setOpen] = useState<ShiftRecordDetail | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = listCacheKey(MODULE, { search, date, page });
      const res = await cachedList(key, () => api.listShiftRecords({ search, date, page }));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Shift Records");
    } finally {
      setLoading(false);
    }
  }, [search, date, page]);

  useImmediateThenDebounced(refresh, [refresh]);
  useEffect(() => setPage(1), [search, date]);

  async function openRecord(id: string) {
    setGenerateError(null);
    try { setOpen(await api.getShiftRecord(id)); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to load the Shift Record"); }
  }

  async function doGenerate() {
    if (!open) return;
    setGenerating(true); setGenerateError(null);
    try {
      await api.generateShiftRecordFg(open.id);
      invalidateListCache(MODULE); refresh();
      await openRecord(open.id);
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : "Failed to generate the FG QRs");
    } finally { setGenerating(false); }
  }

  async function doDelete() {
    if (!open) return;
    try {
      await api.deleteShiftRecord(open.id);
      setConfirmDelete(false); setOpen(null);
      invalidateListCache(MODULE); refresh();
    } catch (e) {
      setConfirmDelete(false);
      setDeleteError(e instanceof Error ? e.message : "Failed to delete the Shift Record");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>{MODULE_NAMES.shift_record}</h1>
          <div className="desc">One entry per shift and machine: what was used, the FG trays produced and the scrap. Inventory and pallets update automatically.</div>
        </div>
        <button className="btn btn-primary" disabled={!perms?.can_create} onClick={() => setShowNew(true)}>+ New Record</button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search record, shift, SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="field" style={{ margin: "0 0 0 8px", width: 170 }}><input type="date" aria-label="Filter by date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${items.length} of ${matchedCount} records`}</div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card card-flush">
        <table className="data compact">
          <thead>
            <tr><th>Record</th><th>Date</th><th>Shift</th><th>Machine</th><th>Materials Used</th><th>FG SKU</th><th>Trays Produced (Finished)</th><th>FG Pallets</th><th>Loose</th><th>FG QRs</th><th>Scrap</th><th>Hold</th><th>By</th></tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={13}>{loading ? "Loading…" : "No Shift Records yet."}</td></tr>
            ) : items.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => openRecord(r.id)}>
                <td className="mono">{r.display_id}</td>
                <td>{r.record_date}</td>
                <td>{r.shift}</td>
                <td className="mono">{r.machine || "—"}</td>
                <td>{r.materials || "—"}</td>
                <td className="mono">{r.fg_sku_code || "—"}</td>
                <td>{r.trays_produced}</td>
                <td>{r.fg_generated_at ? r.fg_pallets : "—"}</td>
                <td>{r.fg_generated_at ? r.loose_trays : "—"}</td>
                <td>{r.fg_generated_at ? <span className="badge approved">Generated</span> : r.trays_produced > 0 ? <span className="badge draft">Pending</span> : "—"}</td>
                <td>{r.scrap_trays}</td>
                <td>{r.hold_trays}</td>
                <td>{r.recorded_by || "—"}<div className="hint-text">{new Date(r.recorded_at).toLocaleString()}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination page={page} pageSize={50} matchedCount={matchedCount} onPageChange={setPage} loading={loading} />
      </div>

      {showNew && (
        <ShiftRecordForm
          onClose={() => setShowNew(false)}
          onSaved={(id) => { setShowNew(false); invalidateListCache(MODULE); refresh(); openRecord(id); }}
        />
      )}
      {open && (
        <ShiftRecordDetailPanel record={open} canDelete={!!perms?.can_delete} canGenerate={!!perms?.can_create} generating={generating} generateError={generateError} onGenerate={doGenerate} onClose={() => setOpen(null)} onDelete={() => setConfirmDelete(true)} />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this Shift Record?"
          message="This puts the materials back on Inventory and in RM Storage, and removes the FG pallets it created (only possible while they are still unstored). This cannot be undone."
          confirmLabel="Delete" danger onConfirm={doDelete} onCancel={() => setConfirmDelete(false)}
        />
      )}
      {deleteError && <ConfirmDialog title="Can't delete this record" message="" blockedNote={deleteError} onCancel={() => setDeleteError(null)} />}
    </>
  );
}
