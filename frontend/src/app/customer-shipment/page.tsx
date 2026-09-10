"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { CustomerShipmentDetail, CustomerShipmentListItem, SkuCode } from "@/lib/types";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import NewCustomerShipmentPanel from "@/components/customer-shipment/NewCustomerShipmentPanel";
import CustomerShipmentDetailPanel from "@/components/customer-shipment/CustomerShipmentDetailPanel";
import Pagination from "@/components/Pagination";

const MODULE = "customer-shipment";
const REFERENCE_STALE_MS = 5 * 60_000;

export default function CustomerShipmentPage() {
  const me = useMe();
  const perms = me?.permissions.customer_shipment;

  const [skuCodes, setSkuCodes] = useState<SkuCode[]>([]);
  const [items, setItems] = useState<CustomerShipmentListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fDate, setFDate] = useState("");
  const [page, setPage] = useState(1);

  const [newPanelOpen, setNewPanelOpen] = useState(false);
  const [detail, setDetail] = useState<CustomerShipmentDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomerShipmentListItem | null>(null);
  const [deleteBlockedMsg, setDeleteBlockedMsg] = useState<string | null>(null);

  const activeFilterCount = fDate ? 1 : 0;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = listCacheKey(MODULE, { search, date: fDate, page });
      const res = await cachedList(key, () => api.listCustomerShipments({ search, date: fDate, page }));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, fDate, page]);

  useImmediateThenDebounced(refresh, [refresh]);

  useEffect(() => setPage(1), [search, fDate]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  function openNewPanel() {
    if (skuCodes.length === 0) {
      cachedList("customer-shipment-meta:skuCodes", () => api.skuCodes(), REFERENCE_STALE_MS).then(setSkuCodes).catch(() => setSkuCodes([]));
    }
    setNewPanelOpen(true);
  }

  async function openDetail(id: string) {
    try {
      const rec = await api.getCustomerShipment(id);
      setDetail(rec);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteCustomerShipment(deleteTarget.id);
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
          <h1>Customer Shipment</h1>
          <div className="desc">Every customer shipment record created to date.</div>
        </div>
        <button
          className="btn btn-primary"
          disabled={!perms || !perms.can_create}
          title={perms && !perms.can_create ? "Only users with Create permission can add new records." : ""}
          onClick={openNewPanel}
        >
          + New Record
        </button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search customer, container number…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className={`filter-btn ${activeFilterCount ? "has-active" : ""}`} onClick={() => setFiltersOpen((v) => !v)}>
              Filters {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
            </button>
            <div className={`filter-panel ${filtersOpen ? "open" : ""}`}>
              <div className="f-row"><label>Date</label><input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} /></div>
              <div className="f-actions">
                <button className="btn-tertiary" onClick={() => setFDate("")}>Clear all</button>
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
            <tr><th>Shipment Number</th><th>Container Number</th><th>Customer</th><th>SKU Code(s)</th><th>No. of Pallets</th><th>Date</th><th></th></tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={7}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => openDetail(r.id)}>
                  <td className="mono">{r.shipment_number}</td>
                  <td className="mono">{r.container_number}</td>
                  <td>{r.customer}</td>
                  <td className="mono">{r.sku_summary || "—"}</td>
                  <td>{r.total_pallets}</td>
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

      {newPanelOpen && (
        <>
          <div className="panel-overlay open" onClick={() => setNewPanelOpen(false)} />
          <NewCustomerShipmentPanel
            skuCodes={skuCodes}
            onClose={() => setNewPanelOpen(false)}
            onSaved={refreshAfterMutation}
          />
        </>
      )}

      {detail && (
        <CustomerShipmentDetailPanel detail={detail} onClose={() => setDetail(null)} />
      )}

      {deleteTarget && !deleteBlockedMsg && (
        <ConfirmDialog
          title="Delete this record?"
          message={`This will permanently delete the Customer Shipment record "${deleteTarget.shipment_number}". This cannot be undone.`}
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
