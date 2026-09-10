"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { QrGenerationDetail, QrGenerationListItem } from "@/lib/types";
import QrGenerationPanel from "@/components/qr-generation/QrGenerationPanel";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import Pagination from "@/components/Pagination";

const MODULE = "rm-qr-generation";

export default function RmQrGenerationPage() {
  const me = useMe();
  const [items, setItems] = useState<QrGenerationListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fDate, setFDate] = useState("");
  const [fSku, setFSku] = useState("");
  const [page, setPage] = useState(1);

  const [detail, setDetail] = useState<QrGenerationDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QrGenerationListItem | null>(null);
  const [deleteBlockedMsg, setDeleteBlockedMsg] = useState<string | null>(null);

  const perms = me?.permissions.rm_qr_generation;
  const activeFilterCount = (fDate ? 1 : 0) + (fSku ? 1 : 0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const key = listCacheKey(MODULE, { search, date: fDate, sku: fSku, page });
      const res = await cachedList(key, () => api.listRmQr({ search, date: fDate, sku: fSku, page }));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, fDate, fSku, page]);

  useImmediateThenDebounced(refresh, [refresh]);

  useEffect(() => setPage(1), [search, fDate, fSku]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  async function openRecord(id: string) {
    try {
      const d = await api.getRmQr(id);
      setDetail(d);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  async function handleGenerate() {
    if (!detail) return;
    const updated = await api.generateRmQr(detail.id);
    setDetail(updated);
    refreshAfterMutation();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteRmQr(deleteTarget.id);
      setDeleteTarget(null);
      refreshAfterMutation();
    } catch (e) {
      setDeleteBlockedMsg(e instanceof Error ? e.message : "Failed to delete record");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>RM QR Generation</h1>
          <div className="desc">Every RM QR generation record created to date. Records auto-appear here as Pending once the linked Inward QC is approved.</div>
        </div>
        <span className="auto-note">Records are created automatically from approved Inward QC.</span>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search shipment no., SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className={`filter-btn ${activeFilterCount ? "has-active" : ""}`} onClick={() => setFiltersOpen((v) => !v)}>
              Filters {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
            </button>
            <div className={`filter-panel ${filtersOpen ? "open" : ""}`}>
              <div className="f-row"><label>Date</label><input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} /></div>
              <div className="f-row"><label>SKU Name</label><input type="text" placeholder="e.g. SKU-3P" value={fSku} onChange={(e) => setFSku(e.target.value)} /></div>
              <div className="f-actions"><button className="btn-tertiary" onClick={() => { setFDate(""); setFSku(""); }}>Clear all</button></div>
            </div>
          </div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${matchedCount} record${matchedCount === 1 ? "" : "s"}`}</div>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Shipment Number</th><th>SKU Name</th><th>SKU Version</th><th>Country</th><th>Quantity</th><th>Status</th><th>Date</th><th></th></tr></thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={8}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} className={r.status === "pending" ? "row-pending" : ""} style={{ cursor: "pointer" }} onClick={() => openRecord(r.id)}>
                  <td className="mono">{r.shipment_number}</td>
                  <td className="mono">{r.sku_code_snapshot}</td>
                  <td>{r.sku_version_snapshot}</td>
                  <td className="mono">{r.country_code || "—"}</td>
                  <td>{r.quantity}</td>
                  <td><span className={`badge ${r.status === "generated" ? "generated" : "pending"}`}>{r.status}</span></td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu canDelete={!!perms?.can_delete} onDelete={() => setDeleteTarget(r)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination page={page} pageSize={50} matchedCount={matchedCount} onPageChange={setPage} loading={loading} />
      </div>

      {detail && (
        <QrGenerationPanel
          title="RM QR Generation"
          detail={detail}
          canGenerate={!!perms?.can_edit}
          onGenerate={handleGenerate}
          onClose={() => setDetail(null)}
        />
      )}

      {deleteTarget && !deleteBlockedMsg && (
        <ConfirmDialog
          title="Delete this RM QR record?"
          message={`This will permanently delete the RM QR Generation record for shipment "${deleteTarget.shipment_number}". This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {deleteBlockedMsg && (
        <ConfirmDialog
          title="Can't delete this record"
          message=""
          blockedNote={deleteBlockedMsg}
          onCancel={() => { setDeleteBlockedMsg(null); setDeleteTarget(null); }}
        />
      )}
    </>
  );
}
