"use client";
import type { SkuCode } from "@/lib/types";
import type { CustomerShipmentLineItemDraft } from "@/lib/types";

/**
 * Customer Shipment's own line-items editor -- deliberately NOT a reuse of
 * inward-vehicle-inspection/LineItemsEditor.tsx, because Customer Shipment
 * needs two behaviors that component doesn't have and IVI doesn't need:
 *   1. Removing the final row must leave the panel at true zero (IVI's
 *      removeRow always re-seeds one blank row) -- spec point 12.
 *   2. The quantity column is explicitly labeled "No. of Pallets", never
 *      "Qty Required" (spec point 11) and the add-button copy is the
 *      prototype's own "+ Add Line Item" (not IVI's "+ Add More Entry").
 * Forking a small component here avoids changing IVI's already-shipped
 * behavior for an unrelated module.
 */
export default function CsLineItemsEditor({
  items, skuCodes, onChange,
}: {
  items: CustomerShipmentLineItemDraft[];
  skuCodes: SkuCode[];
  onChange: (items: CustomerShipmentLineItemDraft[]) => void;
}) {
  function versionsFor(skuCodeId: string | null) {
    if (!skuCodeId) return [];
    return skuCodes.find((s) => s.id === skuCodeId)?.versions.filter((v) => v.is_active) || [];
  }

  function update(idx: number, patch: Partial<CustomerShipmentLineItemDraft>) {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    if (patch.sku_code_id !== undefined) {
      const versions = versionsFor(patch.sku_code_id);
      next[idx].sku_version_id = versions[0]?.id || null;
    }
    onChange(next);
  }

  function addRow() {
    onChange([...items, { key: `li-${Date.now()}-${Math.random().toString(36).slice(2)}`, sku_code_id: null, sku_version_id: null, pallets_required: "" }]);
  }

  function removeRow(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  if (items.length === 0) {
    return (
      <div>
        <div className="hint-text">No line items added yet.</div>
        <button className="btn btn-secondary" onClick={addRow} style={{ marginTop: 10 }}>+ Add Line Item</button>
      </div>
    );
  }

  return (
    <div>
      <table className="qc-obs-table">
        <thead>
          <tr><th>SKU Code</th><th>SKU Version</th><th>No. of Pallets</th><th /></tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={item.key}>
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
              <td>
                <input
                  type="number"
                  min={1}
                  value={item.pallets_required}
                  onChange={(e) => update(i, { pallets_required: e.target.value })}
                />
              </td>
              <td><a className="btn-tertiary" onClick={() => removeRow(i)}>Remove</a></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-secondary" onClick={addRow} style={{ marginTop: 10 }}>+ Add Line Item</button>
    </div>
  );
}
