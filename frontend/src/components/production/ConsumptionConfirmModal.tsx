"use client";
import { useState } from "react";
import type { ProductionDetail, QuantityUnit } from "@/lib/types";
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
 * 2026-09-24 -- clicking "No" here now asks for the actual Quantity
 * Consumed (mirrors Wizard.tsx's awaitingQuantity/draftQuantity pattern),
 * instead of silently flipping the flag with no quantity captured: nothing
 * is sent to the server until a valid quantity is entered and confirmed.
 * "Yes" still just flips the flag (the pallet's already-recorded quantity
 * stands). Only rows the operator actually changes here call the
 * (now-unlocked) update_pallet_consumption endpoint -- see
 * api.setMaterialConsumptionPalletFullyConsumed /
 * api.setMaterialConsumptionPalletQuantity and the backend's
 * lifecycle-reversal logic. Declining/closing this modal cancels the whole
 * Production save -- nothing is written, not even a changed toggle, until
 * "Confirm & Save".
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
  // Quantity Consumed, captured only for rows switched to "No" here.
  const [awaitingQuantity, setAwaitingQuantity] = useState<Set<string>>(new Set());
  const [draftQuantity, setDraftQuantity] = useState<Record<string, string>>({});
  const [draftUnit, setDraftUnit] = useState<Record<string, QuantityUnit>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function clickNo(rowId: string) {
    setValues((v) => ({ ...v, [rowId]: false }));
    setAwaitingQuantity((prev) => new Set(prev).add(rowId));
  }
  function clickYes(rowId: string) {
    setValues((v) => ({ ...v, [rowId]: true }));
    setAwaitingQuantity((prev) => { const next = new Set(prev); next.delete(rowId); return next; });
  }

  async function handleConfirm() {
    // Any "No" row still waiting on a real quantity can't be confirmed yet.
    const missingQuantity = rows.some(
      (r) => awaitingQuantity.has(r.id) && (!(draftQuantity[r.id] ?? "").trim() || Number(draftQuantity[r.id]) <= 0)
    );
    if (missingQuantity) {
      setError("Enter the quantity consumed for every pallet marked \"No\" before confirming.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const changed = rows.filter((r) => values[r.id] !== r.fully_consumed);
      for (const r of changed) {
        if (values[r.id]) {
          await api.setMaterialConsumptionPalletFullyConsumed(r.material_consumption_id, r.id, true);
        } else {
          const quantity = (draftQuantity[r.id] ?? "").trim() || String(r.quantity);
          const unit = draftUnit[r.id] ?? r.unit;
          await api.setMaterialConsumptionPalletQuantity(r.material_consumption_id, r.id, quantity, { unit, fullyConsumed: false });
        }
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
        <h3 style={{ marginTop: 0 }}>Confirm Raw Material Consumption</h3>
        <div className="hint-text" style={{ marginBottom: 14 }}>
          Before saving this Production Run, confirm whether each raw material pallet picked for it was fully
          consumed. Anything left "No" stays available to rescan into a later Raw Material Consumption record.
        </div>
        {rows.length === 0 ? (
          <div className="hint-text">No Raw Material Consumption pallets linked to this run.</div>
        ) : (
          <table className="qc-obs-table" style={{ marginBottom: 14 }}>
            <thead><tr><th>Pallet</th><th>Machine</th><th>SKU</th><th style={{ width: 120 }}>Fully Consumed</th><th style={{ width: 140 }}>Quantity Consumed</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const showQuantityAsk = awaitingQuantity.has(r.id) || !values[r.id];
                return (
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
                          onClick={() => clickYes(r.id)}
                        >Yes</button>
                        <button
                          type="button"
                          className={`btn ${!values[r.id] ? "btn-primary" : "btn-secondary"}`}
                          style={{ padding: "3px 10px", fontSize: 12.5 }}
                          disabled={saving}
                          onClick={() => clickNo(r.id)}
                        >No</button>
                      </div>
                    </td>
                    <td>
                      {showQuantityAsk ? (
                        <div style={{ display: "flex", gap: 4 }}>
                          <input
                            type="number" step="0.01" min="0" placeholder="Quantity consumed" autoFocus={awaitingQuantity.has(r.id)}
                            style={{ width: 80 }}
                            disabled={saving}
                            value={draftQuantity[r.id] ?? String(r.quantity)}
                            onChange={(e) => setDraftQuantity((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          />
                          <select
                            style={{ width: 70 }}
                            disabled={saving}
                            value={draftUnit[r.id] ?? r.unit}
                            onChange={(e) => setDraftUnit((prev) => ({ ...prev, [r.id]: e.target.value as QuantityUnit }))}
                          >
                            <option value="Pallets">Pallets</option>
                            <option value="Kgs">Kgs</option>
                            <option value="Units">Units</option>
                            <option value="Bags">Bags</option>
                          </select>
                        </div>
                      ) : (
                        <span className="hint-text">{r.quantity} {r.unit}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
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
