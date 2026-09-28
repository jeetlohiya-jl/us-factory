"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SkuCode, ProductionRun } from "@/lib/types";
import type { CustomerShipmentLineItemDraft } from "@/lib/types";
import { T } from "@/lib/terms";

const OTHERS = "__others__";

function num(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /\d+/.exec(v);
  return m ? Number(m[0]) : null;
}

/**
 * Customer Shipment's own line-items editor -- deliberately NOT a reuse of
 * inward-vehicle-inspection/LineItemsEditor.tsx, because Customer Shipment
 * needs two behaviors that component doesn't have and IVI doesn't need:
 *   1. Removing the final row must leave the panel at true zero (IVI's
 *      removeRow always re-seeds one blank row) -- spec point 12.
 *   2. The add-button copy is the prototype's own "+ Add Line Item" (not
 *      IVI's "+ Add More Entry"). The pallets-quantity column is labeled
 *      "Quantity" -- was "No. of Pallets" (spec point 11's original
 *      wording, never "Qty Required"), renamed for the same reason every
 *      other module's pallet count is now labeled "Quantity" (Inward QC,
 *      RM/FG QR Generation, RQC, Production, Sku master data), so the
 *      label is uniform across the app instead of drifting per module.
 * Forking a small component here avoids changing IVI's already-shipped
 * behavior for an unrelated module.
 *
 * 2026-09-28 -- Two follow-on changes, both per explicit feedback:
 *   1. SKU always shows only the tray SKUs directly (Goods Outward really
 *      only ever ships trays) -- everything else (film/pad/polybag/cfb/
 *      glue and the raw-material Inventory reference SKUs) collapses into
 *      one "Others" option, so the primary picker has 5 entries instead of
 *      the whole SKU Names list. Choosing "Others" reveals a second picker
 *      scoped to the rest.
 *   2. Trays (renamed from Pcs) can now be derived from the Production
 *      Run(s) that actually made the trays on this line -- pick one or
 *      more linked runs (scoped to this row's SKU) and Trays becomes SUM
 *      of their Total FG Pallets Generated x Trays per Sleeve, computed
 *      server-side (customer_shipment_service.compute_pcs_from_production_
 *      runs) and shown here as a live preview. No runs linked -> Trays
 *      stays the manual, hand-typed value it always was.
 * Switched from one wide table to one card per line item (same lesson as
 * the Packing List panel's own redesign) -- with the SKU split and the
 * Production Run picker added, a table row no longer fits this panel.
 */
