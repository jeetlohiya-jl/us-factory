"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { InventoryListItem, InventoryDetail } from "@/lib/types";
import InventoryDetailPanel from "@/components/inventory/InventoryDetailPanel";
import InventoryFormPanel from "@/components/inventory/InventoryFormPanel";
import Pagination from "@/components/Pagination";
import { MODULE_NAMES } from "@/lib/terms";

const MODULE = "inventory";

/**
 * Inventory (2026-09-28) -- SKU-centric raw-material stock. The main
 * table is deliberately just SKU / SKU Code / UOM / Quantity (no Cirkla
 * Entity) -- opening a row is where the supplier/country/PO detail behind
 * that clubbed quantity lives (InventoryDetailPanel). Quantity here is
 * kept current automatically: every Goods Receipt container inward grows
 * the matching SKU's quantity (see migration 0059's
 * inventory_apply_receipt, called from goods_receipt_inward /
 * _inward_remaining) with no separate step needed on this screen.
 */
export default function InventoryPage() {
  const me = useMe();
  const perms = me?.permissions.inventory;

  const [items, setItems] = useState<InventoryListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [showAdd, setShowAdd] = useState(false);
  const [openItem, setOpenItem] = useState<InventoryDetail | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const key = listCacheKey(MODULE, { search, page });
      const res = await cachedList(key, () => api.listInventory(search, page));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load inventory");
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useImmediateThenDebounced(refresh, [refresh]);
  useEffect(() => setPage(1), [search]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  async function openInventoryItem(id: string) {
    try {
      const item = await api.getInventoryItem(id);
      setOpenItem(item);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load inventory item");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>{MODULE_NAMES.inventory}</h1>
          <div className="desc">Raw-material stock on hand, clubbed by SKU across every supplier. Grows automatically as Goods Receipt containers are inwarded.</div>
        </div>
        <button className="btn btn-primary" disabled={!perms?.can_create} onClick={() => setShowAdd(true)}>+ Add</button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search SKU, SKU Code…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${matchedCount} item${matchedCount === 1 ? "" : "s"}`}</div>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>SKU</th><th>SKU Code</th><th>UOM</th><th>Quantity</th></tr></thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={4}>{loading ? "Loading…" : "No inventory items yet."}</td></tr>
            ) : (
              items.map((it) => (
                <tr key={it.id} style={{ cursor: "pointer" }} onClick={() => openInventoryItem(it.id)}>
                  <td>{it.sku}</td>
                  <td className="mono">{it.sku_code || "—"}</td>
                  <td>{it.uom}</td>
                  <td>{it.quantity.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination page={page} pageSize={50} matchedCount={matchedCount} onPageChange={setPage} loading={loading} />
      </div>

      {showAdd && (
        <InventoryFormPanel
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); refreshAfterMutation(); }}
        />
      )}

      {openItem && (
        <InventoryDetailPanel
          item={openItem}
          canEdit={!!perms?.can_edit}
          onClose={() => setOpenItem(null)}
          onChanged={(updated) => { setOpenItem(updated); refreshAfterMutation(); }}
        />
      )}
    </>
  );
}
