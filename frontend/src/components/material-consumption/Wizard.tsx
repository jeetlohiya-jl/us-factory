"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { MaterialConsumptionDetail, Machine, Permissions, SecondaryMaterialCategory } from "@/lib/types";
import CameraQrScanner from "@/components/storage/CameraQrScanner";

const CATEGORY_LABELS: Record<string, string> = { tray: "Base Tray", fgtray: "FG Non-Padded Tray" };
const SECONDARY_LABELS: Record<SecondaryMaterialCategory, string> = { cfb: "CFB", pad: "Pads", glue: "Glue", polybag: "Polybags" };
const SECONDARY_CATEGORIES: SecondaryMaterialCategory[] = ["cfb", "pad", "glue", "polybag"];

/**
 * Start/End time is captured from THIS device's own clock at the moment the
 * worker presses the button -- never typed, never computed by the backend
 * server. This matters because the backend can run anywhere (a cloud
 * sandbox, a hosted server in a different timezone) while this workstation
 * is physically on the US factory floor, so the workstation's clock is the
 * only thing that's reliably in the factory's local time. Capturing it
 * client-side on click also means there's no network round-trip involved in
 * determining the time itself -- it's read synchronously, then just sent
 * along with the save request.
 */
function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatTime12h(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${mStr} ${ampm}`;
}

/**
 * A single scan input feeding one resolve call -- the same three input
 * methods as StorageScanPanel (HID-scanner-gun/manual text + Enter, or the
 * camera), just packaged as one reusable box instead of a fixed two-step
 * panel, since Material Consumption scans N pallets into one record rather
 * than a fixed pallet-then-location pair.
 */
function ScanBox({ placeholder, busy, onScan }: { placeholder: string; busy: boolean; onScan: (payload: string) => void }) {
  const [value, setValue] = useState("");
  const [showCamera, setShowCamera] = useState(false);

  function submit(payload?: string) {
    const raw = (payload ?? value).trim();
    if (!raw) return;
    onScan(raw);
    setValue("");
  }

  if (showCamera) {
    return (
      <CameraQrScanner
        onDetected={(text) => { setShowCamera(false); submit(text); }}
        onCancel={() => setShowCamera(false)}
      />
    );
  }

  return (
    <div className="scan-input-row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input
        type="text" placeholder={placeholder} autoFocus disabled={busy}
        value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <button type="button" className="btn btn-secondary btn-camera-scan" disabled={busy} onClick={() => setShowCamera(true)}>📷 Scan</button>
    </div>
  );
}

export default function MaterialConsumptionWizard({
  mcId, initialDetail, machines, shifts, permissions, onClose, onSaved,
}: {
  mcId: string;
  initialDetail: MaterialConsumptionDetail;
  machines: Machine[];
  shifts: string[];
  permissions: Permissions;
  onClose: (deleted: boolean) => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<MaterialConsumptionDetail>(initialDetail);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const isFinalized = detail.status === "saved";
  const canEdit = (permissions.can_create || permissions.can_edit) && !isFinalized;

  async function handlePrimaryScan(payload: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.scanMaterialConsumptionPallet(mcId, payload);
      setDetail(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not resolve that pallet QR.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSecondaryScan(category: SecondaryMaterialCategory, payload: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.scanMaterialConsumptionSecondary(mcId, payload, category);
      setDetail(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not resolve that pallet QR.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(rowId: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.removeMaterialConsumptionPallet(mcId, rowId);
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove pallet");
    } finally {
      setBusy(false);
    }
  }

  async function handleQuantityChange(rowId: string, value: string) {
    try {
      const updated = await api.setMaterialConsumptionPalletQuantity(mcId, rowId, value);
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update quantity");
    }
  }

  async function patchBasic(patch: Parameters<typeof api.updateMaterialConsumptionBasic>[1]) {
    setTouched(true);
    try {
      const updated = await api.updateMaterialConsumptionBasic(mcId, patch);
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  }

  async function handleSaveDraft() {
    setBusy(true);
    setError(null);
    try {
      await api.saveMaterialConsumptionDraft(mcId);
      onSaved();
      onClose(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save draft");
    } finally {
      setBusy(false);
    }
  }

  /** Step 2: press Start -- stamps this device's current time as start_time
   *  and (server-side) unlocks scanning. */
  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateMaterialConsumptionBasic(mcId, { start_time: nowHHMM() });
      setDetail(updated);
      setTouched(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  }

  /** Final step: press End Shift -- stamps this device's current time as
   *  end_time, then finalizes the record in one action. */
  async function handleEndShift() {
    setBusy(true);
    setError(null);
    try {
      await api.updateMaterialConsumptionBasic(mcId, { end_time: nowHHMM() });
      const updated = await api.finalizeMaterialConsumption(mcId);
      setDetail(updated);
      onSaved();
      onClose(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!touched && detail.pallets.length === 0 && detail.status === "draft") {
      try { await api.discardMaterialConsumptionIfBlank(mcId); } catch { /* best-effort */ }
    }
    onClose(false);
  }

  const primaryCount = detail.pallets.length;
  const hasStarted = !!detail.start_time;
  const canStart = canEdit && !hasStarted && !!detail.machine_id && !!detail.shift;
  const canEndShift = canEdit && hasStarted && primaryCount > 0 && !!detail.machine_id && !!detail.shift;

  return (
    <>
      <div className="panel-overlay open" onClick={handleCancel} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{detail.category ? `${CATEGORY_LABELS[detail.category] || detail.category} Material Consumption` : "New Material Consumption"}</h2>
            <div className="sub">
              {detail.consumption_date} · <span className={`badge ${detail.status === "saved" ? "approved" : "draft"}`}>{detail.status === "saved" ? "Saved" : "Draft"}</span>
              {detail.production_run_number && <> · Production Run {detail.production_run_number}</>}
            </div>
          </div>
          <button className="sp-close" onClick={handleCancel}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="section-label" style={{ marginTop: 0 }}>Step 1 · Machine &amp; Shift</div>
          <div className="form-grid" style={{ marginBottom: 18 }}>
            <div className="field">
              <label>Machine</label>
              <select disabled={!canEdit || hasStarted} value={detail.machine_id || ""} onChange={(e) => patchBasic({ machine_id: e.target.value })}>
                <option value="">Select</option>
                {machines.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Shift</label>
              <select disabled={!canEdit || hasStarted} value={detail.shift || ""} onChange={(e) => patchBasic({ shift: e.target.value })}>
                <option value="">Select</option>
                {shifts.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="section-label">Step 2 · Start</div>
          {hasStarted ? (
            <div className="time-captured" style={{ marginBottom: 24 }}>
              <span className="icon">🟢</span>
              <span>Started at {formatTime12h(detail.start_time)}</span>
            </div>
          ) : (
            <div style={{ marginBottom: 24 }}>
              <button
                type="button" className="btn btn-primary btn-xl" disabled={!canStart || busy} onClick={handleStart}
              >
                <span className="btn-xl-icon">▶</span> START
              </button>
              <div className="hint-text" style={{ marginTop: 8 }}>
                {detail.machine_id && detail.shift
                  ? "Press Start when you begin working. This also unlocks pallet scanning below."
                  : "Select Machine and Shift above first, then press Start."}
              </div>
            </div>
          )}

          {hasStarted && (
            <>
              <div className="section-label">Step 3 · Scan Pallet QR</div>
              <div className="hint-text" style={{ marginBottom: 10 }}>
                Scan every RM pallet physically picked for this production run. The first pallet sets the Category, SKU Name and SKU Version for this record — every additional pallet must match.
              </div>

              {detail.pallets.length > 0 && (
                <div className="detail-card" style={{ marginBottom: 14 }}>
                  <div className="detail-grid">
                    <div><div className="detail-kv-label">Category</div><div className="detail-kv-value">{CATEGORY_LABELS[detail.category || ""] || detail.category || "—"}</div></div>
                    <div><div className="detail-kv-label">SKU Name</div><div className="detail-kv-value">{detail.sku_code || "—"}</div></div>
                    <div><div className="detail-kv-label">SKU Version</div><div className="detail-kv-value">{detail.sku_version || "—"}</div></div>
                  </div>
                </div>
              )}

              {canEdit && (
                <div style={{ marginBottom: 14 }}>
                  <ScanBox placeholder="Scan or enter RM pallet QR / ID" busy={busy} onScan={handlePrimaryScan} />
                </div>
              )}

              <table className="qc-obs-table" style={{ marginBottom: 24 }}>
                <thead><tr><th>Pallet</th><th>SKU Name</th><th>SKU Version</th><th style={{ width: 90 }}>Quantity</th><th></th></tr></thead>
                <tbody>
                  {detail.pallets.length === 0 ? (
                    <tr><td colSpan={5} className="hint-text">No pallets scanned yet.</td></tr>
                  ) : (
                    detail.pallets.map((p) => (
                      <tr key={p.id}>
                        <td className="mono">{p.pallet_display_id}</td>
                        <td>{p.sku_code}</td>
                        <td>{p.sku_version}</td>
                        <td>{p.quantity}</td>
                        <td>{canEdit && <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => handleRemove(p.id)}>Remove</a>}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              <div className="section-label" style={{ fontSize: 15, marginBottom: 12 }}>Secondary Materials</div>
              {SECONDARY_CATEGORIES.map((cat) => {
                const rows = detail.secondary_materials[cat];
                return (
                  <div key={cat} style={{ marginBottom: 20 }}>
                    <div className="section-label">{SECONDARY_LABELS[cat]}</div>
                    {rows.length === 0 ? (
                      <div className="hint-text" style={{ marginBottom: 8 }}>No {SECONDARY_LABELS[cat]} consumption added yet.</div>
                    ) : (
                      <table className="qc-obs-table" style={{ marginBottom: 8 }}>
                        <thead><tr><th>Pallet</th><th>SKU</th><th style={{ width: 110 }}>Quantity</th><th></th></tr></thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id}>
                              <td className="mono">{r.pallet_display_id}</td>
                              <td>{r.sku_code}</td>
                              <td>
                                <input
                                  type="number" step="0.01" disabled={!canEdit} defaultValue={String(r.quantity)}
                                  onBlur={(e) => handleQuantityChange(r.id, e.target.value)}
                                />
                              </td>
                              <td>{canEdit && <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => handleRemove(r.id)}>Remove</a>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {canEdit && <ScanBox placeholder={`Scan or enter ${SECONDARY_LABELS[cat]} pallet QR / ID`} busy={busy} onScan={(p) => handleSecondaryScan(cat, p)} />}
                  </div>
                );
              })}

              <div className="section-label">Step 4 · Finish</div>
              {isFinalized ? (
                <div className="time-captured" style={{ marginBottom: 10 }}>
                  <span className="icon">🔵</span>
                  <span>Ended at {formatTime12h(detail.end_time)} · Saved</span>
                </div>
              ) : (
                <div style={{ marginBottom: 10 }}>
                  <button
                    type="button" className="btn btn-danger btn-xl" disabled={!canEndShift || busy} onClick={handleEndShift}
                  >
                    <span className="btn-xl-icon">⏹</span> END SHIFT &amp; SAVE
                  </button>
                  <div className="hint-text" style={{ marginTop: 8 }}>
                    {primaryCount > 0
                      ? "Press this only when you are completely done for this shift — it locks the record."
                      : "Scan at least one pallet above before ending the shift."}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
          <div className="sp-foot-right">
            {canEdit && <button className="btn btn-secondary" disabled={busy} onClick={handleSaveDraft}>Save Draft</button>}
          </div>
        </div>
      </div>
    </>
  );
}
