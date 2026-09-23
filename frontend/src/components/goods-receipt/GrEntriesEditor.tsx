"use client";
import { useState } from "react";
import type { GoodsReceiptEntryDraft, QuantityUnit, SkuCode } from "@/lib/types";
import { QUANTITY_UNITS } from "@/lib/types";

function newKey() {
  return `gr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function blankEntry(unit: QuantityUnit = "Units"): GoodsReceiptEntryDraft {
  return { key: newKey(), id: null, locked: false, shipment_number: "", sku_code_id: null, sku_version_id: null, po_quantity: "", unit };
}

/** "HA1" + 3 -> HA1, HA2, HA3 ; "V6" + 4 -> V6..V9 ; "SHP" + 2 -> SHP1, SHP2. */
function shipmentNumbers(first: string, count: number): string[] {
  const m = first.trim().toUpperCase().match(/^(.*?)(\d+)$/);
  const prefix = m ? m[1] : first.trim().toUpperCase();
  const start = m ? parseInt(m[2], 10) : 1;
  const width = m ? m[2].length : 1;
  return Array.from({ length: count }, (_, i) => `${prefix}${String(start + i).padStart(width, "0")}`);
}

/**
 * The PO's containers -- one row per container, identified by its Shipment
 * Number (HA1, V6, ...), exactly as the PO lists them. Same table/row
 * editor pattern as CsLineItemsEditor. Rows already inwarded are read-only
 * (they have pallets/QRs that reference them; the backend enforces the
 * same rule).
 *
 * "+ Add several containers" opens an optional shortcut that adds N rows at
 * once with consecutive shipment numbers (HA1 -> HA1..HA5) -- hidden until
 * asked for, so the default view is just the container table.
 */
export default function GrEntriesEditor({
  items, skuCodes, onChange,
}: {
  items: GoodsReceiptEntryDraft[];
  skuCodes: SkuCode[];
  onChange: (items: GoodsReceiptEntryDraft[]) => void;
}) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const [qaCount, setQaCount] = useState("");
  const [qaFirst, setQaFirst] = useState("");
  const [qaSku, setQaSku] = useState<string | null>(null);
  const [qaVersion, setQaVersion] = useState<string | null>(null);
  const [qaQty, setQaQty] = useState("");
  const [qaUnit, setQaUnit] = useState<QuantityUnit>("Units");

  function versionsFor(skuCodeId: string | null) {
    if (!skuCodeId) return [];
    return skuCodes.find((s) => s.id === skuCodeId)?.versions.filter((v) => v.is_active) || [];
  }

  function update(idx: number, patch: Partial<GoodsReceiptEntryDraft>) {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    if (patch.sku_code_id !== undefined) next[idx].sku_version_id = versionsFor(patch.sku_code_id)[0]?.id || null;
    onChange(next);
  }

  const qaCountNum = parseInt(qaCount, 10) || 0;
  const canQuickAdd = qaCountNum > 0 && qaCountNum <= 200 && !!qaFirst.trim() && !!qaSku && Number(qaQty) > 0;

  function quickAdd() {
    if (!canQuickAdd) return;
    const rows = shipmentNumbers(qaFirst, qaCountNum).map((sn) => ({
      ...blankEntry(qaUnit), shipment_number: sn, sku_code_id: qaSku, sku_version_id: qaVersion, po_quantity: qaQty,
    }));
    // Replace untouched blank rows instead of leaving them dangling.
    const kept = items.filter((it) => it.locked || it.id || it.shipment_number || it.sku_code_id || it.po_quantity);
    onChange([...kept, ...rows]);
    setQaCount(""); setQaFirst(""); setBulkOpen(false);
  }

  return (
    <div>
      {items.length === 0 ? (
        <div className="hint-text">No containers added yet.</div>
      ) : (
        <table className="qc-obs-table">
          <thead>
            <tr><th>Shipment Number</th><th>SKU</th><th>SKU Version</th><th>PO Quantity</th><th>Unit</th><th /></tr>
          </thead>
          <tbody>
            {items.map((item, i) =>
              item.locked ? (
                <tr key={item.key}>
                  <td className="mono">{item.shipment_number}</td>
                  <td className="mono">{skuCodes.find((s) => s.id === item.sku_code_id)?.code || "—"}</td>
                  <td className="mono">{versionsFor(item.sku_code_id).find((v) => v.id === item.sku_version_id)?.version || "—"}</td>
                  <td>{Number(item.po_quantity).toLocaleString()}</td>
                  <td>{item.unit}</td>
                  <td><span className="badge approved">Inwarded</span></td>
                </tr>
              ) : (
                <tr key={item.key}>
                  <td><input type="text" value={item.shipment_number} onChange={(e) => update(i, { shipment_number: e.target.value.toUpperCase() })} placeholder="e.g. HA1" /></td>
                  <td>
                    <select value={item.sku_code_id || ""} onChange={(e) => update(i, { sku_code_id: e.target.value || null })}>
                      <option value="">Select</option>
                      {skuCodes.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={item.sku_version_id || ""} onChange={(e) => update(i, { sku_version_id: e.target.value || null })}>
                      <option value="">Select</option>
                      {versionsFor(item.sku_code_id).map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
                    </select>
                  </td>
                  <td><input type="number" min={0} value={item.po_quantity} onChange={(e) => update(i, { po_quantity: e.target.value })} /></td>
                  <td>
                    <select value={item.unit} onChange={(e) => update(i, { unit: e.target.value as QuantityUnit })}>
                      {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </td>
                  <td><a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => onChange(items.filter((_, j) => j !== i))}>Remove</a></td>
                </tr>
              )
            )}
          </tbody>
        </table>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <button className="btn btn-secondary" onClick={() => onChange([...items, blankEntry()])}>+ Add Container</button>
        {!bulkOpen && <button className="btn btn-secondary" onClick={() => setBulkOpen(true)}>+ Add several containers</button>}
      </div>

      {bulkOpen && (
        <div className="detail-card" style={{ marginTop: 14 }}>
          <h3>Add several containers</h3>
          <div className="hint-text" style={{ marginBottom: 10 }}>
            Adds one row per container with consecutive shipment numbers — e.g. 5 starting at HA1 adds HA1, HA2, HA3, HA4, HA5.
          </div>
          <div className="form-grid">
            <div className="field"><label>Number of Containers</label>
              <input type="number" min={1} max={200} value={qaCount} onChange={(e) => setQaCount(e.target.value)} /></div>
            <div className="field"><label>First Shipment Number</label>
              <input type="text" value={qaFirst} onChange={(e) => setQaFirst(e.target.value.toUpperCase())} /></div>
            <div className="field"><label>SKU</label>
              <select value={qaSku || ""} onChange={(e) => { const id = e.target.value || null; setQaSku(id); setQaVersion(versionsFor(id)[0]?.id || null); }}>
                <option value="">Select</option>
                {skuCodes.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
              </select></div>
            <div className="field"><label>SKU Version</label>
              <select value={qaVersion || ""} onChange={(e) => setQaVersion(e.target.value || null)}>
                <option value="">Select</option>
                {versionsFor(qaSku).map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
              </select></div>
            <div className="field"><label>PO Quantity per Container</label>
              <input type="number" min={0} value={qaQty} onChange={(e) => setQaQty(e.target.value)} /></div>
            <div className="field"><label>Unit</label>
              <select value={qaUnit} onChange={(e) => setQaUnit(e.target.value as QuantityUnit)}>
                {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select></div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" disabled={!canQuickAdd} onClick={quickAdd}>
              {canQuickAdd ? `Add ${qaCountNum} container${qaCountNum === 1 ? "" : "s"}` : "Add containers"}
            </button>
            <button className="btn btn-ghost" onClick={() => setBulkOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
