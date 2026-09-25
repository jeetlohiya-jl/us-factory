"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { MaterialConsumptionDetail, MaterialConsumptionMachineEntry, MaterialConsumptionScanPreview, Machine, Permissions, SecondaryMaterialCategory, QuantityUnit } from "@/lib/types";
import { QUANTITY_UNITS, QC_CATEGORY_LABELS } from "@/lib/types";
import CameraQrScanner from "@/components/storage/CameraQrScanner";
import { T } from "@/lib/terms";

const CATEGORY_LABELS = QC_CATEGORY_LABELS;
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
 * 2026-09-25: the one confirmation step every generic scan goes through.
 * MachineEntryPanel calls scan-preview (read-only -- nothing is added yet)
 * the instant something is scanned, and shows whatever it resolved to here
 * -- a pallet or any secondary material, whichever it turned out to be --
 * before the operator commits it with OK or throws it back with Cancel.
 */
function ScanConfirmModal({
  preview, secondaryLabels, busy, onConfirm, onCancel,
}: {
  preview: MaterialConsumptionScanPreview;
  secondaryLabels: Record<SecondaryMaterialCategory, string>;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const roleLabel = preview.role === "primary" ? "Associated Pallet" : secondaryLabels[preview.role];
  return (
    <div className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div className="card" style={{ maxWidth: 420, width: "90%", padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>Confirm Scan</h3>
        <div className="detail-grid" style={{ marginBottom: 16 }}>
          <div><div className="detail-kv-label">Type</div><div className="detail-kv-value">{roleLabel}</div></div>
          <div><div className="detail-kv-label">Pallet</div><div className="detail-kv-value mono">{preview.pallet_display_id}</div></div>
          <div><div className="detail-kv-label">Category</div><div className="detail-kv-value">{CATEGORY_LABELS[preview.category || ""] || preview.category || "—"}</div></div>
          <div><div className="detail-kv-label">{T.sku}</div><div className="detail-kv-value">{preview.sku_code || "—"}</div></div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onConfirm}>OK</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Page 2's per-machine panel -- everything the spec calls out for one
 * machine entry: Machine (label, set on Page 1) -> Associated Pallet ->
 * Secondary Materials -> Start Time -> End Time.
 *
 * 2026-09-25: scanning is one generic box, not a choice between "scan a
 * pallet" and "scan a secondary material" -- the operator scans whatever
 * they physically picked up and the app figures out what it is from the
 * pallet's own category (see preview_scanned_pallet/add_scanned_pallet).
 * Every scan previews first (read-only, nothing added yet) and shows an
 * OK/Cancel confirmation with what it resolved to; OK commits it as a
 * primary pallet or the matching secondary-material row, whichever it is.
 */
function MachineEntryPanel({
  entry, index, canEdit, canRemove, busy, onPreviewScan, onCommitScan, onRemovePallet, onQuantityChange, onPrimaryConsumptionChange, onRemoveEntry,
}: {
  entry: MaterialConsumptionMachineEntry;
  index: number;
  canEdit: boolean;
  canRemove: boolean;
  busy: boolean;
  onPreviewScan: (payload: string) => Promise<MaterialConsumptionScanPreview | null>;
  onCommitScan: (payload: string) => Promise<void>;
  onRemovePallet: (rowId: string) => void;
  onQuantityChange: (rowId: string, value: string, unit?: QuantityUnit) => void;
  onPrimaryConsumptionChange: (rowId: string, quantity: string, unit: QuantityUnit, fullyConsumed: boolean) => void;
  onRemoveEntry: () => void;
}) {
  // Redesigned scanning flow (Section 10 follow-up, then 2026-09-25): scan
  // first, ask questions after -- no upfront Quantity/Unit/Fully-Consumed
  // form before the pallet is even known. A fresh scan is still recorded
  // with the pre-Section-8-compatible defaults (whole pallet, fully
  // consumed); the operator then adjusts "Fully Consumed" and, only if not
  // fully consumed, Quantity/Unit inline on that row via
  // onPrimaryConsumptionChange -- the same generic update path used before,
  // just triggered from the table instead of a form ahead of the scan.
  const hasPrimary = entry.pallets.length > 0;

  // One generic scan box per machine feeds this: a scan is previewed first
  // (nothing added yet), and while `confirming` holds a result the modal
  // below shows it for OK/Cancel. Cancel just clears it -- since preview
  // never wrote anything, there's nothing to undo.
  const [confirming, setConfirming] = useState<{ payload: string; preview: MaterialConsumptionScanPreview } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  async function handleScan(payload: string) {
    const preview = await onPreviewScan(payload);
    if (preview) setConfirming({ payload, preview });
  }
  async function handleConfirm() {
    if (!confirming) return;
    setConfirmBusy(true);
    try {
      await onCommitScan(confirming.payload);
      setConfirming(null);
    } finally {
      setConfirmBusy(false);
    }
  }

  // 2026-09-24 fix -- "Fully Consumed: No" used to fire onPrimaryConsumptionChange
  // immediately on click, with whatever stale default quantity the row
  // already had (the fresh-scan default of "1 Pallet"), silently committing
  // that to the server before the operator had entered anything real. This
  // set tracks rows where "No" has been clicked locally but a real Quantity
  // Consumed hasn't been confirmed yet -- nothing is sent to the server
  // until the operator actually types a quantity and confirms it, so the
  // click now genuinely "asks" for the quantity rather than defaulting it.
  const [awaitingQuantity, setAwaitingQuantity] = useState<Set<string>>(new Set());
  const [draftQuantity, setDraftQuantity] = useState<Record<string, string>>({});
  const [draftUnit, setDraftUnit] = useState<Record<string, QuantityUnit>>({});

  function clickNotFullyConsumed(rowId: string, currentUnit: QuantityUnit) {
    setAwaitingQuantity((prev) => new Set(prev).add(rowId));
    setDraftQuantity((prev) => ({ ...prev, [rowId]: "" }));
    setDraftUnit((prev) => ({ ...prev, [rowId]: currentUnit }));
  }
  function clickFullyConsumed(rowId: string, quantity: string, unit: QuantityUnit) {
    setAwaitingQuantity((prev) => { const next = new Set(prev); next.delete(rowId); return next; });
    onPrimaryConsumptionChange(rowId, quantity, unit, true);
  }
  function confirmQuantityConsumed(rowId: string, fallbackUnit: QuantityUnit) {
    const raw = (draftQuantity[rowId] ?? "").trim();
    if (!raw || Number(raw) <= 0) return; // nothing valid entered yet -- keep waiting, don't commit
    const unit = draftUnit[rowId] ?? fallbackUnit;
    onPrimaryConsumptionChange(rowId, raw, unit, false);
    setAwaitingQuantity((prev) => { const next = new Set(prev); next.delete(rowId); return next; });
  }

  return (
    <div className="detail-card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div className="section-label" style={{ marginTop: 0, marginBottom: 0 }}>{entryLabel(entry, index)}</div>
        {canEdit && canRemove && entry.pallets.length === 0 && (
          <a className="btn-tertiary" style={{ color: "var(--red)", cursor: "pointer" }} onClick={onRemoveEntry}>Remove Machine</a>
        )}
      </div>

      {canEdit && !entry.end_time && (
        <div style={{ marginBottom: 14 }}>
          <ScanBox
            placeholder="Scan or enter pallet / material QR"
            busy={busy || confirmBusy}
            onScan={handleScan}
          />
          <div className="hint-text" style={{ marginTop: 6 }}>
            Scan any RM pallet or secondary material -- confirm what it is before it's added.
          </div>
        </div>
      )}
      {confirming && (
        <ScanConfirmModal
          preview={confirming.preview}
          secondaryLabels={SECONDARY_LABELS}
          busy={confirmBusy}
          onConfirm={handleConfirm}
          onCancel={() => setConfirming(null)}
        />
      )}

      <div className="section-label">Associated Pallet</div>
      {hasPrimary ? (
        <div className="detail-card" style={{ marginBottom: 14 }}>
          <div className="detail-grid">
            <div><div className="detail-kv-label">Category</div><div className="detail-kv-value">{CATEGORY_LABELS[entry.category || ""] || entry.category || "—"}</div></div>
            <div><div className="detail-kv-label">{T.sku}</div><div className="detail-kv-value">{entry.sku_code || "—"}</div></div>
          </div>
        </div>
      ) : (
        <div className="hint-text" style={{ marginBottom: 14 }}>
          Once scanned, set &quot;Fully Consumed&quot; on the row below -- if not, you&apos;ll be asked for the quantity drawn.
        </div>
      )}

      {hasPrimary && (
        <div className="hint-text" style={{ marginBottom: 6 }}>
          {entry.pallets.length} pallet{entry.pallets.length === 1 ? "" : "s"} scanned for this machine.
        </div>
      )}
      <table className="qc-obs-table" style={{ marginBottom: 20 }}>
        <thead><tr><th>Pallet</th><th>{T.sku}</th><th style={{ width: 170 }}>Fully Consumed</th><th></th></tr></thead>
        <tbody>
          {entry.pallets.length === 0 ? (
            <tr><td colSpan={4} className="hint-text">No pallet scanned yet.</td></tr>
          ) : (
            entry.pallets.map((p) => {
              const editableRow = canEdit && !entry.end_time;
              // Waiting on a real Quantity Consumed value: either "No" was
              // just clicked locally (nothing committed yet), or the row was
              // already saved as not-fully-consumed and is being re-edited.
              const isAwaiting = awaitingQuantity.has(p.id);
              const showQuantityAsk = isAwaiting || !p.fully_consumed;
              const selectedUnit = isAwaiting ? (draftUnit[p.id] ?? p.unit) : p.unit;
              return (
                <tr key={p.id}>
                  <td className="mono">{p.pallet_display_id}</td>
                  <td>{p.sku_code}</td>
                  <td>
                    {editableRow ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            type="button"
                            className={`btn ${!showQuantityAsk ? "btn-primary" : "btn-secondary"}`}
                            style={{ padding: "3px 10px", fontSize: 12.5 }}
                            onClick={() => clickFullyConsumed(p.id, String(p.quantity), p.unit)}
                          >Yes</button>
                          <button
                            type="button"
                            className={`btn ${showQuantityAsk ? "btn-primary" : "btn-secondary"}`}
                            style={{ padding: "3px 10px", fontSize: 12.5 }}
                            onClick={() => clickNotFullyConsumed(p.id, p.unit)}
                          >No</button>
                        </div>
                        {showQuantityAsk && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <div className="hint-text" style={{ fontSize: 11.5, color: isAwaiting ? "var(--red)" : undefined }}>
                              {isAwaiting ? "Quantity Consumed required" : "Quantity Consumed"}
                            </div>
                            <div style={{ display: "flex", gap: 6 }}>
                              <input
                                type="number" step="0.01" min="0" placeholder="Quantity consumed" autoFocus={isAwaiting}
                                style={{ width: 90 }}
                                value={isAwaiting ? (draftQuantity[p.id] ?? "") : String(p.quantity)}
                                onChange={(e) => setDraftQuantity((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                onBlur={() => (isAwaiting ? confirmQuantityConsumed(p.id, selectedUnit) : onPrimaryConsumptionChange(p.id, draftQuantity[p.id] ?? String(p.quantity), p.unit, false))}
                                onKeyDown={(e) => e.key === "Enter" && isAwaiting && confirmQuantityConsumed(p.id, selectedUnit)}
                              />
                              <select
                                value={selectedUnit}
                                onChange={(e) => {
                                  const unit = e.target.value as QuantityUnit;
                                  if (isAwaiting) {
                                    setDraftUnit((prev) => ({ ...prev, [p.id]: unit }));
                                  } else {
                                    onPrimaryConsumptionChange(p.id, String(p.quantity), unit, false);
                                  }
                                }}
                              >
                                {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                              </select>
                              {isAwaiting && (
                                <button
                                  type="button" className="btn btn-primary" style={{ padding: "3px 10px", fontSize: 12.5 }}
                                  onClick={() => confirmQuantityConsumed(p.id, selectedUnit)}
                                >Confirm</button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      p.fully_consumed ? "Yes" : `No — ${p.quantity} ${p.unit}`
                    )}
                  </td>
                  <td>{canEdit && !entry.end_time && <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => onRemovePallet(p.id)}>Remove</a>}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <div className="section-label">Secondary Materials</div>
      {(() => {
        const combined = SECONDARY_CATEGORIES.flatMap((cat) => entry.secondary_materials[cat].map((r) => ({ ...r, cat })));
        return combined.length > 0 ? (
          <table className="qc-obs-table" style={{ marginBottom: 14 }}>
            <thead><tr><th style={{ width: 110 }}>Type</th><th>Pallet</th><th>SKU</th><th style={{ width: 90 }}>Quantity</th><th style={{ width: 90 }}>Unit</th><th></th></tr></thead>
            <tbody>
              {/* Section 9: every distinct pallet scanned for a secondary
                  category shows as its own row here -- an operator can keep
                  scanning more CFB/Pad/Glue/Polybag pallets into the same
                  record with no cap and no FIFO/auto-assignment; each scan
                  is its own explicit row, same as primary pallets. Quantity
                  and Unit are editable directly on every row -- no
                  Fully-Consumed gate for secondary materials. Rows only
                  ever arrive here via the one generic scan box above (its
                  category comes from the scanned pallet itself, never a
                  dropdown the operator sets ahead of time). */}
              {combined.map((r) => (
                <tr key={r.id}>
                  <td>{SECONDARY_LABELS[r.cat]}</td>
                  <td className="mono">{r.pallet_display_id}</td>
                  <td>{r.sku_code}</td>
                  <td>
                    <input
                      type="number" step="0.01" min="0" disabled={!canEdit || !!entry.end_time} defaultValue={String(r.quantity)}
                      onBlur={(e) => onQuantityChange(r.id, e.target.value, r.unit)}
                    />
                  </td>
                  <td>
                    {canEdit && !entry.end_time ? (
                      <select value={r.unit} onChange={(e) => onQuantityChange(r.id, String(r.quantity), e.target.value as QuantityUnit)}>
                        {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    ) : r.unit}
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

  // One generic scanner (2026-09-25): preview resolves + validates a scan
  // without committing it (nothing is added on the server yet), so the
  // panel can show an OK/Cancel confirmation; commit is the OK step, which
  // re-resolves the same payload and adds it as whichever kind it is.
  async function handlePreviewScan(entryId: string, payload: string): Promise<MaterialConsumptionScanPreview | null> {
    setBusy(true);
    setError(null);
    try {
      return await api.previewMaterialConsumptionScan(mcId, entryId, payload);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not resolve that scan.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleCommitScan(entryId: string, payload: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.commitMaterialConsumptionScan(mcId, entryId, payload, nowHHMM());
      setDetail(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not resolve that scan.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePrimaryConsumptionChange(rowId: string, quantity: string, unit: QuantityUnit, fullyConsumed: boolean) {
    try {
      const updated = await api.setMaterialConsumptionPalletQuantity(mcId, rowId, quantity, { unit, fullyConsumed });
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update consumption");
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

  async function handleQuantityChange(rowId: string, value: string, unit?: QuantityUnit) {
    try {
      const updated = await api.setMaterialConsumptionPalletQuantity(mcId, rowId, value, unit ? { unit } : undefined);
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
            <h2>{page === 1 ? "New RM Requisition — Production Details" : "New RM Requisition — Scan Materials"}</h2>
            <div className="sub">
              {detail.consumption_date} · <span className={`badge ${detail.status === "saved" ? "approved" : "draft"}`}>{detail.status === "saved" ? "Saved" : "Draft"}</span>
              {detail.production_run_number && <> · Production Run {detail.production_run_number}</>}
              {/* Operator: never an input -- always whoever's own logged-in
                  session created this record (created_by, stamped server-side
                  at creation time), surfaced here read-only. */}
              {detail.shipment_number && <> · Shipment {detail.shipment_number}</>}
              {detail.operator && <> · Operator: {detail.operator}</>}
            </div>
          </div>
          <button className="sp-close" onClick={handleCancel}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          {page === 1 ? (
            <>
              <div className="section-label" style={{ marginTop: 0 }}>Machines</div>
              {/* Shift is one record-level field shared across the whole
                  record (not per-machine), but it's shown inline in the
                  same row as Machine 1 -- rather than its own separate
                  "Production Details" row above -- per explicit request to
                  keep Machine and Shift next to each other instead of on
                  their own lines. */}
              {detail.machine_entries.map((entry, i) => (
                <div key={entry.id} className="form-grid" style={{ marginBottom: 10, alignItems: "end" }}>
                  {i === 0 && (
                    <div className="field">
                      <label>Shift</label>
                      <select disabled={!canEdit} value={detail.shift || ""} onChange={(e) => handleShiftChange(e.target.value)}>
                        <option value="">Select</option>
                        {shifts.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  )}
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
                  onPreviewScan={(payload) => handlePreviewScan(entry.id, payload)}
                  onCommitScan={(payload) => handleCommitScan(entry.id, payload)}
                  onRemovePallet={handleRemovePallet}
                  onQuantityChange={handleQuantityChange}
                  onPrimaryConsumptionChange={handlePrimaryConsumptionChange}
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
                <button className="btn btn-primary" disabled={!canProceedToPage2} onClick={() => setPage(2)}>Next: Scan Materials →</button>
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
