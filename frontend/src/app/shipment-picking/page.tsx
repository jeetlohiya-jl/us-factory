"use client";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { ShipmentPickingDetail, ShipmentPickingListItem } from "@/lib/types";
import ShipmentPickingPanel from "@/components/shipment-picking/ShipmentPickingPanel";

const MODULE = "shipment-picking";

function SpStatusBadge({ status }: { status: string }) {
  const cls = status === "complete" ? "approved" : status === "partial" ? "partial" : "pending";
  const label = status === "complete" ? "Complete" : status === "partial" ? "Partial" : "Pending";
  return <span className={`badge ${cls}`}>{label}</span>;
}

/**
 * No "+ New Record" button here at all -- Shipment Picking requests are
 * only ever auto-created, one per Customer Shipment line item (spec point
 * 17). This page only lists them and opens the pick panel.
 */
export default function ShipmentPickingPage() {
  const me = useMe();
  const perms = me?.permissions.shipment_picking;

  const [items, setItems] = useState<ShipmentPickingListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fStatus, setFStatus] = useState("");

  const [openRequest, setOpenRequest] = useState<ShipmentPickingDetail | null>(null);

  const activeFilterCount = fStatus ? 1 : 0;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = listCacheKey(MODULE, { search, status: fStatus });
      const res = await cachedList(key, () => api.listShipmentPicking({ search, status: fStatus }));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, fStatus]);

  useImmediateThenDebounced(refresh, [refresh]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  async function openPick(id: string) {
    try {
      const rec = await api.getShipmentPicking(id);
      setOpenRequest(rec);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Shipment Picking</h1>
          <div className="desc">Every pick requirement created to date — pick requirements are generated per SKU/Version line item from Customer Shipment.</div>
        </div>
        <span className="auto-note">Pick requirements are created automatically from Customer Shipment.</span>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search shipment, customer, SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className={`filter-btn ${activeFilterCount ? "has-active" : ""}`} onClick={() => setFiltersOpen((v) => !v)}>
              Filters {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
            </button>
            <div className={`filter-panel ${filtersOpen ? "open" : ""}`}>
              <div className="f-row"><label>Status</label>
                <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                  <option value="">All</option>
                  <option value="pending">Pending</option>
                  <option value="partial">Partial</option>
                  <option value="complete">Complete</option>
                </select>
              </div>
              <div className="f-actions">
                <button className="btn-tertiary" onClick={() => setFStatus("")}>Clear all</button>
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
            <tr><th>Shipment Number</th><th>Customer</th><th>SKU Code</th><th>SKU Version</th><th>Qty Required</th><th>Qty Picked</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={8}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.shipment_number || "—"}</td>
                  <td>{r.customer || "—"}</td>
                  <td className="mono">{r.sku_code || "—"}</td>
                  <td>{r.sku_version || "—"}</td>
                  <td>{r.pallets_required}</td>
                  <td>{r.pallets_picked}</td>
                  <td><SpStatusBadge status={r.status} /></td>
                  <td>
                    <a
                      className="btn-tertiary"
                      title={r.status !== "complete" && !perms?.can_create ? "Only users with Create permission can pick pallets." : ""}
                      onClick={() => openPick(r.id)}
                    >
                      {r.status === "complete" ? "View" : "Pick"} →
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openRequest && (
        <ShipmentPickingPanel
          request={openRequest}
          onClose={() => setOpenRequest(null)}
          onChanged={refreshAfterMutation}
        />
      )}
    </>
  );
}
