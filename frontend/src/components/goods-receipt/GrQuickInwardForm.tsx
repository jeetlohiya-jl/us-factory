"use client";
import { useState } from "react";
import type { GoodsReceiptEntry, QuantityUnit } from "@/lib/types";
import { QUANTITY_UNITS } from "@/lib/types";
import GrCoaField from "./GrCoaField";
import { needsCoa } from "./GoodsReceiptDetailPanel";

export type QuickInwardSubmission =
  | { kind: "pallets"; pallets: number; qrQuantity: number }
  | { kind: "quantity"; receivedQuantity: number; unit: QuantityUnit; qrQuantity: number }
  // Falcon: quantity + unit only (no pallets; trays use another flow). No QR count and no
  // COA here -- QR codes come after QC approval, and the COA is uploaded in QC.
  | { kind: "us"; receivedQuantity: number; unit: QuantityUnit; pallets?: number };

/**
 * Inward for a container with NO real Container/Shipment Number (2026-09-30)
 * -- one of these "AUTO-####" rows never goes through Inward Vehicle
 * Inspection at all (see isAutoShipment in GoodsReceiptDetailPanel.tsx):
 * there's no checklist, no photos, no truck/container/seal fields, because
 * none of that describes a real physical delivery event the way a proper
 * container does. Instead it asks for exactly what's needed to inward it
 * and print its QR codes:
 *
 *   - Quantity (Pallets) -- ONLY for Soaker Pad (the one auto-shipment
 *     material that genuinely arrives on pallets); received_quantity is
 *     then the full PO quantity, same assumption the full wizard makes for
 *     every non-tray material. Everything else auto-shipment (Polybag,
 *     CFB, Glue, ...) isn't palletized, so instead it asks the actual
 *     Quantity Received plus its Unit (defaulting to the PO's own unit,
 *     but editable -- what's physically received can differ, e.g. by
 *     weight for glue).
 *   - How many QR codes to generate -- always asked, independent of the
 *     above: the real "boxes" configuration behind an auto-generated
 *     shipment number is unknown either way.
 *   - COA upload -- compulsory, only for Polybag/Soaker Pad/CFB (needsCoa).
 *
 * Deliberately has no Save Draft / resume: unlike the full wizard, this is
 * a single small step with no server-side draft record backing it, so
 * closing without Submit just discards whatever was typed -- reopening
 * "Inward" starts over, which is fine for a form this short.
 */
