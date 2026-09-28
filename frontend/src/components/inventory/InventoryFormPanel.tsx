"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { SkuCode, Vendor } from "@/lib/types";

/**
 * "+ Add" -- a new Inventory item for a SKU that doesn't have one yet.
 * Most items appear automatically once their SKU's first Goods Receipt
 * container is inwarded (migration 0059); this is for the rest: a SKU
 * that needs an Inventory line before any PO exists for it, or with
 * stock on hand that predates Goods Receipt.
 */
export default function InventoryFormPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [skus, setSkus] = useState<SkuCode[]>([]);
  const [traySkus, setTraySkus] = useState<SkuCode[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  const [skuCodeId, setSkuCodeId] = useState("");
  const [uom, setUom] = useState("Kgs");
  const [traySkuIds, setTraySkuIds] = useState<string[]>([]);
  const [initialQty, setInitialQty] = useState("");
  const [vendorId, setVendorId] = useState("");
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
  }, []);

  async function handleSave() {
    if (!skuCodeId) { setError("Choose a SKU."); return; }
    setSaving(true);
    setError(null);
    try {
      await api.createInventoryItem({
        sku_code_id: skuCodeId,
        uom: uom.trim() || "Kgs",
        compatible_tray_sku_code_ids: traySkuIds,
        initial_quantity: initialQty ? Number(initialQty) : null,
        vendor_id: vendorId || null,
        supplier_country: country.trim() || null,
        note: note.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to create inventory item");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>Add Inventory Item</h2></div>
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
                  {skus.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                </select>
              </div>
              <div className="field">
                <label>UOM</label>
                <input value={uom} onChange={(e) => setUom(e.target.value)} placeholder="e.g. Kgs, Rolls, Pcs" />
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
            <h3>Initial Stock (optional)</h3>
            <div className="hint-text" style={{ marginBottom: 10 }}>
              Only needed if this SKU already has stock on hand from before Goods Receipt. Leave blank to start at zero and let Goods Receipt fill it in.
            </div>
            <div className="form-grid">
              <div className="field">
                <label>Quantity</label>
                <input type="number" value={initialQty} onChange={(e) => setInitialQty(e.target.value)} />
              </div>
              <div className="field">
                <label>Supplier</label>
                <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">— none —</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
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
