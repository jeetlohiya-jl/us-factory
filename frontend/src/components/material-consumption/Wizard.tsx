"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { MaterialConsumptionDetail, MaterialConsumptionMachineEntry, Machine, Permissions, SecondaryMaterialCategory } from "@/lib/types";
import CameraQrScanner from "@/components/storage/CameraQrScanner";

const CATEGORY_LABELS: Record<string, string> = { tray: "Base Tray", fgtray: "FG Non-Padded Tray" };
const SECONDARY_LABELS: Record<SecondaryMaterialCategory, string> = { cfb: "CFB", pad: "Pads", glue: "Glue", polybag: "Polybags" };
const SECONDARY_CATEGORIES: SecondaryMaterialCategory[] = ["cfb", "pad", "glue", "polybag"];

/**
 * "HH:MM" from THIS device's own clock -- used to stamp start_time the
 * moment the first pallet is scanned (see handlePrimaryScan) and, per
 * machine entry, end_time when the operator presses "Record End Time".
 * Read client-side rather than computed by the backend server, because the
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

export function entryLabel(entry: MaterialConsumptionMachineEntry, index: number): string {
  return entry.machine || `Machine #${index + 1}`;
}

/**
 * A single scan input feeding one resolve call -- the same three input
 * methods as StorageScanPanel (HID-scanner-gun/manual text + Enter, or the
 * camera), just packaged as one reusable box instead of a fixed two-step
 * panel, since each machine entry scans N pallets rather than a fixed
 * pallet-then-location pair.
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

/**
 * Page 2's per-machine panel -- everything the spec calls out for one
 * machine entry: Machine (label, set on Page 1) -> Associated Pallet ->
 * Secondary Materials -> Start Time -> End Time. Pallet/secondary scanning,
 * validation and business logic are all unchanged from before -- only now
 * scoped to this one entry's own pallet set instead of the whole record's.
 */
