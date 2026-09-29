"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { InventoryDetail, SkuCode, Vendor } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/terms";

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

/**
 * Opening an Inventory item shows the SKU-level facts plus, underneath,
 * every source line (Goods Receipt container or manual entry) behind the
 * clubbed quantity -- supplier, country, PO -- so clubbing by SKU on the
 * dashboard never loses that traceability. UOM and Compatible Tray SKU
 * are editable right here (Edit); a manual source can be added (Add) for
 * a delivery with no PO behind it yet, or a correction -- PO-backed
 * quantity itself only ever arrives automatically via Goods Receipt.
 */
export default function InventoryDetailPanel({
  item, canEdit, onClose, onChanged,
}: {
  item: InventoryDetail;
  canEdit: boolean;
  onClose: () => void;
  onChanged: (updated: InventoryDetail) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [uom, setUom] = useState(item.uom);
  const [traySkuIds, setTraySkuIds] = useState<string[]>(item.compatible_trays.map((t) => t.id));
  const [traySkus, setTraySkus] = useState<SkuCode[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [addingSource, setAddingSource] = useState(false);
  const [srcQty, setSrcQty] = useState("");
  const [srcVendorId, setSrcVendorId] = useState("");
  const [srcCountry, setSrcCountry] = useState("");
  const [srcNote, setSrcNote] = useState("");
  const [vendors, setVendors] = useState<Vendor[]>([]);

  useEffect(() => {
    setUom(item.uom);
    setTraySkuIds(item.compatible_trays.map((t) => t.id));
  }, [item]);

  function toggleTray(id: string) {
    setTraySkuIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  useEffect(() => {
    // Tray-family SKUs (RM / LNP Tray / FG) for the "Compatible
    // Tray SKU" dropdown -- same family filter skus/page.tsx and Goods
    // Receipt use for tray rows.
    api.skus({ category: "tray" }).then(setTraySkus).catch(() => {});
    api.vendors({ includeInactive: false }).then(setVendors).catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateInventoryItem(item.id, {
        uom: uom.trim() || undefined,
        compatible_tray_sku_code_ids: traySkuIds,
      });
      onChanged(updated);
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddSource() {
    const quantity = Number(srcQty);
    if (!quantity || quantity <= 0) {
      setError("Enter a quantity greater than 0.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.addInventorySource(item.id, {
        quantity,
        vendor_id: srcVendorId || null,
        supplier_country: srcCountry.trim() || null,
        note: srcNote.trim() || null,
      });
      onChanged(updated);
      setAddingSource(false);
      setSrcQty(""); setSrcVendorId(""); setSrcCountry(""); setSrcNote("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to add source");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{item.sku}</h2>
            <div className="sub mono">{item.sku_code || "—"} · {CATEGORY_LABELS[item.category] || item.category}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Inventory</h3>
              {canEdit && !editing && <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>}
            </div>
            {!editing ? (
              <div className="detail-grid">
                <Kv label="Quantity" value={item.quantity.toLocaleString()} />
                <Kv label="UOM" value={item.uom} />
                <Kv
                  label="Compatible Tray SKU(s)"
                  value={item.compatible_trays.length > 0 ? item.compatible_trays.map((t) => t.code).join(", ") : null}
                />
              </div>
            ) : (
              <div className="form-grid">
                <div className="field">
                  <label>UOM</label>
                  <input value={uom} onChange={(e) => setUom(e.target.value)} />
                </div>
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label>Compatible Tray SKU(s)</label>
                  <div className="hint-text" style={{ marginBottom: 6 }}>A material can pair with more than one tray — check every tray it's compatible with.</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
                    {traySkus.map((s) => (
                      <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                        <input type="checkbox" checked={traySkuIds.includes(s.id)} onChange={() => toggleTray(s.id)} />
                        {s.code}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="field" style={{ gridColumn: "1 / -1", display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn btn-ghost" onClick={() => { setEditing(false); setUom(item.uom); setTraySkuIds(item.compatible_trays.map((t) => t.id)); }}>Cancel</button>
                  <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Saving…" : "Save"}</button>
                </div>
              </div>
            )}
          </div>

          <div className="detail-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Sources</h3>
              {canEdit && !addingSource && <button className="btn btn-ghost" onClick={() => setAddingSource(true)}>+ Add Source</button>}
            </div>
            <div className="hint-text" style={{ marginBottom: 10 }}>
              Every supplier delivery behind this SKU's clubbed quantity — PO-backed rows arrive automatically when a Goods Receipt container is inwarded; a manual row is for stock with no PO behind it yet, or a correction.
            </div>
            {addingSource && (
              <div className="form-grid" style={{ marginBottom: 14 }}>
                <div className="field">
                  <label>Quantity</label>
                  <input type="number" value={srcQty} onChange={(e) => setSrcQty(e.target.value)} />
                </div>
                <div className="field">
                  <label>Supplier</label>
                  <select value={srcVendorId} onChange={(e) => setSrcVendorId(e.target.value)}>
                    <option value="">— none —</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Supplier Country</label>
                  <input placeholder="e.g. CN, US" value={srcCountry} onChange={(e) => setSrcCountry(e.target.value.toUpperCase())} maxLength={2} />
                </div>
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label>Note</label>
                  <input value={srcNote} onChange={(e) => setSrcNote(e.target.value)} placeholder="Optional" />
                </div>
                <div className="field" style={{ gridColumn: "1 / -1", display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button className="btn btn-ghost" onClick={() => setAddingSource(false)}>Cancel</button>
                  <button className="btn btn-primary" disabled={saving} onClick={handleAddSource}>{saving ? "Adding…" : "Add"}</button>
                </div>
              </div>
            )}
            <table className="qc-obs-table">
              <thead>
                <tr><th>Supplier</th><th>Country</th><th>Quantity</th><th>PO / Shipment</th><th>Added</th></tr>
              </thead>
              <tbody>
                {item.sources.length === 0 ? (
                  <tr className="empty-row"><td colSpan={5}>No sources recorded yet.</td></tr>
                ) : (
                  item.sources.map((s) => (
                    <tr key={s.id}>
                      <td>{s.vendor_name || "—"}</td>
                      <td className="mono">{s.supplier_country || "—"}</td>
                      <td>{s.quantity.toLocaleString()} {s.unit}</td>
                      <td className="mono">{s.po_number ? `${s.po_number} / ${s.shipment_number || "—"}` : s.is_manual ? "Manual" : "—"}</td>
                      <td>{new Date(s.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
