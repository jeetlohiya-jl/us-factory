"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { MaterialConsumptionDetail, Machine, Permissions, SecondaryMaterialCategory } from "@/lib/types";
import CameraQrScanner from "@/components/storage/CameraQrScanner";

const CATEGORY_LABELS: Record<string, string> = { tray: "Base Tray", fgtray: "FG Non-Padded Tray" };
const SECONDARY_LABELS: Record<SecondaryMaterialCategory, string> = { cfb: "CFB", pad: "Pads", glue: "Glue", polybag: "Polybags" };
const SECONDARY_CATEGORIES: SecondaryMaterialCategory[] = ["cfb", "pad", "glue", "polybag"];

/**
 * "HH:MM" from THIS device's own clock -- used to stamp start_time the
 * moment the first pallet is scanned (see handlePrimaryScan) and, from the
 * Material Consumption list page's "Record End Time" action, end_time. Read
 * client-side rather than computed by the backend server, because the
 * backend can run anywhere (a cloud sandbox, a hosted server in a different
 * timezone) while this workstation is physically on the US factory floor --
 * its own clock is the only thing that's reliably in the factory's local
 * time. No network round-trip is needed to determine the time itself.
 */
export function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatTime12h(hhmm: string | null | undefined): string {
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

  const isFinalized = detail.status === "saved";
  const canEdit = (permissions.can_create || permissions.can_edit) && !isFinalized;

  // First primary pallet scan IS the start of work -- stamp this device's
  // current time as start_time atomically with that scan (see the backend's
  // add_primary_pallet), so there's no separate "press Start" step to miss.
  async function handlePrimaryScan(payload: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.scanMaterialConsumptionPallet(mcId, payload, nowHHMM());
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

  async function handleCancel() {
    // Always defer to the backend's own is_blank check rather than gating on
    // `touched` -- see the same fix applied to Inward Vehicle Inspection.
    if (detail.status === "draft") {
      try { await api.discardMaterialConsumptionIfBlank(mcId); } catch { /* best-effort */ }
    }
    onClose(false);
  }

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

          <div className="section-label">Scan Pallet QR</div>
          <div className="hint-text" style={{ marginBottom: 10 }}>
            Scan every RM pallet physically picked for this production run. The first pallet sets the Category, SKU Name and SKU Version for this record — every additional pallet must match, and its scan time is recorded as this record's Start Time automatically.
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

          <div className="section-label">Production Information</div>
          <div className="form-grid" style={{ marginBottom: 24 }}>
            <div className="field">
              <label>Machine</label>
              <select disabled={!canEdit} value={detail.machine_id || ""} onChange={(e) => patchBasic({ machine_id: e.target.value })}>
                <option value="">Select</option>
                {machines.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Shift</label>
              <select disabled={!canEdit} value={detail.shift || ""} onChange={(e) => patchBasic({ shift: e.target.value })}>
                <option value="">Select</option>
                {shifts.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Start Time</label>
              <div className="readonly-val mono">
                {detail.start_time ? formatTime12h(detail.start_time) : "— (recorded when first pallet is scanned)"}
              </div>
            </div>
            <div className="field">
              <label>End Time</label>
              <div className="readonly-val mono">
                {detail.end_time
                  ? formatTime12h(detail.end_time)
                  : "— (use \"Record End Time\" on the Material Consumption list once done)"}
              </div>
            </div>
          </div>

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
