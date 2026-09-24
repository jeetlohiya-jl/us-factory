"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { GoodsReceiptDetail, GoodsReceiptListItem, SkuCode, Vendor } from "@/lib/types";
import { INWARD_CATEGORY_LABELS } from "@/lib/types";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import Pagination from "@/components/Pagination";
import GoodsReceiptFormPanel from "@/components/goods-receipt/GoodsReceiptFormPanel";
import GoodsReceiptDetailPanel from "@/components/goods-receipt/GoodsReceiptDetailPanel";
import { GoodsReceiptStatusBadge } from "@/components/goods-receipt/GoodsReceiptStatusBadge";
import { MODULE_NAMES } from "@/lib/terms";

const MODULE = "goods-receipt";
const REFERENCE_STALE_MS = 5 * 60_000;

/**
 * Factory OS Module 1 -- Goods Receipt dashboard. Same landing-page pattern
 * as every other module (heading, search + filters, showing count, table,
 * row click -> detail, "⋯" More menu, + New Record). A Draft row opens
 * straight into the form (it's still being filled in); every other row
 * opens the receiving/detail view, where containers are inwarded one by one.
 */
export default function GoodsReceiptPage() {
  const me = useMe();
  const perms = me?.permissions.goods_receipt;

  const [items, setItems] = useState<GoodsReceiptListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fStatus, setFStatus] = useState("");
  const [fDate, setFDate] = useState("");
  const [page, setPage] = useState(1);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [skuCodes, setSkuCodes] = useState<SkuCode[]>([]);

  // form: null = closed; { existing: null } = new; { existing } = edit
  const [form, setForm] = useState<{ existing: GoodsReceiptDetail | null } | null>(null);
  const [detail, setDetail] = useState<GoodsReceiptDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GoodsReceiptListItem | null>(null);
  const [deleteBlockedMsg, setDeleteBlockedMsg] = useState<string | null>(null);

  const activeFilterCount = (fStatus ? 1 : 0) + (fDate ? 1 : 0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { search, status: fStatus, date: fDate, page };
      const res = await cachedList(listCacheKey(MODULE, params), () => api.listGoodsReceipts(params));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, fStatus, fDate, page]);

  useImmediateThenDebounced(refresh, [refresh]);
  useEffect(() => setPage(1), [search, fStatus, fDate]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  // Reference data only when a form is actually opened (cached 5 min).
  function loadReference() {
    if (vendors.length === 0) api.vendors().then(setVendors).catch(() => setVendors([]));
    if (skuCodes.length === 0) {
      cachedList("goods-receipt-meta:skuCodes", () => api.skuCodes(), REFERENCE_STALE_MS).then(setSkuCodes).catch(() => setSkuCodes([]));
    }
  }

  function openNew() {
    loadReference();
    setForm({ existing: null });
  }

  async function openRecord(id: string, mode: "auto" | "edit" = "auto") {
    try {
      const rec = await api.getGoodsReceipt(id);
      if (mode === "edit" || rec.status === "draft") {
        loadReference();
        setDetail(null);
        setForm({ existing: rec });
      } else {
        setDetail(rec);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  function handleSaved(saved: GoodsReceiptDetail) {
    setForm(null);
    refreshAfterMutation();
    // A real (non-draft) save goes straight to the receiving view, so the
    // next action -- inwarding the containers that have arrived -- is one tap away.
    if (saved.status !== "draft") setDetail(saved);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteGoodsReceipt(deleteTarget.id);
      setDeleteTarget(null);
      refreshAfterMutation();
    } catch (e) {
      setDeleteBlockedMsg(e instanceof ApiError || e instanceof Error ? e.message : "Failed to delete record");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>{MODULE_NAMES.goods_receipt}</h1>
          <div className="desc">Receive purchase orders container by container — each inwarded container gets its own Raw Material pallet QRs.</div>
        </div>
        <button
          className="btn btn-primary"
          disabled={!perms?.can_create}
          title={perms && !perms.can_create ? "Only users with Create permission can add new records." : ""}
          onClick={openNew}
        >
          + New Record
        </button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search PO number, vendor…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className={`filter-btn ${activeFilterCount ? "has-active" : ""}`} onClick={() => setFiltersOpen((v) => !v)}>
              Filters {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
            </button>
            <div className={`filter-panel ${filtersOpen ? "open" : ""}`}>
              <div className="f-row">
                <label>Status</label>
                <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                  <option value="">All</option>
                  <option value="draft">Draft</option>
                  <option value="pending">Pending</option>
                  <option value="partial">Partially Inwarded</option>
                  <option value="received">Inwarded</option>
                </select>
              </div>
              <div className="f-row"><label>Date</label><input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} /></div>
              <div className="f-actions">
                <button className="btn-tertiary" onClick={() => { setFStatus(""); setFDate(""); }}>Clear all</button>
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
            <tr>
              <th>PO Number</th><th>Categories</th><th>Vendor</th><th>SKU(s)</th><th>Containers Inwarded</th>
              <th>Pallets Received</th><th>Status</th><th>Date</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={9}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} className={r.status === "draft" || r.status === "pending" ? "row-pending" : ""} style={{ cursor: "pointer" }} onClick={() => openRecord(r.id)}>
                  <td className="mono">
                    {r.po_number}
                    {r.from_zoho && <span className="badge draft" style={{ marginLeft: 6 }} title="Synced from Zoho Books">Zoho</span>}
                    {r.zoho_cancelled && <span className="badge hold" style={{ marginLeft: 6 }}>Cancelled in Zoho</span>}
                  </td>
                  <td>{r.categories.map((c) => INWARD_CATEGORY_LABELS[c]).join(", ") || "—"}</td>
                  <td>{r.vendor_name}</td>
                  <td className="mono">{r.sku_summary || "—"}</td>
                  <td>{r.inwarded_count} / {r.container_count}</td>
                  <td>{r.pallet_total}</td>
                  <td><GoodsReceiptStatusBadge status={r.status} /></td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu
                      canEdit={!!perms?.can_edit && r.status !== "received"}
                      onEdit={() => openRecord(r.id, "edit")}
                      canDelete={!!perms?.can_delete}
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

      {form && (
        <GoodsReceiptFormPanel
          existing={form.existing}
          vendors={vendors}
          skuCodes={skuCodes}
          onClose={() => setForm(null)}
          onSaved={handleSaved}
        />
      )}

      {detail && (
        <GoodsReceiptDetailPanel
          key={detail.id}
          detail={detail}
          canEdit={!!perms?.can_edit}
          canReceive={!!perms?.can_fill_section}
          onClose={() => setDetail(null)}
          onEdit={() => openRecord(detail.id, "edit")}
          onChanged={refreshAfterMutation}
        />
      )}

      {deleteTarget && !deleteBlockedMsg && (
        <ConfirmDialog
          title="Delete this record?"
          message={`This will permanently delete the Goods Receipt for PO "${deleteTarget.po_number}". This cannot be undone.`}
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
