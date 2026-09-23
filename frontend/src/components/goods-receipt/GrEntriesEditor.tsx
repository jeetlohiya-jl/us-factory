"use client";
import { useState } from "react";
import type { GoodsReceiptEntryDraft, QuantityUnit, SkuCode } from "@/lib/types";
import { QUANTITY_UNITS } from "@/lib/types";

function newKey() {
  return `gr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function blankEntry(unit: QuantityUnit = "Units"): GoodsReceiptEntryDraft {
  return {
    key: newKey(), id: null, locked: false, container_name: "", container_number: "",
    sku_code_id: null, sku_version_id: null, po_quantity: "", unit,
  };
}

/** "HA1" + 3 -> HA1, HA2, HA3 ; "V6" + 4 -> V6..V9 ; "CNT" + 2 -> CNT1, CNT2. */
function containerNames(first: string, count: number): string[] {
  const m = first.trim().toUpperCase().match(/^(.*?)(\d+)$/);
  const prefix = m ? m[1] : first.trim().toUpperCase();
  const start = m ? parseInt(m[2], 10) : 1;
  const width = m ? m[2].length : 1;
  return Array.from({ length: count }, (_, i) => `${prefix}${String(start + i).padStart(width, "0")}`);
}

/**
 * Container x SKU receiving entries for a Goods Receipt -- same table/row
 * editor pattern as CsLineItemsEditor (qc-obs-table, per-row selects,
 * "+ Add" button). Rows already inwarded are shown read-only: they have an
 * RM QR batch whose snapshots must never change (the backend enforces the
 * same rule).
 *
 * The quick-add row is the "Number of Containers" input: a PO typically
 * lists many identical containers of one SKU (CIPO-00570: HA1-HA5 of 3P,
 * V6-V9 of 3D), so N rows are generated at once with incrementing
 * container names, each still editable individually afterwards.
 */
export default function GrEntriesEditor({
  items, skuCodes, onChange,
}: {
  items: GoodsReceiptEntryDraft[];
  skuCodes: SkuCode[];
  onChange: (items: GoodsReceiptEntryDraft[]) => void;
}) {
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
  const canQuickAdd = qaCountNum > 0 && qaCountNum <= 200 && qaFirst.trim() && qaSku && Number(qaQty) > 0;

  function quickAdd() {
    if (!canQuickAdd) return;
    const rows = containerNames(qaFirst, qaCountNum).map((name) => ({
      ...blankEntry(qaUnit), container_name: name, sku_code_id: qaSku, sku_version_id: qaVersion,
      po_quantity: qaQty,
    }));
    // Replace a single untouched blank starter row instead of leaving it dangling.
    const kept = items.filter((it) => it.locked || it.id || it.container_name || it.sku_code_id || it.po_quantity);
    onChange([...kept, ...rows]);
    setQaCount("");
    setQaFirst("");
  }

  return (
    <div>
      <div className="hint-text" style={{ marginBottom: 8 }}>
        Quick add — one row per container, names numbered from the first one (e.g. HA1 → HA1, HA2, HA3…).
      </div>
      <table className="qc-obs-table" style={{ marginBottom: 14 }}>
        <thead>
          <tr><th>No. of Containers</th><th>First Container</th><th>SKU</th><th>SKU Version</th><th>PO Qty / Container</th><th>Unit</th><th /></tr>
        </thead>
        <tbody>
          <tr>
            <td><input type="number" min={1} max={200} value={qaCount} onChange={(e) => setQaCount(e.target.value)} placeholder="5" /></td>
            <td><input type="text" value={qaFirst} onChange={(e) => setQaFirst(e.target.value.toUpperCase())} placeholder="HA1" /></td>
            <td>
              <select value={qaSku || ""} onChange={(e) => { const id = e.target.value || null; setQaSku(id); setQaVersion(versionsFor(id)[0]?.id || null); }}>
                <option value="">Select</option>
                {skuCodes.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
              </select>
            </td>
            <td>
              <select value={qaVersion || ""} onChange={(e) => setQaVersion(e.target.value || null)}>
                <option value="">Select</option>
                {versionsFor(qaSku).map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
              </select>
            </td>
            <td><input type="number" min={0} value={qaQty} onChange={(e) => setQaQty(e.target.value)} placeholder="531960" /></td>
            <td>
              <select value={qaUnit} onChange={(e) => setQaUnit(e.target.value as QuantityUnit)}>
                {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </td>
            <td><button className="btn btn-secondary" disabled={!canQuickAdd} onClick={quickAdd}>Add</button></td>
          </tr>
        </tbody>
      </table>

      {items.length === 0 ? (
        <div className="hint-text">No containers added yet.</div>
      ) : (
        <table className="qc-obs-table">
          <thead>
            <tr><th>Container Name</th><th>Container Number</th><th>SKU</th><th>SKU Version</th><th>PO Quantity</th><th>Unit</th><th /></tr>
          </thead>
          <tbody>
            {items.map((item, i) =>
              item.locked ? (
                <tr key={item.key}>
                  <td className="mono">{item.container_name}</td>
                  <td className="mono">{item.container_number || "—"}</td>
                  <td className="mono">{skuCodes.find((s) => s.id === item.sku_code_id)?.code || "—"}</td>
                  <td className="mono">{versionsFor(item.sku_code_id).find((v) => v.id === item.sku_version_id)?.version || "—"}</td>
                  <td>{Number(item.po_quantity).toLocaleString()}</td>
                  <td>{item.unit}</td>
                  <td><span className="badge approved">Inwarded</span></td>
                </tr>
              ) : (
                <tr key={item.key}>
                  <td><input type="text" value={item.container_name} onChange={(e) => update(i, { container_name: e.target.value.toUpperCase() })} placeholder="HA1" /></td>
                  <td><input type="text" value={item.container_number} onChange={(e) => update(i, { container_number: e.target.value.toUpperCase() })} placeholder="Optional" /></td>
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
      <button className="btn btn-secondary" onClick={() => onChange([...items, blankEntry()])} style={{ marginTop: 10 }}>+ Add Container</button>
    </div>
  );
}
