"use client";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { InventoryListItem } from "@/lib/types";

/**
 * "Update Stock" -- enter the current stock for one or many SKUs at once (a stock count).
 * Tick the SKUs, type each one's current stock, Save: every ticked SKU's stock becomes exactly that number
 * (recorded as an entry for the difference, with a note). There is no separate deduct: a lower count lowers the stock.
 */
export default function InventoryUpdateStockPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<InventoryListItem[] | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});   // item id -> entered current stock ("" = ticked, not typed yet)
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const all: InventoryListItem[] = [];
        for (let page = 1; page <= 20; page++) {
          const r = await api.listInventory("", page, 200);
          all.push(...r.items);
          if (all.length >= r.matched_count || r.items.length === 0) break;
        }
        all.sort((a, b) => a.sku.localeCompare(b.sku));
        setItems(all);
      } catch (e) {
        setItems([]);
        setError(e instanceof Error ? e.message : "Couldn't load Inventory items.");
      }
    })();
  }, []);

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items || []).filter((i) => !q || i.sku.toLowerCase().includes(q) || (i.sku_code || "").toLowerCase().includes(q));
  }, [items, search]);
  const ticked = Object.keys(picked);
  const allShownTicked = shown.length > 0 && shown.every((i) => i.id in picked);

  function toggle(id: string) {
    setPicked((p) => { const n = { ...p }; if (id in n) delete n[id]; else n[id] = ""; return n; });
  }
  function toggleAll() {
    setPicked((p) => {
      const n = { ...p };
      if (allShownTicked) shown.forEach((i) => delete n[i.id]);
      else shown.forEach((i) => { if (!(i.id in n)) n[i.id] = ""; });
      return n;
    });
  }

  async function handleSave() {
    setError(null);
    if (ticked.length === 0) { setError("Tick at least one SKU."); return; }
    const entries: { item_id: string; quantity: number }[] = [];
    for (const id of ticked) {
      const it = items?.find((i) => i.id === id);
      const raw = picked[id];
      if (raw === "" || !Number.isFinite(Number(raw)) || Number(raw) < 0) { setError(`Enter the current stock for ${it?.sku || "each ticked SKU"} (0 or more).`); return; }
      entries.push({ item_id: id, quantity: Number(raw) });
    }
    setSaving(true);
    try {
      await api.updateInventoryStock(entries);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to update stock");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open" style={{ width: "min(720px, 100vw)" }}>
        <div className="sp-head">
          <div><h2>Update Stock</h2></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="hint-text" style={{ marginBottom: 10 }}>
            Tick the SKUs you counted and enter the current stock for each. Saving sets each ticked SKU&apos;s stock to exactly that number. SKUs you don&apos;t tick are not touched.
          </div>
          <div className="search-box" style={{ marginBottom: 10 }}>
            <input type="text" placeholder="Search SKU, SKU Code…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <table className="data compact">
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" checked={allShownTicked} onChange={toggleAll} aria-label="Tick all shown" /></th>
                <th>SKU</th><th>UOM</th><th>In stock</th><th style={{ width: 160 }}>Current stock</th>
              </tr>
            </thead>
            <tbody>
              {!items ? (
                <tr className="empty-row"><td colSpan={5}>Loading…</td></tr>
              ) : shown.length === 0 ? (
                <tr className="empty-row"><td colSpan={5}>No SKUs.</td></tr>
              ) : shown.map((i) => (
                <tr key={i.id}>
                  <td><input type="checkbox" checked={i.id in picked} onChange={() => toggle(i.id)} /></td>
                  <td>{i.sku}{i.sku_code ? <span className="hint-text mono"> {i.sku_code}</span> : null}</td>
                  <td>{i.uom}</td>
                  <td>{fmt(i.quantity)}</td>
                  <td>
                    <input
                      type="number" min="0" step="any" disabled={!(i.id in picked)} value={picked[i.id] ?? ""}
                      onChange={(e) => setPicked((p) => ({ ...p, [i.id]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !items || ticked.length === 0} onClick={handleSave}>
            {saving ? "Saving…" : `Update ${ticked.length} SKU${ticked.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </>
  );
}
