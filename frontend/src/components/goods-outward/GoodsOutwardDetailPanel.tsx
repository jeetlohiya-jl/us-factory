"use client";
import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { GoodsOutwardDetail, GoodsOutwardScannedPallet, OviDetail } from "@/lib/types";
import CameraQrScanner from "@/components/storage/CameraQrScanner";
import PackingListPanel from "@/components/goods-outward/PackingListPanel";
import OviPanel from "@/components/outward-vehicle-inspection/OviPanel";
import { T } from "@/lib/terms";

// Exactly the OVI list page's own canView(): Pending/Draft opens editable
// (there's nothing finished yet to just review), Hold/Approved opens
// read-only (Hold is resolved via HoldReleaseSection inside that view, not
// by re-editing the checklist). Kept as one function so the auto-open-
// after-picking path and the manual button below never disagree.
function oviModeFor(status: string): "view" | "edit" {
  return status === "hold" || status === "approved" ? "view" : "edit";
}

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
 *
 * 2026-09-28 -- per explicit feedback, a scan no longer picks the pallet
 * immediately: it only resolves and previews it (same read-only lookup as
 * before), then this component shows a "Confirm Pallet Pick" card -- same
 * shape as RM/FG Storage's own scan-then-preview-then-confirm pattern in
 * StorageScanPanel.tsx -- and the actual api.pickPallet call only happens
 * once the operator clicks OK. The scan input is hidden while a pick is
 * pending, so a big multi-pallet pick (e.g. 40 pallets) is still one scan
 * -> one confirm -> next scan cycle, never several unconfirmed scans
 * racing each other. This only changes when THIS component records a pick;
 * the existing "auto-open Outward Vehicle Inspection the moment the whole
 * shipment reaches Complete" behavior (see refresh() below) is unchanged --
 * it already waited for the last pallet, never fired mid-pick.
 */
