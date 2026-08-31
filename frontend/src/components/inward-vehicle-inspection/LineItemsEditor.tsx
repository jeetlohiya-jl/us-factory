"use client";
import type { SkuCode } from "@/lib/types";

export interface EditableLineItem {
  sku_code_id: string;
  sku_version_id: string;
  quantity: string;
}

export default function LineItemsEditor({
  items, skuCodes, disabled, onChange,
}: {
  items: EditableLineItem[];
  skuCodes: SkuCode[];
  disabled?: boolean;
  onChange: (items: EditableLineItem[]) => void;
}) {
  function versionsFor(skuCodeId: string) {
    return skuCodes.find((s) => s.id === skuCodeId)?.versions || [];
  }

  function update(idx: number, patch: Partial<EditableLineItem>) {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    if (patch.sku_code_id !== undefined) {
      const versions = versionsFor(patch.sku_code_id);
      next[idx].sku_version_id = versions[0]?.id || "";
    }
    onChange(next);
  }

  function addRow() {
    onChange([...items, { sku_code_id: "", sku_version_id: "", quantity: "" }]);
  }

  function removeRow(idx: number) {
    const next = items.filter((_, i) => i !== idx);
    onChange(next.length ? next : [{ sku_code_id: "", sku_version_id: "", quantity: "" }]);
  }

  return (
    <div>
      <table className="qc-obs-table">
        <thead>
          <tr><th>SKU Name</th><th>SKU Version</th><th>Quantity</th><th /></tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td>
                <select disabled={disabled} value={item.sku_code_id} onChange={(e) => update(i, { sku_code_id: e.target.value })}>
                  <option value="">Select</option>
                  {skuCodes.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                </select>
              </td>
              <td>
                <select disabled={disabled} value={item.sku_version_id} onChange={(e) => update(i, { sku_version_id: e.target.value })}>
                  <option value="">Select</option>
                  {versionsFor(item.sku_code_id).map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
                </select>
              </td>
              <td>
                <input
                  type="number"
                  disabled={disabled}
                  value={item.quantity}
                  onChange={(e) => update(i, { quantity: e.target.value })}
                />
              </td>
              <td>{!disabled && <a className="btn-tertiary" onClick={() => removeRow(i)}>Remove</a>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!disabled && (
        <button className="btn btn-secondary" onClick={addRow} style={{ marginTop: 10 }}>+ Add More Entry</button>
      )}
    </div>
  );
}
