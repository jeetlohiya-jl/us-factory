"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { Category, InspectionDetail, InspectionListItem, SkuCode } from "@/lib/types";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import Wizard from "@/components/inward-vehicle-inspection/Wizard";
import RecordDetail from "@/components/inward-vehicle-inspection/RecordDetail";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import Pagination from "@/components/Pagination";

const MODULE = "inward-vehicle-inspection";
const REFERENCE_STALE_MS = 5 * 60_000;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { draft: "Draft", approved: "Approved", hold: "Hold" };
  return <span className={`badge ${status}`}>{map[status] || status}</span>;
}

export default function InwardVehicleInspectionPage() {
  const me = useMe();
  const [skuCodes, setSkuCodes] = useState<SkuCode[]>([]);
  const [items, setItems] = useState<InspectionListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fDate, setFDate] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [page, setPage] = useState(1);

  const [wizardState, setWizardState] = useState<{ id: string; detail: InspectionDetail; isNew: boolean } | null>(null);
  const [detailState, setDetailState] = useState<InspectionDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InspectionListItem | null>(null);
  const [deleteBlockedMsg, setDeleteBlockedMsg] = useState<string | null>(null);

  const perms = me?.permissions.inward_vehicle_inspection;
  const activeFilterCount = (fDate ? 1 : 0) + (fCategory ? 1 : 0) + (fStatus ? 1 : 0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const key = listCacheKey(MODULE, { search, status: fStatus, category: fCategory, date: fDate, page });
      const res = await cachedList(key, () => api.listInspections({ search, status: fStatus, category: fCategory, date: fDate, page }));
      setItems(res.items);
      setMatchedCount(res.matched_count);
      setTotalCount(res.total_count);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, fStatus, fCategory, fDate, page]);

  useEffect(() => {
    cachedList("inward-vehicle-inspection-meta:skuCodes", () => api.skuCodes(), REFERENCE_STALE_MS).then(setSkuCodes).catch(() => setSkuCodes([]));
  }, []);

  useImmediateThenDebounced(refresh, [refresh]);

  useEffect(() => setPage(1), [search, fStatus, fCategory, fDate]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  async function handleNewRecord() {
    try {
      const detail = await api.createDraft("tray" as Category);
      setWizardState({ id: detail.id, detail, isNew: true });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to create record");
    }
  }

  async function openDetail(id: string) {
    try {
      const detail = await api.getInspection(id);
      setDetailState(detail);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  async function openEdit(id: string) {
    try {
      const detail = await api.getInspection(id);
      setDetailState(null);
      setWizardState({ id: detail.id, detail, isNew: false });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteInspection(deleteTarget.id);
      setDeleteTarget(null);
      refreshAfterMutation();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setDeleteBlockedMsg(e.message);
      } else {
        setDeleteBlockedMsg(e instanceof Error ? e.message : "Failed to delete record");
      }
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Inward Vehicle Inspection</h1>
          <div className="desc">Every vehicle inspection record created to date. Search, filter, or open a record to view it in full.</div>
        </div>
        <button
          className="btn btn-primary"
          disabled={!perms || !perms.can_create}
          title={perms && !perms.can_create ? "Only users with Create permission can add new records." : ""}
          onClick={handleNewRecord}
        >
          + New Record
        </button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search shipment no., invoice no., vehicle no…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className={`filter-btn ${activeFilterCount ? "has-active" : ""}`} onClick={() => setFiltersOpen((v) => !v)}>
              Filters {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
            </button>
            <div className={`filter-panel ${filtersOpen ? "open" : ""}`}>
              <div className="f-row"><label>Date</label><input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} /></div>
              <div className="f-row"><label>Category</label>
                <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
                  <option value="">All</option>
                  <option value="tray">Tray</option>
                  <option value="pad">Soaker Pad</option>
                  <option value="polybag">Polybag</option>
                  <option value="cfb">CFB</option>
                  <option value="glue">Glue</option>
                </select>
              </div>
              <div className="f-row"><label>Status</label>
                <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                  <option value="">All</option>
                  <option value="draft">Draft</option>
                  <option value="approved">Approved</option>
                  <option value="hold">Hold</option>
                </select>
              </div>
              <div className="f-actions">
                <button className="btn-tertiary" onClick={() => { setFDate(""); setFCategory(""); setFStatus(""); }}>Clear all</button>
              </div>
            </div>
          </div>
        </div>
        <div className="showing-count">
          {loading ? "Loading…" : `Showing ${matchedCount} of ${totalCount} records`}
        </div>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead>
            <tr><th>Shipment Number</th><th>Invoice No.</th><th>Actual Container Number</th><th>Status</th><th>Date</th><th></th></tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={6}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => openDetail(r.id)}>
                  <td className="mono">{r.shipment_number}</td>
                  <td>{r.invoice_number || "—"}</td>
                  <td className="mono">{r.container_number || "—"}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu
                      canEdit={!!perms?.can_edit}
                      canDelete={!!perms?.can_delete}
                      onEdit={() => openEdit(r.id)}
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

      {wizardState && perms && (
        <Wizard
          inspectionId={wizardState.id}
          initialDetail={wizardState.detail}
          skuCodes={skuCodes}
          permissions={perms}
          onClose={() => { setWizardState(null); refreshAfterMutation(); }}
          onSaved={refreshAfterMutation}
          isNew={wizardState.isNew}
        />
      )}

      {detailState && (
        <RecordDetail
          detail={detailState}
          canEdit={!!perms?.can_edit}
          onClose={() => setDetailState(null)}
          onEdit={() => { const id = detailState.id; setDetailState(null); openEdit(id); }}
        />
      )}

      {deleteTarget && !deleteBlockedMsg && (
        <ConfirmDialog
          title="Delete this record?"
          message={`This will permanently delete the Inward Vehicle Inspection record for shipment "${deleteTarget.shipment_number}". This cannot be undone.`}
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
