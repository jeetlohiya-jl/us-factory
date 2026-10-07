"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { InventoryListItem, SkuCode, Vendor } from "@/lib/types";

/**
 * "+ Add" -- stock into Inventory:
 *  - a SKU already in Inventory: records a NEW ARRIVAL (quantity, supplier,
 *    country, note) and its total goes up by it (200 + 500 = 700);
 *  - a SKU not in Inventory yet: creates its item, optionally with stock.
 * The supplier is picked from Setup -> Vendors or typed in (a new supplier).
 * Most stock still arrives automatically via Goods Receipt inward.
 */
export default function InventoryFormPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [skus, setSkus] = useState<SkuCode[]>([]);
  const [traySkus, setTraySkus] = useState<SkuCode[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  const [skuCodeId, setSkuCodeId] = useState("");
  const [traySkuIds, setTraySkuIds] = useState<string[]>([]);
  const [initialQty, setInitialQty] = useState("");
  const [vendorId, setVendorId] = useState("");          // "" none, "__new" typed-in supplier
  const [newSupplier, setNewSupplier] = useState("");
  const [items, setItems] = useState<InventoryListItem[]>([]);
  const [country, setCountry] = useState("");
  const [note, setNote] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleTray(id: string) {
    setTraySkuIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  useEffect(() => {
    api.skus({ includeInactive: false }).then(setSkus).catch(() => {});
    api.skus({ category: "tray" }).then(setTraySkus).catch(() => {});
    api.vendors({ includeInactive: false }).then(setVendors).catch(() => {});
    api.listInventory("", 1, 500).then((r) => setItems(r.items)).catch(() => {});
  }, []);

  // UOM (and SKU Code) come from the chosen SKU -- set in Setup -> SKUs.
  const chosen = skus.find((s) => s.id === skuCodeId);
  const existing = items.find((i) => i.sku_code_id === skuCodeId) || null;
  const uom = (existing?.uom || chosen?.default_unit || "").trim();
  const qtyNum = initialQty ? Number(initialQty) : 0;
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 3 });

  async function handleSave() {
    if (!skuCodeId) { setError("Choose a SKU."); return; }
    if (!uom) { setError("This SKU has no UOM yet -- set it in Setup -> SKUs first."); return; }
    if (existing && !(qtyNum > 0)) { setError(`Enter the quantity received to add to ${chosen?.code || "this SKU"}.`); return; }
    if (vendorId === "__new" && !newSupplier.trim()) { setError("Enter the new supplier's name."); return; }
    setSaving(true);
    setError(null);
    try {
      await api.createInventoryItem({
        sku_code_id: skuCodeId,
        uom,
        compatible_tray_sku_code_ids: traySkuIds,
        initial_quantity: initialQty ? Number(initialQty) : null,
        vendor_id: vendorId && vendorId !== "__new" ? vendorId : null,
        vendor_name: vendorId === "__new" ? newSupplier.trim() : null,
        supplier_country: country.trim() || null,
        note: note.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>{existing ? "Add Stock" : "Add Inventory Item"}</h2></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>SKU</h3>
            <div className="form-grid">
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>SKU</label>
                <select value={skuCodeId} onChange={(e) => setSkuCodeId(e.target.value)}>
                  <option value="">— choose a SKU —</option>
                  {skus.map((s) => {
                    const inv = items.find((i) => i.sku_code_id === s.id);
                    return <option key={s.id} value={s.id}>{s.code}{inv ? ` — in stock: ${fmt(inv.quantity)} ${inv.uom}` : ""}</option>;
                  })}
                </select>
              </div>
              <div className="field">
                <label>SKU Code</label>
                <div className="readonly-val mono">{chosen ? chosen.sku_code || "—" : "—"}</div>
              </div>
              <div className="field">
                <label>UOM</label>
                <div className="readonly-val">{chosen ? uom || "Not set — set it in Setup → SKUs" : "—"}</div>
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Compatible Tray SKU(s)</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
                  {traySkus.map((s) => (
                    <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                      <input type="checkbox" checked={traySkuIds.includes(s.id)} onChange={() => toggleTray(s.id)} />
                      {s.code}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="detail-card">
            {existing ? (
              <>
                <h3>New Arrival</h3>
                <div className="hint-text" style={{ marginBottom: 10 }}>
                  In stock: <b>{fmt(existing.quantity)} {existing.uom}</b>
                  {qtyNum > 0 && <> · New total: <b>{fmt(existing.quantity + qtyNum)} {existing.uom}</b></>}
                </div>
              </>
            ) : (
              <>
                <h3>Initial Stock (optional)</h3>
                <div className="hint-text" style={{ marginBottom: 10 }}>
                  Only needed if this SKU already has stock on hand from before Goods Receipt. Leave blank to start at zero and let Goods Receipt fill it in.
                </div>
              </>
            )}
            <div className="form-grid">
              <div className="field">
                <label>{existing ? "Quantity Received" : "Quantity"}{uom ? ` (${uom})` : ""}{existing && <span style={{ color: "var(--red)" }}> *</span>}</label>
                <input type="number" value={initialQty} onChange={(e) => setInitialQty(e.target.value)} />
              </div>
              <div className="field">
                <label>Supplier</label>
                <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">— none —</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  <option value="__new">+ New supplier…</option>
                </select>
              </div>
              {vendorId === "__new" && (
                <div className="field">
                  <label>New Supplier Name <span style={{ color: "var(--red)" }}>*</span></label>
                  <input value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} placeholder="Supplier's name" />
                </div>
              )}
              <div className="field">
                <label>Supplier Country</label>
                <input placeholder="e.g. CN, US" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Note</label>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
              </div>
            </div>
          </div>
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <div className="sp-foot-right">
            <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Adding…" : "Add"}</button>
          </div>
        </div>
      </div>
    </>
  );
}