export default function GoodsOutwardDetailPanel({
  detail, canPick, canEdit, canFillOvi, onClose, onChanged, onEdit,
}: {
  detail: GoodsOutwardDetail;
  canPick: boolean;
  canEdit?: boolean;
  // me.permissions.outward_vehicle_inspection (remapped to Factory's own
  // Goods Outward permission by lib/currentProduct.ts) -- gates OviPanel's
  // own can_fill_section-driven read-only logic, same as canPick/canEdit above.
  canFillOvi: boolean;
  onClose: () => void;
  onChanged: () => void;
  onEdit?: () => void;
}) {
  const [record, setRecord] = useState(detail);
  const [scanInput, setScanInput] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [packingListOpen, setPackingListOpen] = useState(false);
  // A scan that resolved to a real, matching FG pallet but hasn't been
  // confirmed yet -- nothing is picked (no api.pickPallet call) until the
  // operator clicks OK on the confirm card below. rawScan is kept alongside
  // the previewed pallet because api.pickPallet re-validates against the
  // original scanned payload server-side, not the preview response.
  const [pendingPick, setPendingPick] = useState<{
    pallet: GoodsOutwardScannedPallet; lineItemId: string; pickingRequestId: string; rawScan: string;
  } | null>(null);
  // The Outward Vehicle Inspection record is auto-created (always exists)
  // for this shipment -- record.outward_inspection already carries its
  // {id,status} from the same read that loaded this panel, so opening it
  // costs exactly one more call (api.getOvi, for the full record), never a
  // create. reusing OviPanel.tsx completely unmodified: this is Goods
  // Outward's entry point into that existing system, not a new one.
  const [oviRecord, setOviRecord] = useState<OviDetail | null>(null);
  const [oviError, setOviError] = useState<string | null>(null);
  // True only while the CURRENTLY open OviPanel is the one this component
  // auto-opened right after the last pallet was picked (never for a manual
  // reopen via the footer button, and never once it's been closed) -- the
  // one signal that decides whether finishing it should also auto-open the
  // Packing List next. See handleOviSaved below.
  const autoFlow = useRef(false);

  const allComplete = record.status === "complete";

  async function openOvi() {
    if (!record.outward_inspection) return;
    autoFlow.current = false;
    setOviError(null);
    try {
      setOviRecord(await api.getOvi(record.outward_inspection.id));
    } catch (e) {
      setOviError(e instanceof Error ? e.message : "Failed to load Outward Vehicle Inspection record");
    }
  }

  async function refresh() {
    const rec = await api.getGoodsOutward(record.id);
    const justCompleted = rec.status === "complete" && record.status !== "complete";
    setRecord(rec);
    // The one bit of automation the spec asked for: the moment the last
    // pallet is picked, go straight into the inspection instead of leaving
    // the user to find their own way to it.
    if (justCompleted && rec.outward_inspection) {
      try {
        setOviRecord(await api.getOvi(rec.outward_inspection.id));
        autoFlow.current = true;
      } catch { /* best-effort -- the manual button below still works */ }
    }
  }

  // Second half of the same automation, per explicit feedback: once the
  // auto-opened inspection is actually finished (Save, not Save Draft), go
  // straight into the Packing List next instead of leaving the user to find
  // the "Print Packing List" button themselves -- pick -> inspect -> pack,
  // no manual hunting between any of the three steps.
  function handleOviSaved(saveMode: "draft" | "final") {
    onChanged();
    refresh();
    if (autoFlow.current && saveMode === "final") setPackingListOpen(true);
    autoFlow.current = false;
  }

  async function handleScan(payload?: string) {
    const raw = (payload ?? scanInput).trim();
    if (!raw || busy || pendingPick) return;
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
          `Pallet ${pallet.display_id} (${pallet.sku_code || "—"}) doesn't match any remaining line item on this shipment.`
        );
        return;
      }
      // Preview only -- nothing is picked yet. The operator confirms this
      // exact pallet via the card below before api.pickPallet is called.
      setScanInput("");
      setPendingPick({ pallet, lineItemId: target.id, pickingRequestId: target.picking_request_id, rawScan: raw });
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

  async function confirmPendingPick() {
    if (!pendingPick) return;
    setBusy(true);
    setError(null);
    try {
      await api.pickPallet(pendingPick.pickingRequestId, pendingPick.rawScan);
      setPendingPick(null);
      await refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Could not resolve that pallet scan.");
    } finally {
      setBusy(false);
    }
  }

  function cancelPendingPick() {
    // Nothing was ever picked -- this just discards the preview so the
    // operator can scan again (the same pallet, or a different one).
    setPendingPick(null);
    setError(null);
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
          {oviError && <div className="error-banner">{oviError}</div>}
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
                  <th>Trays</th><th>Trays per Sleeve</th><th style={{ width: 100 }}>Status</th>
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
              {!pendingPick ? (
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
              ) : (
                // Same shape as RM/FG Storage's own "Confirm Storage Record"
                // scan-then-confirm card -- nothing is picked until OK.
                <div id="confirm-pallet-pick-card">
                  <div className="section-label">Confirm Pallet Pick</div>
                  <table className="summary-table" style={{ marginBottom: 10 }}>
                    <tbody>
                      <tr><td>{T.palletNumber}</td><td className="mono">{pendingPick.pallet.display_id}</td></tr>
                      <tr><td>{T.sku}</td><td className="mono">{pendingPick.pallet.sku_code || "—"}</td></tr>
                      <tr><td>Version</td><td className="mono">{pendingPick.pallet.sku_version || "—"}</td></tr>
                    </tbody>
                  </table>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="btn btn-ghost" disabled={busy} onClick={cancelPendingPick}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={confirmPendingPick}>
                      {busy ? "Confirming…" : "OK — Confirm Pick"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="detail-card">
            <h3>Picked FG Pallets</h3>
            {record.line_items.every((li) => li.picks.length === 0) ? (
              <div className="hint-text">No pallets picked yet for this shipment.</div>
            ) : (
              <table className="qc-obs-table">
                <thead><tr><th>Pallet QR</th><th>{T.sku}</th><th>Batch Code</th><th>Production Run</th><th>Picked At</th><th /></tr></thead>
                <tbody>
                  {record.line_items.flatMap((li) =>
                    li.picks.map((p) => (
                      <tr key={p.id}>
                        <td className="mono">{p.pallet_display_id || "—"}</td>
                        <td className="mono">{li.sku_code || "—"}</td>
                        <td className="mono">{p.batch_code || "—"}</td>
                        {/* Read straight off the scanned pallet's own
                            source_production_run_id -- no manual "which run
                            made this" picker needed anywhere in this flow. */}
                        <td className="mono">{p.production_run || "—"}</td>
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
          <div className="sp-foot-right">
            <button className="btn btn-secondary" onClick={() => setPackingListOpen(true)}>Print Packing List</button>
            {record.outward_inspection && (
              <button className="btn btn-secondary" onClick={openOvi}>
                {record.outward_inspection.status === "pending" ? "Outward Vehicle Inspection"
                  : record.outward_inspection.status === "draft" ? "Resume Vehicle Inspection"
                  : record.outward_inspection.status === "hold" ? "Vehicle Inspection · On Hold"
                  : "View Vehicle Inspection"}
              </button>
            )}
            {canEdit && onEdit && (
              <button className="btn btn-primary" onClick={onEdit}>Edit</button>
            )}
          </div>
        </div>
      </div>
      {packingListOpen && (
        <PackingListPanel
          shipmentId={record.id}
          shipmentNumber={record.shipment_number}
          onClose={() => setPackingListOpen(false)}
        />
      )}
      {oviRecord && (
        <OviPanel
          record={oviRecord}
          mode={oviModeFor(oviRecord.status)}
          canFill={canFillOvi}
          onClose={() => { autoFlow.current = false; setOviRecord(null); }}
          onSaved={handleOviSaved}
        />
      )}
    </>
  );
}
