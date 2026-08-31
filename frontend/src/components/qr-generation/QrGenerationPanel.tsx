"use client";
import { useEffect, useState } from "react";
import type { QrGenerationDetail, Pallet } from "@/lib/types";
import { PALLET_STAGE_LABELS, PALLET_STAGE_BADGE_CLASS } from "@/lib/types";
import PalletTile from "./PalletTile";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * "New RM/FG QR Generation Record" side panel from the prototype
 * (panel-qr / panel-fgqr): source-locked fields, a hint line, and — once
 * generated — the pallet grid + Print button in place of Generate.
 * View mode (an already-generated batch opened later) shows the same
 * content plus each pallet's live lifecycle status, matching section E's
 * "Generated Pallets: every pallet ID, lifecycle status, storage status".
 *
 * Printing: a warehouse label printer prints a fixed sheet of 2x2 QR
 * labels, not "the whole page as shown on screen" — so the on-screen
 * pallet grid (with checkboxes to choose which pallets go to this print
 * run) is a separate DOM subtree from what actually prints. `.no-print`
 * hides all screen chrome under print media; `.print-only` — normally
 * hidden — becomes the only visible content, laid out as one 2x2 grid of
 * labels per physical sheet (`page-break-after` between sheets).
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const isGenerated = detail.status === "generated";

  useEffect(() => {
    setSelected(new Set(detail.pallets.map((p) => p.id)));
  }, [detail.pallets]);

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

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const selectedPallets: Pallet[] = detail.pallets.filter((p) => selected.has(p.id));
  const printSheets = chunk(selectedPallets, 4);

  return (
    <>
      <div className="panel-overlay open no-print" onClick={onClose} />
      <div className="side-panel open no-print">
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
              <div className="section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Generated Pallet QR Codes</span>
                <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--ink-50)" }}>
                  {selected.size} of {detail.pallets.length} selected for printing
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => setSelected(new Set(detail.pallets.map((p) => p.id)))}>Select all</a>
                <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => setSelected(new Set())}>Clear selection</a>
              </div>
              <div className="scan-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
                {detail.pallets.map((p) => (
                  <label key={p.id} style={{ position: "relative", cursor: "pointer", display: "block" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                      style={{ position: "absolute", top: 6, left: 6, width: 16, height: 16, zIndex: 1 }}
                    />
                    <div style={{ opacity: selected.has(p.id) ? 1 : 0.4 }}>
                      <PalletTile pallet={p} showStatus />
                    </div>
                  </label>
                ))}
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
              <button className="btn btn-secondary" disabled={selected.size === 0} onClick={() => window.print()}>
                Print {selected.size === detail.pallets.length ? "All" : `Selected (${selected.size})`} QR Codes
              </button>
            )}
            {!isGenerated && (
              <button className="btn btn-primary" disabled={busy || !canGenerate || detail.quantity <= 0} onClick={handleGenerate}>
                {busy ? "Generating…" : "Generate QR"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Print-only output: one 2x2 sheet of labels per physical page, built
          only from the pallets checked above. Invisible on screen. */}
      {isGenerated && (
        <div className="print-only">
          {printSheets.map((sheet, i) => (
            <div className="qr-print-page" key={i}>
              {sheet.map((p) => (
                <div className="qr-print-label" key={p.id}>
                  <PalletTile pallet={p} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
