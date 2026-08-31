"use client";
import { useState } from "react";
import type { QrGenerationDetail } from "@/lib/types";
import { PALLET_STAGE_LABELS, PALLET_STAGE_BADGE_CLASS } from "@/lib/types";
import PalletTile from "./PalletTile";

/**
 * "New RM/FG QR Generation Record" side panel from the prototype
 * (panel-qr / panel-fgqr): source-locked fields, a hint line, and — once
 * generated — the pallet grid + Print button in place of Generate.
 * View mode (an already-generated batch opened later) shows the same
 * content plus each pallet's live lifecycle status, matching section E's
 * "Generated Pallets: every pallet ID, lifecycle status, storage status".
 */
export default function QrGenerationPanel({
  title, detail, canGenerate, onGenerate, onClose,
}: {
  title: string;
  detail: QrGenerationDetail;
  canGenerate: boolean;
  onGenerate: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isGenerated = detail.status === "generated";

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      await onGenerate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate QR codes");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{title}</h2>
            <div className="sub">Batch {detail.batch_display_id} · <span className={`badge ${isGenerated ? "generated" : "pending"}`}>{detail.status}</span></div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          <div className="form-grid">
            <div className="field"><label>Shipment Number</label><div className="readonly-val mono">{detail.shipment_number || "—"}</div></div>
            <div className="field"><label>SKU Code</label><div className="readonly-val mono">{detail.sku_code_snapshot || "—"}</div></div>
            <div className="field"><label>SKU Version</label><div className="readonly-val mono">{detail.sku_version_snapshot || "—"}</div></div>
            <div className="field"><label>Quantity (Pallets)</label><div className="readonly-val mono">{detail.quantity}</div></div>
          </div>
          <div className="hint-text" style={{ marginBottom: 6 }}>
            {detail.source_locked
              ? `Auto-created from ${detail.source_inward_qc_id ? "Inward QC" : "Production Run"} ${detail.source_display_id || ""}. These fields are locked.`
              : ""}
          </div>
          {!isGenerated && (
            <div className="hint-text" style={{ marginBottom: 6 }}>
              {detail.quantity > 0 ? `This will generate ${detail.quantity} unique pallet QR code(s).` : "Enter a quantity greater than 0 before generating QR codes."}
            </div>
          )}

          {isGenerated && (
            <div className="qr-print-area" style={{ marginTop: 18 }}>
              <div className="section-label">Generated Pallet QR Codes</div>
              <div className="scan-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
                {detail.pallets.map((p) => <PalletTile key={p.id} pallet={p} showStatus />)}
              </div>
              <table className="qc-obs-table" style={{ marginTop: 18 }}>
                <thead><tr><th>Pallet ID</th><th>Lifecycle Status</th><th>Storage Location</th></tr></thead>
                <tbody>
                  {detail.pallets.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.display_id}</td>
                      <td><span className={`badge ${PALLET_STAGE_BADGE_CLASS[p.lifecycle_status]}`}>{PALLET_STAGE_LABELS[p.lifecycle_status]}</span></td>
                      <td className="mono">{p.location_display_id || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>{isGenerated ? "Close" : "Cancel"}</button>
          <div className="sp-foot-right">
            {isGenerated && (
              <button className="btn btn-secondary" onClick={() => window.print()}>Print QR Codes</button>
            )}
            {!isGenerated && (
              <button className="btn btn-primary" disabled={busy || !canGenerate || detail.quantity <= 0} onClick={handleGenerate}>
                {busy ? "Generating…" : "Generate QR"}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
