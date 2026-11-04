"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { InventoryListItem, Vendor } from "@/lib/types";

/**
 * "Adjust Inventory" -- add stock to, or deduct stock from, a SKU already in Inventory.
 *
 * Add: pick the item, enter the quantity received and who sent it (a vendor from
 * Setup -> Vendors, or a new supplier typed in). It's recorded as its own
 * stock entry on that item, and the item's total -- the sum of its entries
 * -- goes up by it (Face Mask 200 + 500 received = 700).
 * Deduct: the quantity comes off the item's total (breakage, a count correction ...),
 * recorded as its own entry with the reason; it can never take the item below zero.
 *
 * New Inventory items / SKUs are not created here -- admins set those up.
 */
export default function InventoryFormPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<InventoryListItem[] | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [direction, setDirection] = useState<"add" | "deduct">("add");
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [vendorId, setVendorId] = useState("");          // "" none, "__new" typed-in supplier
  const [newSupplier, setNewSupplier] = useState("");
  const [country, setCountry] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Every Inventory item, page by page (the list returns at most 200 a page).
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
    api.vendors({ includeInactive: false }).then(setVendors).catch(() => {});
  }, []);

  const item = items?.find((i) => i.id === itemId) || null;
  const qtyNum = qty ? Number(qty) : 0;
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 3 });

  async function handleSave() {
    setError(null);
    if (!item) { setError("Choose the SKU the stock is for."); return; }
    const deduct = direction === "deduct";
    if (!(qtyNum > 0)) { setError(deduct ? "Enter the quantity to deduct." : "Enter the quantity received."); return; }
    if (deduct && qtyNum > item.quantity) { setError(`Cannot deduct ${fmt(qtyNum)}: only ${fmt(item.quantity)} ${item.uom} in stock.`); return; }
    if (!deduct && vendorId === "__new" && !newSupplier.trim()) { setError("Enter the new supplier's name."); return; }
    setSaving(true);
    try {
      await api.addInventorySource(item.id, deduct ? {
        quantity: qtyNum, direction: "deduct", note: note.trim() || null,
      } : {
        quantity: qtyNum,
        vendor_id: vendorId && vendorId !== "__new" ? vendorId : null,
        vendor_name: vendorId === "__new" ? newSupplier.trim() : null,
        supplier_country: country.trim() || null,
        note: note.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to adjust Inventory");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>Adjust Inventory</h2></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>Adjustment</h3>
            <div className="form-grid">
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Action <span style={{ color: "var(--red)" }}>*</span></label>
                <div style={{ display: "flex", gap: 16 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                    <input type="radio" name="inv-dir" checked={direction === "add"} onChange={() => setDirection("add")} /> Add stock
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}>
                    <input type="radio" name="inv-dir" checked={direction === "deduct"} onChange={() => setDirection("deduct")} /> Deduct stock
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div className="detail-card">
            <h3>SKU</h3>
            <div className="form-grid">
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>SKU <span style={{ color: "var(--red)" }}>*</span></label>
                <select value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={!items}>
                  <option value="">{items ? "Select" : "Loading…"}</option>
                  {(items || []).map((i) => (
                    <option key={i.id} value={i.id}>{i.sku} — {fmt(i.quantity)} {i.uom}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>SKU Code</label>
                <div className="readonly-val mono">{item?.sku_code || "—"}</div>
              </div>
              <div className="field">
                <label>UOM</label>
                <div className="readonly-val">{item?.uom || "—"}</div>
              </div>
            </div>
          </div>

          <div className="detail-card">
            <h3>{direction === "deduct" ? "Stock Deducted" : "Stock Received"}</h3>
            {item && (
              <div className="hint-text" style={{ marginBottom: 10 }}>
                In stock: <b>{fmt(item.quantity)} {item.uom}</b>
                {qtyNum > 0 && <> → New total: <b>{fmt(direction === "deduct" ? item.quantity - qtyNum : item.quantity + qtyNum)} {item.uom}</b></>}
              </div>
            )}
            <div className="form-grid">
              <div className="field">
                <label>{direction === "deduct" ? "Quantity to Deduct" : "Quantity Received"}{item ? ` (${item.uom})` : ""} <span style={{ color: "var(--red)" }}>*</span></label>
                <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
              </div>
              {direction === "add" && (<>
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
              </>)}
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>{direction === "deduct" ? "Reason" : "Note"}</label>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={direction === "deduct" ? "e.g. damaged, count correction" : "Optional"} />
              </div>
            </div>
          </div>
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !items} onClick={handleSave}>{saving ? "Saving…" : direction === "deduct" ? "Deduct Stock" : "Add Stock"}</button>
        </div>
      </div>
    </>
  );
}