function MachineEntryPanel({
  entry, index, canEdit, canRemove, busy, onScanPrimary, onScanSecondary, onRemovePallet, onQuantityChange, onRemoveEntry,
}: {
  entry: MaterialConsumptionMachineEntry;
  index: number;
  canEdit: boolean;
  canRemove: boolean;
  busy: boolean;
  onScanPrimary: (payload: string) => void;
  onScanSecondary: (category: SecondaryMaterialCategory, payload: string) => void;
  onRemovePallet: (rowId: string) => void;
  onQuantityChange: (rowId: string, value: string) => void;
  onRemoveEntry: () => void;
}) {
  const [secondaryCategory, setSecondaryCategory] = useState<SecondaryMaterialCategory | "">("");
  const hasPrimary = entry.pallets.length > 0;

  return (
    <div className="detail-card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div className="section-label" style={{ marginTop: 0, marginBottom: 0 }}>{entryLabel(entry, index)}</div>
        {canEdit && canRemove && entry.pallets.length === 0 && (
          <a className="btn-tertiary" style={{ color: "var(--red)", cursor: "pointer" }} onClick={onRemoveEntry}>Remove Machine</a>
        )}
      </div>

      <div className="section-label">Associated Pallet</div>
      {hasPrimary && (
        <div className="detail-card" style={{ marginBottom: 14 }}>
          <div className="detail-grid">
            <div><div className="detail-kv-label">Category</div><div className="detail-kv-value">{CATEGORY_LABELS[entry.category || ""] || entry.category || "—"}</div></div>
            <div><div className="detail-kv-label">SKU Name</div><div className="detail-kv-value">{entry.sku_code || "—"}</div></div>
            <div><div className="detail-kv-label">SKU Version</div><div className="detail-kv-value">{entry.sku_version || "—"}</div></div>
          </div>
        </div>
      )}

      {canEdit && !entry.end_time && (
        <div style={{ marginBottom: 14 }}>
          <ScanBox placeholder="Scan or enter RM pallet QR / ID" busy={busy} onScan={onScanPrimary} />
        </div>
      )}

      <table className="qc-obs-table" style={{ marginBottom: 20 }}>
        <thead><tr><th>Pallet</th><th>SKU Name</th><th>SKU Version</th><th style={{ width: 90 }}>Quantity</th><th></th></tr></thead>
        <tbody>
          {entry.pallets.length === 0 ? (
            <tr><td colSpan={5} className="hint-text">No pallet scanned yet.</td></tr>
          ) : (
            entry.pallets.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.pallet_display_id}</td>
                <td>{p.sku_code}</td>
                <td>{p.sku_version}</td>
                <td>{p.quantity}</td>
                <td>{canEdit && !entry.end_time && <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => onRemovePallet(p.id)}>Remove</a>}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="section-label">Secondary Materials</div>
      {(() => {
        const combined = SECONDARY_CATEGORIES.flatMap((cat) => entry.secondary_materials[cat].map((r) => ({ ...r, cat })));
        return combined.length > 0 ? (
          <table className="qc-obs-table" style={{ marginBottom: 14 }}>
            <thead><tr><th style={{ width: 90 }}>Type</th><th>Pallet</th><th>SKU</th><th style={{ width: 110 }}>Quantity</th><th></th></tr></thead>
            <tbody>
              {combined.map((r) => (
                <tr key={r.id}>
                  <td>{SECONDARY_LABELS[r.cat]}</td>
                  <td className="mono">{r.pallet_display_id}</td>
                  <td>{r.sku_code}</td>
                  <td>
                    <input
                      type="number" step="0.01" disabled={!canEdit || !!entry.end_time} defaultValue={String(r.quantity)}
                      onBlur={(e) => onQuantityChange(r.id, e.target.value)}
                    />
                  </td>
                  <td>{canEdit && !entry.end_time && <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => onRemovePallet(r.id)}>Remove</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="hint-text" style={{ marginBottom: 14 }}>No secondary materials added yet.</div>
        );
      })()}

      {canEdit && !entry.end_time && (
        <div className="field" style={{ maxWidth: 320 }}>
          <label>Add Secondary Material</label>
          <select
            value={secondaryCategory}
            onChange={(e) => setSecondaryCategory(e.target.value as SecondaryMaterialCategory | "")}
          >
            <option value="">Select to scan…</option>
            {SECONDARY_CATEGORIES.map((cat) => <option key={cat} value={cat}>{SECONDARY_LABELS[cat]}</option>)}
          </select>
          {secondaryCategory && (
            <div style={{ marginTop: 10 }}>
              <ScanBox
                placeholder={`Scan or enter ${SECONDARY_LABELS[secondaryCategory]} pallet QR / ID`}
                busy={busy}
                onScan={(p) => onScanSecondary(secondaryCategory, p)}
              />
            </div>
          )}
        </div>
      )}

      {/* End Time: read-only here -- it's no longer recorded by hand. It's
          stamped automatically (this same device-clock convention as Start
          Time) the moment Production saves the run this machine feeds, so
          this is just a status line, not a control. */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--rule)", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
        {entry.end_time ? (
          <span className="mono" style={{ fontSize: 12.5, opacity: 0.7 }}>Ended {formatTime12h(entry.end_time)}</span>
        ) : hasPrimary && entry.start_time ? (
          <span className="hint-text" style={{ fontSize: 12.5 }}>Ends automatically once Production saves this run</span>
        ) : null}
      </div>
    </div>
  );
}

export default function MaterialConsumptionWizard({
  mcId, initialDetail, machines, shifts, permissions, onClose, onSaved, isNew = false,
}: {
  mcId: string;
  initialDetail: MaterialConsumptionDetail;
  machines: Machine[];
  shifts: string[];
  permissions: Permissions;
  onClose: (deleted: boolean) => void;
  onSaved: () => void;
  // True only for a record just created this session via "+ New Record"
  // (never yet explicitly Saved/Submitted) -- see handleCancel.
  isNew?: boolean;
}) {
  const [detail, setDetail] = useState<MaterialConsumptionDetail>(initialDetail);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Page 1 = Production Details (Shift + Machines), Page 2 = per-machine
  // Pallet & Material Scanning. A finalized record opens straight to Page 2
  // since there's nothing left to edit on Page 1.
  const [page, setPage] = useState<1 | 2>(detail.status === "saved" ? 2 : 1);

  const isFinalized = detail.status === "saved";
  const canEdit = (permissions.can_create || permissions.can_edit) && !isFinalized;
  const allEntriesReady = detail.machine_entries.length > 0 && detail.machine_entries.every(
    (e) => e.machine_id && e.pallets.length > 0 && e.start_time && e.end_time,
  );
  const canProceedToPage2 = !!detail.shift && detail.machine_entries.length > 0 && detail.machine_entries.every((e) => e.machine_id);

  async function handlePrimaryScan(entryId: string, payload: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.scanMaterialConsumptionPallet(mcId, entryId, payload, nowHHMM());
      setDetail(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not resolve that pallet QR.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSecondaryScan(entryId: string, category: SecondaryMaterialCategory, payload: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.scanMaterialConsumptionSecondary(mcId, entryId, payload, category);
      setDetail(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not resolve that pallet QR.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemovePallet(rowId: string) {
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

  async function handleShiftChange(shift: string) {
    // Optimistic: the <select>'s value is bound to `detail.shift`, so update
    // it locally the instant the user picks an option instead of waiting on
    // the PUT round trip -- the network save still happens, this just stops
    // the dropdown itself from lagging behind the click. Roll back to the
    // previous value if the save actually fails.
    const previous = detail;
    setDetail((d) => ({ ...d, shift }));
    try {
      const updated = await api.updateMaterialConsumptionBasic(mcId, { shift });
      setDetail(updated);
    } catch (e) {
      setDetail(previous);
      setError(e instanceof Error ? e.message : "Failed to save");
    }
  }

  async function handleAddMachineEntry() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.addMaterialConsumptionMachineEntry(mcId, null);
      setDetail(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add machine");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMachineEntry(entryId: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.removeMaterialConsumptionMachineEntry(mcId, entryId);
      setDetail(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to remove machine");
    } finally {
      setBusy(false);
    }
  }

  async function handleSetEntryMachine(entryId: string, machineId: string) {
    // Same optimistic-update reasoning as handleShiftChange: this <select>
    // is bound to `entry.machine_id`, so patch it into local state right
    // away rather than waiting on the PUT before the dropdown reflects the
    // choice. Rolled back on failure.
    const previous = detail;
    setDetail((d) => ({
      ...d,
      machine_entries: d.machine_entries.map((e) => (e.id === entryId ? { ...e, machine_id: machineId || null } : e)),
    }));
    try {
      const updated = await api.setMaterialConsumptionMachineEntryMachine(mcId, entryId, machineId || null);
      setDetail(updated);
    } catch (e) {
      setDetail(previous);
      setError(e instanceof ApiError ? e.message : "Failed to set machine");
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

  async function handleFinalize() {
    setBusy(true);
    setError(null);
    try {
      await api.finalizeMaterialConsumption(mcId);
      onSaved();
      onClose(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to save record");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (isNew) {
      // Creating a NEW record: Cancel must discard the unsaved form state
      // completely -- whether no fields/pallets were entered, some were,
      // or all were. Unlike Edit-an-existing-record, this never depends on
      // whether the record is "blank" (child machine-entry/pallet rows
      // cascade-delete with it; nothing was ever marked consumed pre-
      // finalize, so there's no inventory to release).
      if (detail.status === "draft") {
        try { await api.discardNewMaterialConsumption(mcId); } catch { /* best-effort */ }
      }
      onClose(true);
      return;
    }
    // Editing an existing record: only clean up if genuinely blank --
    // unchanged prior behavior.
    if (detail.status === "draft") {
      try { await api.discardMaterialConsumptionIfBlank(mcId); } catch { /* best-effort */ }
    }
    onClose(false);
  }

  const chosenMachineIds = new Set(detail.machine_entries.map((e) => e.machine_id).filter(Boolean) as string[]);

  return (
    <>
      <div className="panel-overlay open" onClick={handleCancel} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{page === 1 ? "New Material Consumption — Production Details" : "New Material Consumption — Pallet & Material Scanning"}</h2>
            <div className="sub">
              {detail.consumption_date} · <span className={`badge ${detail.status === "saved" ? "approved" : "draft"}`}>{detail.status === "saved" ? "Saved" : "Draft"}</span>
              {detail.production_run_number && <> · Production Run {detail.production_run_number}</>}
            </div>
          </div>
          <button className="sp-close" onClick={handleCancel}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          {page === 1 ? (
            <>
              <div className="section-label" style={{ marginTop: 0 }}>Production Details</div>
              <div className="form-grid" style={{ marginBottom: 18 }}>
                <div className="field">
                  <label>Shift</label>
                  <select disabled={!canEdit} value={detail.shift || ""} onChange={(e) => handleShiftChange(e.target.value)}>
                    <option value="">Select</option>
                    {shifts.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div className="section-label">Machines</div>
              {detail.machine_entries.map((entry, i) => (
                <div key={entry.id} className="form-grid" style={{ marginBottom: 10, alignItems: "end" }}>
                  <div className="field">
                    <label>Machine {i + 1}</label>
                    <select
                      disabled={!canEdit}
                      value={entry.machine_id || ""}
                      onChange={(e) => handleSetEntryMachine(entry.id, e.target.value)}
                    >
                      <option value="">Select</option>
                      {machines.filter((m) => m.id === entry.machine_id || !chosenMachineIds.has(m.id)).map((m) => (
                        <option key={m.id} value={m.id}>{m.code}</option>
                      ))}
                    </select>
                  </div>
                  {canEdit && detail.machine_entries.length > 1 && (
                    <a className="btn-tertiary" style={{ color: "var(--red)", cursor: "pointer", marginBottom: 10 }} onClick={() => handleRemoveMachineEntry(entry.id)}>Remove</a>
                  )}
                </div>
              ))}
              {canEdit && (
                <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={handleAddMachineEntry}>+ Add Machine</a>
              )}
            </>
          ) : (
            <>
              {detail.machine_entries.map((entry, i) => (
                <MachineEntryPanel
                  key={entry.id}
                  entry={entry}
                  index={i}
                  canEdit={canEdit}
                  canRemove={detail.machine_entries.length > 1}
                  busy={busy}
                  onScanPrimary={(payload) => handlePrimaryScan(entry.id, payload)}
                  onScanSecondary={(cat, payload) => handleSecondaryScan(entry.id, cat, payload)}
                  onRemovePallet={handleRemovePallet}
                  onQuantityChange={handleQuantityChange}
                  onRemoveEntry={() => handleRemoveMachineEntry(entry.id)}
                />
              ))}
            </>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
          <div className="sp-foot-right">
            {page === 1 ? (
              canEdit && (
                <button className="btn btn-primary" disabled={!canProceedToPage2} onClick={() => setPage(2)}>Next: Scan Pallets →</button>
              )
            ) : (
              <>
                {canEdit && <button className="btn btn-ghost" onClick={() => setPage(1)}>← Back</button>}
                {canEdit && <button className="btn btn-secondary" disabled={busy} onClick={handleSaveDraft}>Save Draft</button>}
                {canEdit && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                    <button className="btn btn-primary" disabled={busy || !allEntriesReady} onClick={handleFinalize}>
                      Finalize Record
                    </button>
                    {!allEntriesReady && detail.machine_entries.some((e) => e.start_time) && (
                      <span className="hint-text" style={{ fontSize: 12 }}>
                        Waiting on Production to save this shift&apos;s run (sets each machine&apos;s End Time).
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
