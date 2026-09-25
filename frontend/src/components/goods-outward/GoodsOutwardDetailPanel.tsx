"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { GoodsOutwardDetail } from "@/lib/types";
import CameraQrScanner from "@/components/storage/CameraQrScanner";
import { T } from "@/lib/terms";

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "complete" ? "approved" : status === "partial" ? "partial" : "pending";
  const label = status === "complete" ? "Complete" : status === "partial" ? "Partial" : "Pending";
  return <span className={`badge ${cls}`}>{label}</span>;
}

/**
 * Factory OS Module 6 -- Goods Outward detail view: Shipment Details + Line
 * Items (Customer Shipment, unchanged, read-only -- create-once, no edit)
 * PLUS the picking process that previously lived on its own Shipment
 * Picking page, embedded here as one combined scan box instead of a
 * separate page per line item.
 *
 * A single scan box (not one per SKU/Version) is used: on each scan, a
 * read-only Supabase lookup (api.previewScannedFgPallet) identifies which
 * FG pallet was scanned, and this component matches it, client-side, to
 * the one line item whose sku_code_id/sku_version_id it shares AND that
 * still has remaining quantity -- then calls the exact same api.pickPallet
 * route the old Shipment Picking page used, scoped to THAT line item's own
 * picking_request_id. The client-side match only decides *which* request to
 * call; api.pickPallet's own server-side transaction
 * (shipment_picking_service.pick_pallet_for_request) is what actually
 * re-validates lifecycle/SKU-version/duplicate/quantity and is the only
 * real source of truth -- this component never assumes success before that
 * call returns.
 */
export default function GoodsOutwardDetailPanel({
  detail, canPick, canEdit, onClose, onChanged, onEdit,
}: {
  detail: GoodsOutwardDetail;
  canPick: boolean;
  canEdit?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onEdit?: () => void;
}) {
  const [record, setRecord] = useState(detail);
  const [scanInput, setScanInput] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allComplete = record.status === "complete";

  async function refresh() {
    const rec = await api.getGoodsOutward(record.id);
    setRecord(rec);
  }

  async function handleScan(payload?: string) {
    const raw = (payload ?? scanInput).trim();
    if (!raw || busy) return;
    setBusy(true);
    setError(null);
    try {
      const pallet = await api.previewScannedFgPallet(raw);
      if (!pallet) {
        setError("No FG pallet found for that scan.");
        return;
      }
      const target = record.line_items.find(
        (li) =>
          li.picking_request_id &&
          li.status !== "complete" &&
          li.sku_code_id === pallet.sku_code_id &&
          li.sku_version_id === pallet.sku_version_id
      );
      if (!target || !target.picking_request_id) {
        setError(
          `Pallet ${pallet.display_id} (${pallet.sku_code || "—"} / ${pallet.sku_version || "—"}) doesn't match any remaining line item on this shipment.`
        );
        return;
      }
      await api.pickPallet(target.picking_request_id, raw);
      setScanInput("");
      await refresh();
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

  async function handleRemove(lineItemId: string, pickId: string) {
    const li = record.line_items.find((l) => l.id === lineItemId);
    if (!li?.picking_request_id) return;
    setBusy(true);
    setError(null);
    try {
      await api.removePick(li.picking_request_id, pickId);
      await refresh();
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
            <h2>Goods Outward</h2>
            <div className="sub mono">{record.shipment_number}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>Shipment Details</h3>
            <div className="detail-grid">
              <Kv label={T.shipmentNumber} value={<span className="mono">{record.shipment_number}</span>} />
              <Kv label="Customer / Recipient" value={record.customer} />
              <Kv label="Date" value={new Date(record.created_at).toLocaleDateString()} />
              <Kv label="Status" value={<StatusBadge status={record.status} />} />
            </div>
          </div>

          <div className="detail-card">
            <h3>Line Items — Required / Picked / Remaining</h3>
            <table className="qc-obs-table">
              <thead>
                <tr>
                  <th>{T.sku}</th><th style={{ width: 90 }}>Required</th>
                  <th style={{ width: 80 }}>Picked</th><th style={{ width: 90 }}>Remaining</th>
                  <th>Pcs</th><th>Trays/Sleeve</th><th style={{ width: 100 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {record.line_items.map((li) => (
                  <tr key={li.id}>
                    <td className="mono">{li.sku_code || "—"}</td>
                    <td>{li.pallets_required}</td>
                    <td>{li.picks.length}</td>
                    <td>{Math.max(li.pallets_required - li.picks.length, 0)}</td>
                    <td>{li.pcs ?? "—"}</td>
                    <td>{li.pcs_per_sleeve || "—"}</td>
                    <td><StatusBadge status={li.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canPick && !allComplete && (
            <div className="detail-card">
              <h3>Pick FG Pallets</h3>
              <div className="hint-text" style={{ marginBottom: 10 }}>
                Scan any FG pallet QR for this shipment — it will automatically be matched to the correct SKU/Version line item above. Over-picking and duplicate picks are blocked.
              </div>
              {error && <div className="hint-text" style={{ display: "block", color: "var(--red)", fontWeight: 700, marginBottom: 10 }}>{error}</div>}
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
            </div>
          )}

          <div className="detail-card">
            <h3>Picked FG Pallets</h3>
            {record.line_items.every((li) => li.picks.length === 0) ? (
              <div className="hint-text">No pallets picked yet for this shipment.</div>
            ) : (
              <table className="qc-obs-table">
                <thead><tr><th>Pallet QR</th><th>{T.sku}</th><th>Batch Code</th><th>Picked At</th><th /></tr></thead>
                <tbody>
                  {record.line_items.flatMap((li) =>
                    li.picks.map((p) => (
                      <tr key={p.id}>
                        <td className="mono">{p.pallet_display_id || "—"}</td>
                        <td className="mono">{li.sku_code || "—"}</td>
                        <td className="mono">{p.batch_code || "—"}</td>
                        <td>{new Date(p.picked_at).toLocaleString()}</td>
                        <td>
                          {canPick && li.status !== "complete" && (
                            <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => handleRemove(li.id, p.id)}>Remove</a>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          {canEdit && onEdit && (
            <div className="sp-foot-right">
              <button className="btn btn-primary" onClick={onEdit}>Edit</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