export default function GrQuickInwardForm({
  entry, poNumber, vendorName, canEdit, busy, error, onClose, onSubmit, usMode = false, inspection,
}: {
  entry: GoodsReceiptEntry;
  poNumber: string;
  vendorName: string;
  canEdit: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (submission: QuickInwardSubmission) => void;
  // Falcon inward for a non-tray material (see GoodsReceiptDetailPanel).
  usMode?: boolean;
  // US only: the optional Inward Vehicle Inspection. `label` is the button
  // text; `done` once one was completed for this entry.
  inspection?: { label: string; done: boolean; busy: boolean; onOpen: () => void };
}) {
  // Factory: only Soaker Pad is counted in pallets here. Falcon
  // (usMode): this form is never used for trays, and every non-tray material --
  // Soaker Pad included -- is received by Quantity Received + Unit alone.
  const usesPallets = !usMode && entry.category === "pad";
  const [pallets, setPallets] = useState("");
  const [receivedQuantity, setReceivedQuantity] = useState(usMode ? String(entry.po_quantity) : "");
  const [unit, setUnit] = useState<QuantityUnit>(entry.unit);
  const [qrQuantity, setQrQuantity] = useState("");
  const [coaFilename, setCoaFilename] = useState(entry.coa_filename);
  const [validationError, setValidationError] = useState<string | null>(null);

  const requiresCoa = needsCoa(entry);
  const isRemainingDelivery = entry.status === "inwarded";

  function validate(): string | null {
    if (usMode) {
      if (!(Number(receivedQuantity) > 0)) return "Quantity Received must be greater than 0.";
      if (usesPallets) {
        const p = Number(pallets);
        if (!(p >= 1) || !Number.isInteger(p)) return "Number of Pallets must be a whole number of at least 1.";
      }
      return null;
    }
    if (usesPallets) {
      const p = Number(pallets);
      if (!(p >= 1) || !Number.isInteger(p)) return "Quantity (Pallets) must be a whole number of at least 1.";
    } else {
      const q = Number(receivedQuantity);
      if (!(q > 0)) return "Quantity Received must be greater than 0.";
    }
    const q = Number(qrQuantity);
    if (!(q >= 1) || !Number.isInteger(q)) return "Number of QR codes to generate must be a whole number of at least 1.";
    if (requiresCoa && !coaFilename) return "Upload the COA before submitting.";
    return null;
  }

  function handleSubmit() {
    const invalid = validate();
    if (invalid) { setValidationError(invalid); return; }
    setValidationError(null);
    if (usMode) {
      onSubmit({ kind: "us", receivedQuantity: Number(receivedQuantity), unit, ...(usesPallets ? { pallets: Number(pallets) } : {}) });
      return;
    }
    onSubmit(
      usesPallets
        ? { kind: "pallets", pallets: Number(pallets), qrQuantity: Number(qrQuantity) }
        : { kind: "quantity", receivedQuantity: Number(receivedQuantity), unit, qrQuantity: Number(qrQuantity) }
    );
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>Inward</h2>
            <div className="sub">{poNumber} / {entry.shipment_number}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {(validationError || error) && <div className="error-banner">{validationError || error}</div>}
          <div className="detail-card" style={{ marginBottom: 18 }}>
            <h3>Goods Receipt Details</h3>
            <div className="detail-grid">
              <div>
                <div className="detail-kv-label">PO Number</div>
                <div className="detail-kv-value mono">{poNumber}</div>
              </div>
              <div>
                <div className="detail-kv-label">SKU</div>
                <div className="detail-kv-value">{entry.sku_code || "—"}</div>
              </div>
              <div>
                <div className="detail-kv-label">Vendor</div>
                <div className="detail-kv-value">{vendorName}</div>
              </div>
              <div>
                <div className="detail-kv-label">PO Quantity</div>
                <div className="detail-kv-value">{entry.po_quantity} {entry.unit}</div>
              </div>
            </div>
          </div>
          {usMode ? (
            <div className="detail-card" style={{ marginBottom: 18 }}>
              <h3>Inward Vehicle Inspection <span className="hint-text" style={{ margin: 0, fontWeight: 400 }}>(optional)</span></h3>
              <div className="hint-text" style={{ marginBottom: 10 }}>
                {inspection?.done
                  ? "Inspection completed and linked to this entry."
                  : "You can record the incoming vehicle and its inspection, or skip it and inward directly."}
              </div>
              {inspection && (
                <button className="btn btn-secondary" disabled={inspection.busy || !canEdit} onClick={inspection.onOpen}>
                  {inspection.busy ? "Opening…" : inspection.label}
                </button>
              )}
            </div>
          ) : (
            <div className="hint-text" style={{ marginBottom: 18 }}>
              No Container/Shipment Number was provided for this line, so Inward Vehicle Inspection doesn't apply here.
            </div>
          )}
          <div className="form-grid" style={{ marginBottom: 18 }}>
            {usMode ? (
              <>
                <div className="field">
                  <label>Quantity Received <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="number" min={0} step="any" disabled={!canEdit || busy} value={receivedQuantity} placeholder="e.g. 980"
                    onChange={(e) => setReceivedQuantity(e.target.value)} />
                </div>
                <div className="field">
                  <label>Unit <span style={{ color: "var(--red)" }}>*</span></label>
                  <select disabled={!canEdit || busy} value={unit} onChange={(e) => setUnit(e.target.value as QuantityUnit)}>
                    {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                {usesPallets && (
                  <div className="field">
                    <label>Number of Pallets <span style={{ color: "var(--red)" }}>*</span></label>
                    <input type="number" min={1} step={1} disabled={!canEdit || busy} value={pallets} placeholder="e.g. 5"
                      onChange={(e) => setPallets(e.target.value)} />
                  </div>
                )}
              </>
            ) : usesPallets ? (
              <div className="field">
                <label>Quantity (Pallets) <span style={{ color: "var(--red)" }}>*</span></label>
                <input type="number" min={1} step={1} disabled={!canEdit || busy} value={pallets} placeholder="e.g. 20"
                  onChange={(e) => setPallets(e.target.value)} />
              </div>
            ) : (
              <>
                <div className="field">
                  <label>Quantity Received <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="number" min={0} step="any" disabled={!canEdit || busy} value={receivedQuantity} placeholder="e.g. 980"
                    onChange={(e) => setReceivedQuantity(e.target.value)} />
                </div>
                <div className="field">
                  <label>Unit <span style={{ color: "var(--red)" }}>*</span></label>
                  <select disabled={!canEdit || busy} value={unit} onChange={(e) => setUnit(e.target.value as QuantityUnit)}>
                    {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </>
            )}
            {!usMode && (
              <div className="field">
                <label>How many QR codes to generate? <span style={{ color: "var(--red)" }}>*</span></label>
                <input type="number" min={1} step={1} disabled={!canEdit || busy} value={qrQuantity} placeholder="e.g. 20"
                  onChange={(e) => setQrQuantity(e.target.value)} />
                <div className="hint-text" style={{ margin: "4px 0 0" }}>The boxes configuration behind this line isn't known, so this is asked separately.</div>
              </div>
            )}
          </div>
          {usMode && (
            <div className="hint-text" style={{ marginBottom: 18 }}>
              After this, the entry appears in Inward QC as Pending. Upload the COA and approve it there, then generate the QR codes.
            </div>
          )}
          {requiresCoa && !usMode && (
            <GrCoaField
              entryId={entry.id}
              filename={coaFilename}
              disabled={!canEdit || busy}
              onChange={(next) => setCoaFilename(next.coa_filename)}
            />
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <div className="sp-foot-right">
            <button className="btn btn-primary" disabled={busy || !canEdit} onClick={handleSubmit}>
              {busy ? "Submitting…" : isRemainingDelivery ? "Inward Remaining" : "Inward"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
