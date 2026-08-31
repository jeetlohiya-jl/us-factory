"use client";
import { useState } from "react";
import type { Pallet } from "@/lib/types";
import CameraQrScanner from "./CameraQrScanner";

/**
 * RM/FG Storage's "New Storage Record" panel — the exact two-step scan
 * workflow from the prototype (panel-storage / panel-fgstorage): scan
 * pallet -> auto-resolve SKU/etc. -> scan location -> review summary ->
 * confirm. Nothing is written to the database until Confirm; both scans
 * are re-validated server-side at confirm time (see storage_service.py).
 *
 * Two input methods feed each step, both landing in the same resolve call
 * so the backend only ever trusts the resolved DB record, never the raw
 * scanned text as fact by itself:
 *   1. The text field: a handheld barcode/QR scanner gun (keyboard-
 *      emulating "HID" hardware) types into it and submits on Enter, or an
 *      operator types/pastes the code by hand and presses Enter.
 *   2. The "📷 Scan" button opens CameraQrScanner, which decodes a QR code
 *      from the device camera (jsQR) and feeds the exact same payload into
 *      the exact same resolve function -- there is no separate manual
 *      "Scan" button, since Enter on the text field already submits.
 * This one shared panel is used by both RM Storage and FG Storage, so both
 * input methods are available on both automatically.
 */
export default function StorageScanPanel({
  title, hintSub, onScanPallet, onScanLocation, onConfirm, onClose,
}: {
  title: string;
  hintSub: string;
  onScanPallet: (payload: string) => Promise<Pallet>;
  onScanLocation: (payload: string) => Promise<{ id: string; display_id: string; zone: string }>;
  onConfirm: (palletPayload: string, locationPayload: string) => Promise<void>;
  onClose: () => void;
}) {
  const [palletInput, setPalletInput] = useState("");
  const [locationInput, setLocationInput] = useState("");
  const [pallet, setPallet] = useState<Pallet | null>(null);
  const [location, setLocation] = useState<{ id: string; display_id: string; zone: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Which step (if any) currently has its camera scanner open. Camera
  // scanning is a third input method alongside the HID-scanner-gun /
  // manual text field above -- it just fills the same input and drives
  // the exact same resolve call, so it's covered by RM and FG Storage
  // alike since both render this one shared panel.
  const [cameraStep, setCameraStep] = useState<"pallet" | "location" | null>(null);

  async function handleScanPallet(payload?: string) {
    const raw = (payload ?? palletInput).trim();
    if (!raw) return;
    setBusy(true);
    setError(null);
    try {
      const p = await onScanPallet(raw);
      setPallet(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resolve that pallet QR.");
    } finally {
      setBusy(false);
    }
  }

  async function handleScanLocation(payload?: string) {
    const raw = (payload ?? locationInput).trim();
    if (!raw) return;
    setBusy(true);
    setError(null);
    try {
      const loc = await onScanLocation(raw);
      setLocation(loc);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resolve that location QR.");
    } finally {
      setBusy(false);
    }
  }

  function handleCameraDetected(step: "pallet" | "location", text: string) {
    setCameraStep(null);
    if (step === "pallet") {
      setPalletInput(text);
      handleScanPallet(text);
    } else {
      setLocationInput(text);
      handleScanLocation(text);
    }
  }

  async function handleConfirm() {
    if (!pallet || !location) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(palletInput.trim(), locationInput.trim());
      setConfirmed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to confirm storage.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>{title}</h2><div className="sub">{hintSub}</div></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {confirmed ? (
            <div className="hint-text" style={{ fontWeight: 700, color: "var(--green-deep)" }}>
              ✓ Storage confirmed for {pallet?.display_id} at {location?.display_id}.
            </div>
          ) : (
            <>
              {error && <div className="hint-text" style={{ color: "var(--red)", fontWeight: 700, marginBottom: 10 }}>{error}</div>}

              <div className="scan-grid" style={{ gridTemplateColumns: "1fr" }}>
                <div className={`scan-card ${pallet ? "done" : ""}`}>
                  <div className="scan-icon">📦</div>
                  <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Step 1 — Scan Pallet QR</div>
                  {!pallet ? (
                    cameraStep === "pallet" ? (
                      <CameraQrScanner
                        onDetected={(text) => handleCameraDetected("pallet", text)}
                        onCancel={() => setCameraStep(null)}
                      />
                    ) : (
                      <>
                        <div className="scan-input-row">
                          <input
                            type="text" placeholder="Scan or enter pallet QR / ID" autoFocus
                            value={palletInput} onChange={(e) => setPalletInput(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleScanPallet()}
                          />
                        </div>
                        <button type="button" className="btn btn-secondary btn-camera-scan" onClick={() => setCameraStep("pallet")}>
                          📷 Scan
                        </button>
                      </>
                    )
                  ) : (
                    <div className="scan-result">✓ {pallet.display_id} ({pallet.sku_code})</div>
                  )}
                </div>

                {pallet && (
                  <div className={`scan-card ${location ? "done" : ""}`}>
                    <div className="scan-icon">📍</div>
                    <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Step 2 — Scan Location QR</div>
                    {!location ? (
                      cameraStep === "location" ? (
                        <CameraQrScanner
                          onDetected={(text) => handleCameraDetected("location", text)}
                          onCancel={() => setCameraStep(null)}
                        />
                      ) : (
                        <>
                          <div className="scan-input-row">
                            <input
                              type="text" placeholder="Scan or enter location QR / ID" autoFocus
                              value={locationInput} onChange={(e) => setLocationInput(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && handleScanLocation()}
                            />
                          </div>
                          <button type="button" className="btn btn-secondary btn-camera-scan" onClick={() => setCameraStep("location")}>
                            📷 Scan
                          </button>
                        </>
                      )
                    ) : (
                      <div className="scan-result">✓ {pallet.display_id} ({pallet.sku_code}) → {location.display_id}</div>
                    )}
                  </div>
                )}
              </div>

              {pallet && location && (
                <div id="storage-summary-card">
                  <div className="section-label">Confirm Storage Record</div>
                  <table className="summary-table">
                    <tbody>
                      <tr><td>Pallet Number</td><td>{pallet.display_id}</td></tr>
                      <tr><td>Shipment Number</td><td>{pallet.shipment_number || "—"}</td></tr>
                      <tr><td>SKU Name</td><td>{pallet.sku_code}</td></tr>
                      <tr><td>SKU Version</td><td>{pallet.sku_version}</td></tr>
                      <tr><td>Location</td><td>{location.display_id}</td></tr>
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>{confirmed ? "Done" : "Cancel"}</button>
          <div className="sp-foot-right">
            {!confirmed && (
              <button className="btn btn-primary" disabled={busy || !pallet || !location} onClick={handleConfirm}>Confirm Storage</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
