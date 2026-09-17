"use client";
import { useState } from "react";
import type { ProductionDetail } from "@/lib/types";
import { api, ApiError } from "@/lib/api";

/**
 * Phase 5 -- the "unlock after save" confirmation: saving a Production
 * record is no longer treated as implicitly meaning the whole of the raw
 * material picked for it was consumed (explicit user direction: "if I save
 * a production record that does not mean the whole of raw material is
 * consumed -- so please dont auto end it unless the material consumed box
 * is checked/unchecked manually"). So immediately before the real
 * Production save, this modal lists every Material Consumption pallet
 * (primary + secondary, across every machine entry feeding this run --
 * already embedded on `record.machine_entries[i].pallets`, no extra fetch
 * needed) with the same Yes/No "Fully Consumed" control Material
 * Consumption's own Wizard uses, pre-filled with current values.
 *
 * Only rows the operator actually changes here call the (now-unlocked)
 * update_pallet_consumption endpoint -- see api.setMaterialConsumptionPalletFullyConsumed
 * and its backend counterpart's lifecycle-reversal logic. Declining/closing
 * this modal cancels the whole Production save -- nothing is written, not
 * even a changed toggle, until "Confirm & Save".
 */
export default function ConsumptionConfirmModal({
  record, onConfirm, onCancel,
}: {
  record: ProductionDetail;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const rows = record.machine_entries.flatMap((entry) =>
    entry.pallets.map((p) => ({ ...p, material_consumption_id: entry.material_consumption_id, machineLabel: entry.machine || "—" }))
  );
  const [values, setValues] = useState<Record<string, boolean>>(
    Object.fromEntries(rows.map((r) => [r.id, r.fully_consumed]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSaving(true);
    setError(null);
    try {
      const changed = rows.filter((r) => values[r.id] !== r.fully_consumed);
      for (const r of changed) {
        await api.setMaterialConsumptionPalletFullyConsumed(r.material_consumption_id, r.id, values[r.id]);
      }
      onConfirm();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to update consumption status");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div className="card" style={{ maxWidth: 640, width: "90%", maxHeight: "80vh", overflowY: "auto", padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>Confirm Material Consumption</h3>
        <div className="hint-text" style={{ marginBottom: 14 }}>
          Before saving this Production Run, confirm whether each raw material pallet picked for it was fully
          consumed. Anything left "No" stays available to rescan into a later Material Consumption record.
        </div>
        {rows.length === 0 ? (
          <div className="hint-text">No Material Consumption pallets linked to this run.</div>
        ) : (
          <table className="qc-obs-table" style={{ marginBottom: 14 }}>
            <thead><tr><th>Pallet</th><th>Machine</th><th>SKU</th><th style={{ width: 120 }}>Fully Consumed</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.pallet_display_id}</td>
                  <td>{r.machineLabel}</td>
                  <td>{r.sku_code || "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        type="button"
                        className={`btn ${values[r.id] ? "btn-primary" : "btn-secondary"}`}
                        style={{ padding: "3px 10px", fontSize: 12.5 }}
                        disabled={saving}
                        onClick={() => setValues((v) => ({ ...v, [r.id]: true }))}
                      >Yes</button>
                      <button
                        type="button"
                        className={`btn ${!values[r.id] ? "btn-primary" : "btn-secondary"}`}
                        style={{ padding: "3px 10px", fontSize: 12.5 }}
                        disabled={saving}
                        onClick={() => setValues((v) => ({ ...v, [r.id]: false }))}
                      >No</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && <div className="error-banner">{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button className="btn btn-ghost" disabled={saving} onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleConfirm}>
            {saving ? "Confirming…" : "Confirm & Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
