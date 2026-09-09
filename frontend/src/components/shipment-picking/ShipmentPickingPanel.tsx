"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ShipmentPickingDetail } from "@/lib/types";
import CameraQrScanner from "@/components/storage/CameraQrScanner";

/**
 * Single-scan pick panel -- reuses CameraQrScanner directly (the reusable
 * camera-scan primitive) rather than StorageScanPanel's two-step scan
 * flow, since picking a pallet here needs only ONE scan (the pallet
 * itself; the "location" side of the trade is simply "wherever it
 * currently sits in FG Storage", resolved server-side).
 *
 * Every scan is genuinely validated server-side (shipment_picking_service.
 * pick_pallet_for_request) -- explicit scan-driven selection only, matching
 * this app's existing "never FIFO, never auto-assignment" rule elsewhere.
 * Deliberately does NOT reproduce the prototype's own spScanForRequest(),
 * which silently auto-picks the first available pallet with no real scan.
 */
export default function ShipmentPickingPanel({
  request, onClose, onChanged,
}: {
  request: ShipmentPickingDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState(request);
  const [scanInput, setScanInput] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remaining = detail.pallets_required - detail.picks.length;
  const complete = detail.status === "complete";

  async function refreshDetail() {
    const rec = await api.getShipmentPicking(detail.id);
    setDetail(rec);
  }

  async function handleScan(payload?: string) {
    const raw = (payload ?? scanInput).trim();
    if (!raw || complete) return;
    setBusy(true);
    setError(null);
    try {
      await api.pickPallet(detail.id, raw);
      setScanInput("");
      await refreshDetail();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Could not resolve that pallet scan.");
    } finally {
      setBusy(false);
    }
  }

  function handleCameraDetected(text: string) {
    setCameraOpen(false);
    setScanInput(text);
    handleScan(text);
  }

  async function handleRemove(pickId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.removePick(detail.id, pickId);
      await refreshDetail();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove pick.");
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
            <h2>Shipment Picking</h2>
            <div className="sub">Auto-created from Customer Shipment {detail.shipment_number || ""}.</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <table className="summary-table" style={{ marginBottom: 16 }}>
            <tbody>
              <tr><td>Shipment Number</td><td className="mono">{detail.shipment_number || "—"}</td></tr>
              <tr><td>Customer</td><td>{detail.customer || "—"}</td></tr>
              <tr><td>SKU Code</td><td className="mono">{detail.sku_code || "—"}</td></tr>
              <tr><td>SKU Version</td><td>{detail.sku_version || "—"}</td></tr>
              <tr><td>Qty Required</td><td>{detail.pallets_required}</td></tr>
            </tbody>
          </table>

          <div className="hint-text" style={{ marginBottom: 14, fontWeight: 700, color: "var(--ink-70)" }}>
            {complete
              ? `Required quantity of ${detail.pallets_required} pallet(s) has been picked.`
              : `${remaining} more pallet(s) needed to complete this pick requirement.`}
          </div>

          {error && <div className="hint-text" style={{ display: "block", color: "var(--red)", fontWeight: 700, marginBottom: 10 }}>{error}</div>}

          {!complete && (
            <div className="scan-grid" style={{ gridTemplateColumns: "1fr" }}>
              <div className="scan-card">
                <div className="scan-icon">📦</div>
                <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Scan FG Pallet QR</div>
                {cameraOpen ? (
                  <CameraQrScanner onDetected={handleCameraDetected} onCancel={() => setCameraOpen(false)} />
                ) : (
                  <>
                    <div className="scan-input-row">
                      <input
                        type="text" placeholder="Scan or enter pallet QR / ID" autoFocus
                        value={scanInput} onChange={(e) => setScanInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleScan()}
                        disabled={busy}
                      />
                    </div>
                    <button type="button" className="btn btn-secondary btn-camera-scan" disabled={busy} onClick={() => setCameraOpen(true)}>
                      📷 Scan
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="section-label">Picked Pallets</div>
          {detail.picks.length === 0 ? (
            <div className="hint-text">No pallets picked yet for this requirement.</div>
          ) : (
            <table className="qc-obs-table">
              <thead><tr><th>Pallet Number</th><th>Picked At</th><th /></tr></thead>
              <tbody>
                {detail.picks.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.pallet_display_id || "—"}</td>
                    <td>{new Date(p.picked_at).toLocaleString()}</td>
                    <td>{!complete && <a className="btn-tertiary" onClick={() => handleRemove(p.id)}>Remove</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}