export default function CsLineItemsEditor({
  items, skuCodes, onChange,
}: {
  items: CustomerShipmentLineItemDraft[];
  skuCodes: SkuCode[];
  onChange: (items: CustomerShipmentLineItemDraft[]) => void;
}) {
  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [othersMode, setOthersMode] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.listProductionRuns().then(setRuns).catch(() => setRuns([]));
  }, []);

  const trayOptions = skuCodes.filter((s) => s.category === "tray");
  const otherOptions = skuCodes.filter((s) => s.category !== "tray");

  function versionsFor(skuCodeId: string | null) {
    if (!skuCodeId) return [];
    return skuCodes.find((s) => s.id === skuCodeId)?.versions.filter((v) => v.is_active) || [];
  }

  function isOthers(item: CustomerShipmentLineItemDraft): boolean {
    const sku = skuCodes.find((s) => s.id === item.sku_code_id);
    if (sku) return sku.category !== "tray";
    return !!othersMode[item.key];
  }

  function runsFor(item: CustomerShipmentLineItemDraft): ProductionRun[] {
    const sku = skuCodes.find((s) => s.id === item.sku_code_id);
    if (!sku) return [];
    return runs.filter((r) => r.sku_code === sku.code);
  }

  function traysPreview(item: CustomerShipmentLineItemDraft): number | null {
    if (item.production_run_ids.length === 0) return null;
    const tps = num(item.pcs_per_sleeve);
    if (tps === null) return null;
    const total = runs
      .filter((r) => item.production_run_ids.includes(r.id))
      .reduce((sum, r) => sum + (r.total_fg_pallets || 0), 0);
    return total * tps;
  }

  function update(idx: number, patch: Partial<CustomerShipmentLineItemDraft>) {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    if (patch.sku_code_id !== undefined) {
      const versions = versionsFor(patch.sku_code_id);
      next[idx].sku_version_id = versions[0]?.id || null;
      // A different SKU invalidates any previously-linked runs (they were
      // scoped to the old SKU).
      next[idx].production_run_ids = [];
    }
    // Trays per Sleeve pre-fills from the selected SKU Version's own
    // Production Details (prod_pcs_per_sleeve -- the same "Trays/Sleeve"
    // reference data Production/Packing List already use) whenever the
    // operator hasn't already typed something else in for this line --
    // still editable here after, same pre-fill-not-override convention as
    // the Packing List panel.
    if (patch.sku_code_id !== undefined || patch.sku_version_id !== undefined) {
      const versionId = next[idx].sku_version_id;
      const versions = versionsFor(next[idx].sku_code_id);
      const version = versions.find((v) => v.id === versionId);
      if (version?.prod_pcs_per_sleeve && !next[idx].pcs_per_sleeve) {
        next[idx].pcs_per_sleeve = version.prod_pcs_per_sleeve;
      }
    }
    onChange(next);
  }

  function toggleRun(idx: number, runId: string) {
    const current = items[idx].production_run_ids;
    update(idx, {
      production_run_ids: current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId],
    });
  }

  function addRow() {
    onChange([...items, {
      key: `li-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sku_code_id: null, sku_version_id: null, pallets_required: "", pcs: "", pcs_per_sleeve: "",
      production_run_ids: [],
    }]);
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
      {items.map((item, i) => {
        const others = isOthers(item);
        const availableRuns = runsFor(item);
        const preview = traysPreview(item);
        return (
          <div className="detail-card" key={item.key} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Line Item {i + 1}</h3>
              <a className="btn-tertiary" onClick={() => removeRow(i)}>Remove</a>
            </div>
            <div className="form-grid">
              <div className="field">
                <label>{T.sku}</label>
                <select
                  value={others ? OTHERS : item.sku_code_id || ""}
                  onChange={(e) => {
                    if (e.target.value === OTHERS) {
                      setOthersMode((m) => ({ ...m, [item.key]: true }));
                      update(i, { sku_code_id: null });
                    } else {
                      setOthersMode((m) => ({ ...m, [item.key]: false }));
                      update(i, { sku_code_id: e.target.value || null });
                    }
                  }}
                >
                  <option value="">Select</option>
                  {trayOptions.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                  <option value={OTHERS}>Others…</option>
                </select>
              </div>
              {others && (
                <div className="field">
                  <label>Others</label>
                  <select value={item.sku_code_id || ""} onChange={(e) => update(i, { sku_code_id: e.target.value || null })}>
                    <option value="">Select</option>
                    {otherOptions.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label>{T.skuVersion}</label>
                <select value={item.sku_version_id || ""} onChange={(e) => update(i, { sku_version_id: e.target.value || null })}>
                  <option value="">Select</option>
                  {versionsFor(item.sku_code_id).map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Quantity</label>
                {/* Quantity is always counted in Pallets -- shown as a
                    fixed suffix inside the same input box rather than a
                    separate "Unit" column, since it's never anything else
                    here. */}
                <div className="input-with-suffix">
                  <input
                    type="number"
                    min={1}
                    value={item.pallets_required}
                    onChange={(e) => update(i, { pallets_required: e.target.value })}
                  />
                  <span className="suffix">Pallets</span>
                </div>
              </div>
              <div className="field">
                <label>Trays per Sleeve</label>
                <input
                  type="number"
                  min={0}
                  value={item.pcs_per_sleeve}
                  onChange={(e) => update(i, { pcs_per_sleeve: e.target.value })}
                />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>Linked Production Run(s)</label>
                <div className="hint-text" style={{ marginBottom: 6 }}>
                  {item.sku_code_id
                    ? availableRuns.length === 0
                      ? "No Production Runs found for this SKU yet -- Trays stays a manual entry below."
                      : "Pick the run(s) that made the trays on this shipment -- Trays is then derived from their Pallets Produced x Trays per Sleeve, instead of typed in."
                    : "Choose a SKU first."}
                </div>
                {availableRuns.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", maxHeight: 110, overflowY: "auto" }}>
                    {availableRuns.map((r) => (
                      <label key={r.id} style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 400 }}>
                        <input
                          type="checkbox"
                          checked={item.production_run_ids.includes(r.id)}
                          onChange={() => toggleRun(i, r.id)}
                        />
                        <span className="mono">{r.run_number}</span> ({r.total_fg_pallets} pallets)
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="field">
                <label>Trays</label>
                {item.production_run_ids.length > 0 ? (
                  <div className="readonly-val">{preview !== null ? preview.toLocaleString() : "— (fill in Trays per Sleeve)"}</div>
                ) : (
                  <input
                    type="number"
                    min={0}
                    value={item.pcs}
                    onChange={(e) => update(i, { pcs: e.target.value })}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}
      <button className="btn btn-secondary" onClick={addRow} style={{ marginTop: 6 }}>+ Add Line Item</button>
    </div>
  );
}
