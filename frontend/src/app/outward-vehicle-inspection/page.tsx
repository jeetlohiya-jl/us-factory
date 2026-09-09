"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { OviDetail, OviListItem } from "@/lib/types";
import OviPanel from "@/components/outward-vehicle-inspection/OviPanel";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";

const MODULE = "ovi";

function StatusBadge({ status }: { status: string }) {
  const cls = status === "approved" ? "approved" : status === "hold" ? "hold" : status === "pending" ? "pending" : "draft";
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`badge ${cls}`}>{label}</span>;
}

export default function OutwardVehicleInspectionPage() {
  return (
    <Suspense fallback={null}>
      <OviPageContent />
    </Suspense>
  );
}

function OviPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const perms = me?.permissions.outward_vehicle_inspection;

  const [items, setItems] = useState<OviListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fDate, setFDate] = useState("");
  const [fStatus, setFStatus] = useState("");

  const [openRecord, setOpenRecord] = useState<OviDetail | null>(null);
  const [panelMode, setPanelMode] = useState<"view" | "edit">("edit");
  const [deleteTarget, setDeleteTarget] = useState<OviListItem | null>(null);

  const canView = (s: string) => s === "hold" || s === "approved";
  const activeFilterCount = (fDate ? 1 : 0) + (fStatus ? 1 : 0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = listCacheKey(MODULE, { search, status: fStatus, date: fDate });
      const res = await cachedList(key, () => api.listOvi({ search, status: fStatus, date: fDate }));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, fStatus, fDate]);

  useImmediateThenDebounced(refresh, [refresh]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  async function openDetail(id: string, mode: "view" | "edit") {
    try {
      const rec = await api.getOvi(id);
      setOpenRecord(rec);
      setPanelMode(mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  function handleRowClick(item: OviListItem) {
    openDetail(item.id, canView(item.status) ? "view" : "edit");
  }

  useEffect(() => {
    const openId = searchParams.get("open");
    if (openId) {
      api.getOvi(openId).then((rec) => {
        setOpenRecord(rec);
        setPanelMode(canView(rec.status) ? "view" : "edit");
      }).catch((e) => setError(e instanceof Error ? e.message : "Failed to load record"));
      router.replace("/outward-vehicle-inspection");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteOvi(deleteTarget.id);
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
          <h1>Outward Vehicle Inspection</h1>
          <div className="desc">Every outward vehicle inspection record created to date. Search, filter, or open a record to view it in full.</div>
        </div>
        <span className="auto-note">Records are created automatically from Customer Shipment.</span>
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
              <div className="f-row"><label>Status</label>
                <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                  <option value="">All</option>
                  <option value="pending">Pending</option>
                  <option value="draft">Draft</option>
                  <option value="approved">Approved</option>
                  <option value="hold">Hold</option>
                </select>
              </div>
              <div className="f-actions">
                <button className="btn-tertiary" onClick={() => { setFDate(""); setFStatus(""); }}>Clear all</button>
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
            <tr><th>Shipment Number</th><th>Invoice No.</th><th>Status</th><th>Date</th><th></th></tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={5}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} className={r.status === "pending" ? "row-pending" : ""} style={{ cursor: "pointer" }} onClick={() => handleRowClick(r)}>
                  <td className="mono">{r.shipment_number || "—"}</td>
                  <td>{r.invoice_number || "—"}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.date ? new Date(r.date).toLocaleDateString() : "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu canDelete={!!perms?.can_delete} onDelete={() => setDeleteTarget(r)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openRecord && (
        <OviPanel
          record={openRecord}
          mode={panelMode}
          canFill={!!perms?.can_fill_section}
          onClose={() => setOpenRecord(null)}
          onSaved={refreshAfterMutation}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this record?"
          message={`This will permanently delete the Outward Vehicle Inspection record for shipment "${deleteTarget.shipment_number || deleteTarget.id.slice(0, 8)}". This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
