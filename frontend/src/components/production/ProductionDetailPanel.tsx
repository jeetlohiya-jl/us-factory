"use client";
import { useState } from "react";
import Link from "next/link";
import type { ProductionDetail, Machine } from "@/lib/types";
import { QC_CATEGORY_LABELS } from "@/lib/types";
import { formatTime12h, nowHHMM } from "@/components/material-consumption/Wizard";
import { api } from "@/lib/api";
import ConsumptionConfirmModal from "@/components/production/ConsumptionConfirmModal";
import { T } from "@/lib/terms";

const CATEGORY_LABELS = QC_CATEGORY_LABELS;

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "approved" || status === "saved" ? "approved" : status === "hold" ? "hold" : "pending";
  return <span className={`badge ${cls}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

// Rejection Classification field order/labels, matching the prototype's
// #prod-rc-* inputs exactly (Damage, Misplaced glue, Misplaced pad, Glue on
// pad, Pad placement direction, Adhesion issue).
const REJECTION_FIELDS: { key: keyof ProductionDetail["rejection_classification"]; label: string }[] = [
  { key: "damage", label: "Damage" },
  { key: "misplaced_glue", label: "Misplaced glue" },
  { key: "misplaced_pad", label: "Misplaced pad" },
  { key: "glue_on_pad", label: "Glue on pad" },
  { key: "pad_placement_direction", label: "Pad placement direction" },
  { key: "adhesion_issue", label: "Adhesion issue" },
];

type EditableWastage = { machine_id: string | null; trays: number | null; reason: string | null };

// Section 12: which EditableAttrs key each editable row writes to, when the
// row is editable at all (SKU Name is always pure display -- there's no
// override field for it, changing SKU means scanning a different pallet).
// Migration 0038 folds Rejection Classification's six fields into this
// same per-machine-entry editable-attribute mechanism (attrEdits/
// setAttrEdit/machine_entry_attributes) instead of a separate flow -- it's
// the exact same shape (one value per machine entry per field).
type AttrKey = "machine_no" | "auto_padding" | "container_order_no" | "weight" | "pcs_per_sleeve" | "sleeve_per_case" | "total_pcs_per_pallet" | "pad_type" | "pad_color"
  | "rejection_damage" | "rejection_misplaced_glue" | "rejection_misplaced_pad" | "rejection_glue_on_pad" | "rejection_pad_placement_direction" | "rejection_adhesion_issue"
  | "pallets_produced";

// Production Details rows, matching the prototype's PROD_ATTRIBUTES exactly
// (label text included) -- one row per attribute, one column per machine.
// Section 12 adds Machine No./Auto Padding/Container Order No. (brand new)
// and makes every backend-populated attribute editable via `attrKey`.
// Pallets Produced (migration 0039) gets its own dedicated "FG Pallets
// Generated" card below instead of a row here -- it's the figure RQC and FG
// QR Generation actually key off, so it's called out on its own rather than
// buried in this reference table.
// 2026-09-25 -- Case Type is dropped entirely (no longer tracked anywhere,
// see skus/page.tsx). Total No. of Pcs/Pallet is no longer editable here:
// it's mechanically derived from Trays/Sleeve x Sleeve/Combo on the SKU
// Names admin screen now, so this row is display-only (no attrKey) to
// avoid a per-machine-entry override drifting out of sync with that.
const PROD_DETAIL_ROWS: { label: string; attrKey?: AttrKey; get: (e: ProductionDetail["machine_entries"][number]) => React.ReactNode }[] = [
  { label: T.sku, get: (e) => e.sku_code },
  { label: "Trays/Sleeve", attrKey: "pcs_per_sleeve", get: (e) => e.production_details?.prod_pcs_per_sleeve },
  { label: "Sleeve/Combo", attrKey: "sleeve_per_case", get: (e) => e.production_details?.prod_sleeve_per_case },
  { label: "Total No. of Pcs/Pallet", get: (e) => e.production_details?.prod_total_pcs_per_pallet },
  { label: "Pad Type/Name/Code", attrKey: "pad_type", get: (e) => e.production_details?.prod_pad_type },
  { label: "Pad Color", attrKey: "pad_color", get: (e) => e.production_details?.prod_pad_color },
];

function sumProductionDetails(entries: ProductionDetail["machine_entries"], key: "prod_total_pcs_per_pallet"): number | null {
  let total = 0;
  let any = false;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.production_details) continue;
    const dedupeKey = e.sku_version_id || `${e.sku_code}/${e.sku_version}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const v = e.production_details[key];
    if (v != null) { total += Number(v) || 0; any = true; }
  }
  return any ? total : null;
}

function sumRejections(rc: ProductionDetail["rejection_classification"]): number {
  return REJECTION_FIELDS.reduce((sum, f) => sum + (Number(rc[f.key]) || 0), 0);
}

/**
 * Production Run detail view -- read-only General Information, Machine
 * Entries (with each machine's SKU-derived Production Details, autopopulated
 * and never re-entered) and Downstream Records, plus an editable Rejection
 * Classification / Wastage / FG Pallets section matching the prototype's
 * "New Production Record" panel exactly. Saving posts the atomic write to
 * FastAPI (backend/app/api/production.py's PUT route) and advances status
 * from Pending to Saved, matching prodSaveRecord.
 */
export default function ProductionDetailPanel({
  record, onClose, canEdit, machines, onSaved, mode, onEdit,
}: {
  record: ProductionDetail;
  onClose: () => void;
  canEdit: boolean;
  machines: Machine[];
  onSaved: () => void;
  mode: "view" | "edit";
  // Same convention as Inward QC's RecordDetail: view mode gets its own
  // "Edit" action in the footer instead of forcing a close-and-reopen from
  // the list's More menu, so switching from viewing to filling in this
  // record doesn't need a trip back out.
  onEdit?: () => void;
}) {
  const [wastage, setWastage] = useState<EditableWastage[]>(
    record.wastage_entries.map((w) => ({ machine_id: w.machine_id, trays: w.trays, reason: w.reason }))
  );
  // Section 12: keyed by machine_consumption_id -> { attrKey -> value },
  // seeded from the record's current (already-override-merged) values so
  // editing starts from what's actually displayed. Migration 0038 adds
  // each entry's own Rejection Classification counts to this same seed
  // (blank input == 0, matching the old single-column behaviour).
  const [attrEdits, setAttrEdits] = useState<Record<string, Partial<Record<AttrKey, string>>>>(
    Object.fromEntries(
      record.machine_entries.map((e) => [
        e.machine_consumption_id,
        {
          machine_no: e.machine_no || "", auto_padding: e.auto_padding || "", container_order_no: e.container_order_no || "",
          weight: e.production_details?.prod_weight || "", pcs_per_sleeve: e.production_details?.prod_pcs_per_sleeve || "",
          sleeve_per_case: e.production_details?.prod_sleeve_per_case || "",
          total_pcs_per_pallet: e.production_details?.prod_total_pcs_per_pallet != null ? String(e.production_details.prod_total_pcs_per_pallet) : "",
          pad_type: e.production_details?.prod_pad_type || "", pad_color: e.production_details?.prod_pad_color || "",
          rejection_damage: e.rejection_classification.damage ? String(e.rejection_classification.damage) : "",
          rejection_misplaced_glue: e.rejection_classification.misplaced_glue ? String(e.rejection_classification.misplaced_glue) : "",
          rejection_misplaced_pad: e.rejection_classification.misplaced_pad ? String(e.rejection_classification.misplaced_pad) : "",
          rejection_glue_on_pad: e.rejection_classification.glue_on_pad ? String(e.rejection_classification.glue_on_pad) : "",
          rejection_pad_placement_direction: e.rejection_classification.pad_placement_direction ? String(e.rejection_classification.pad_placement_direction) : "",
          rejection_adhesion_issue: e.rejection_classification.adhesion_issue ? String(e.rejection_classification.adhesion_issue) : "",
          pallets_produced: e.pallets_produced ? String(e.pallets_produced) : "",
        },
      ])
    )
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 5 -- shown right before the real save, per the user's explicit
  // direction that saving Production must never implicitly mean "all raw
  // material consumed" any more. See ConsumptionConfirmModal.
  const [showConsumptionConfirm, setShowConsumptionConfirm] = useState(false);

  function setAttrEdit(entryId: string, key: AttrKey, value: string) {
    setAttrEdits((prev) => ({ ...prev, [entryId]: { ...prev[entryId], [key]: value } }));
  }

  // "Edit" is the focused fill-in form -- just Rejection Classification /
  // Wastage / FG Pallets, the fields this record actually needs a human to
  // enter. Everything Material Consumption already populated (General
  // Information, per-machine Production Details/Machine Entries,
  // Downstream Records) is reference material that belongs in "View"
  // instead, not something to page past every time someone opens this to
  // log rejections.
  const isEdit = mode === "edit";
  const editable = isEdit && canEdit;
  const totalPcsPerPallet = sumProductionDetails(record.machine_entries, "prod_total_pcs_per_pallet");
  const totalRejections = sumRejections(record.rejection_classification);
  const totalPalletsProduced = record.total_pallets_produced;

  const runMachines = Array.from(new Set(record.machine_entries.map((e) => e.machine).filter((m): m is string => !!m)));

  function addWastageEntry() {
    setWastage((w) => [...w, { machine_id: null, trays: null, reason: "" }]);
  }
  function updateWastageEntry(i: number, patch: Partial<EditableWastage>) {
    setWastage((w) => w.map((entry, idx) => (idx === i ? { ...entry, ...patch } : entry)));
  }
  function removeWastageEntry(i: number) {
    setWastage((w) => w.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.saveProduction(record.id, {
        // DEPRECATED as of migration 0038 -- Rejection Classification is
        // now sent per machine entry via machine_entry_attributes below
        // (each entry's rejection_* keys, already included in `edits`).
        // These flat fields are kept only for payload-shape compatibility;
        // the backend ignores them.
        rejection_damage: 0,
        rejection_misplaced_glue: 0,
        rejection_misplaced_pad: 0,
        rejection_glue_on_pad: 0,
        rejection_pad_placement_direction: 0,
        rejection_adhesion_issue: 0,
        // No longer editable here (moved to RQC's "Number of FG Pallets
        // Generated" -- see RqcDetailPanel.tsx); the backend ignores this
        // field now (api/production.py's save route), so this just echoes
        // back whatever the record already had rather than changing the
        // payload shape.
        total_fg_pallets: record.total_fg_pallets || 0,
        wastage_entries: wastage.map((w) => ({ machine_id: w.machine_id, trays: w.trays, reason: w.reason })),
        machine_entry_attributes: Object.entries(attrEdits).map(([machine_entry_id, edits]) => ({
          machine_entry_id, ...edits,
        })),
        // This save is now what stamps End Time on every Material
        // Consumption machine entry it feeds -- send this device's own
        // clock, same convention as Material Consumption's Start Time.
        client_time: nowHHMM(),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save record");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>Production Run</h2>
            <div className="sub mono">{record.run_number}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {!isEdit && (
            <div className="detail-card">
              <h3>General Information</h3>
              <div className="detail-grid">
                <Kv label="Production Run ID" value={<span className="mono">{record.run_number}</span>} />
                <Kv label={T.shipmentNumber} value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
                <Kv label="SKU Code(s)" value={record.sku_codes || "—"} />
                <Kv label="Date" value={record.date} />
                <Kv label="Shift" value={record.shift} />
                <Kv label="Operator" value={record.operator} />
                <Kv label="Status" value={<StatusBadge status={record.status} />} />
                <Kv label="Total PCS/Pallet" value={totalPcsPerPallet ?? "—"} />
                <Kv label="Total Pallets Produced" value={totalPalletsProduced} />
                <Kv label="Total Rejections" value={totalRejections} />
                <Kv
                  label="Completed By"
                  value={record.completed_by ? (
                    <>
                      {record.completed_by}
                      {record.completed_at && <span style={{ opacity: 0.65 }}> · {new Date(record.completed_at).toLocaleString()}</span>}
                    </>
                  ) : "Not yet completed"}
                />
              </div>
            </div>
          )}

          {/* Section 12: visible AND editable in both the Pending-completion
              (isEdit) and Edit flows -- no longer hidden behind `!isEdit`.
              Backend-populated attributes stay editable per machine entry
              (an override, never a change to the shared SKU Version data);
              Machine No./Auto Padding/Container Order No. are brand-new
              fields with no other source. */}
          {record.machine_entries.length > 0 && (
            <div className="detail-card">
              <h3>Production Details</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="qc-obs-table">
                  <thead>
                    <tr>
                      <th>Attribute</th>
                      {record.machine_entries.map((e, i) => <th key={e.machine_consumption_id}>{e.machine || `Machine #${i + 1}`}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {PROD_DETAIL_ROWS.map((row) => (
                      <tr key={row.label}>
                        <td>{row.label}</td>
                        {record.machine_entries.map((e) => (
                          <td key={e.machine_consumption_id}>
                            {editable && row.attrKey ? (
                              <input
                                type="text"
                                value={attrEdits[e.machine_consumption_id]?.[row.attrKey] ?? ""}
                                onChange={(ev) => setAttrEdit(e.machine_consumption_id, row.attrKey!, ev.target.value)}
                              />
                            ) : (
                              row.get(e) ?? "—"
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!isEdit && (
            <div className="detail-card">
              <h3>Machine Entries</h3>
              {record.machine_entries.length === 0 ? (
                <div className="hint-text">No machine entries linked yet.</div>
              ) : (
                record.machine_entries.map((entry, i) => (
                  <div key={entry.machine_consumption_id} className="detail-card" style={{ marginTop: i === 0 ? 0 : 14, background: "var(--ink-04, #f7f7f5)" }}>
                    <div className="section-label" style={{ marginTop: 0 }}>{entry.machine || `Machine #${i + 1}`}</div>
                    <div className="detail-grid">
                      <Kv label="Category" value={entry.category ? (CATEGORY_LABELS[entry.category] || entry.category) : "—"} />
                      <Kv label={T.sku} value={entry.sku_code} />
                      <Kv
                        label="Start – End Time"
                        value={entry.start_time ? `${formatTime12h(entry.start_time)}${entry.end_time ? ` – ${formatTime12h(entry.end_time)}` : " – …"}` : "—"}
                      />
                    </div>

                    <table className="qc-obs-table" style={{ marginTop: 10 }}>
                      <thead><tr><th>Pallet</th><th>{T.sku}</th><th style={{ width: 90 }}>Quantity</th></tr></thead>
                      <tbody>
                        {entry.pallets.length === 0 ? (
                          <tr><td colSpan={3} className="hint-text">No pallets recorded.</td></tr>
                        ) : (
                          entry.pallets.map((p) => (
                            <tr key={p.id}>
                              <td className="mono">{p.pallet_display_id}</td>
                              <td>{p.sku_code}</td>
                              <td>{p.quantity}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 8 }}>
                      <Link className="mono" href={`/material-consumption?open=${entry.material_consumption_id}`} style={{ textDecoration: "underline", fontSize: 12.5 }}>
                        View source RM Requisition record →
                      </Link>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Migration 0038: one column per selected machine, same pattern
              as Production Details below -- rows = REJECTION_FIELDS,
              columns = record.machine_entries. */}
          {record.machine_entries.length > 0 && (
            <div className="detail-card">
              <h3>Rejection Classification</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="qc-obs-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      {record.machine_entries.map((e, i) => <th key={e.machine_consumption_id}>{e.machine || `Machine #${i + 1}`}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {REJECTION_FIELDS.map((f) => (
                      <tr key={f.key}>
                        <td>{f.label}</td>
                        {record.machine_entries.map((e) => {
                          const attrKey = `rejection_${f.key}` as AttrKey;
                          return (
                            <td key={e.machine_consumption_id} style={{ width: 100 }}>
                              {editable ? (
                                <input
                                  type="number"
                                  min={0}
                                  value={attrEdits[e.machine_consumption_id]?.[attrKey] ?? ""}
                                  onChange={(ev) => setAttrEdit(e.machine_consumption_id, attrKey, ev.target.value)}
                                />
                              ) : (
                                e.rejection_classification[f.key] || 0
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="detail-card">
            <h3>Wastage</h3>
            {wastage.length === 0 && !editable ? (
              <div className="hint-text">No wastage recorded.</div>
            ) : (
              <table className="qc-obs-table">
                <thead><tr><th>Trays</th><th>Machine</th><th>Reason</th>{editable && <th></th>}</tr></thead>
                <tbody>
                  {wastage.map((w, i) => (
                    <tr key={i}>
                      <td style={{ width: 100 }}>
                        {editable ? (
                          <input
                            type="number"
                            min={0}
                            value={w.trays ?? ""}
                            onChange={(e) => updateWastageEntry(i, { trays: e.target.value === "" ? null : Number(e.target.value) })}
                          />
                        ) : (w.trays ?? "—")}
                      </td>
                      <td style={{ width: 160 }}>
                        {editable ? (
                          <select value={w.machine_id ?? ""} onChange={(e) => updateWastageEntry(i, { machine_id: e.target.value || null })}>
                            <option value="">Select…</option>
                            {machines.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
                          </select>
                        ) : (
                          record.wastage_entries[i]?.machine || (runMachines[0] ?? "—")
                        )}
                      </td>
                      <td>
                        {editable ? (
                          <input
                            type="text"
                            value={w.reason ?? ""}
                            onChange={(e) => updateWastageEntry(i, { reason: e.target.value })}
                          />
                        ) : (w.reason || "—")}
                      </td>
                      {editable && (
                        <td>
                          <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => removeWastageEntry(i)}>Remove</a>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {editable && (
              <button className="btn btn-secondary" onClick={addWastageEntry} style={{ marginTop: 6 }}>+ Add Wastage Entry</button>
            )}
          </div>

          {/* Migration 0039, task section 1 -- FG pallets actually produced,
              per machine, for this run's shift. This is Production's own
              count and the real source of truth for "how many pallets did
              we make" -- RQC then approves out of this pool (never more
              than what's recorded here), and only RQC-approved pallets ever
              reach FG QR Generation. See ProductionMachineEntry.
              pallets_produced / rqc_service.create_approval_entry. */}
          {record.machine_entries.length > 0 && (
            <div className="detail-card">
              <h3>Pallets Produced</h3>
              <div className="hint-text" style={{ marginBottom: 10 }}>
                Per machine, for this run&apos;s shift. RQC approves pallets out of this total --
                it can never approve more than what&apos;s recorded here.
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="qc-obs-table">
                  <thead>
                    <tr>
                      <th>Machine</th>
                      {record.machine_entries.map((e, i) => <th key={e.machine_consumption_id}>{e.machine || `Machine #${i + 1}`}</th>)}
                      <th style={{ width: 100 }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Pallets Produced</td>
                      {record.machine_entries.map((e) => (
                        <td key={e.machine_consumption_id} style={{ width: 110 }}>
                          {editable ? (
                            <input
                              type="number"
                              min={0}
                              value={attrEdits[e.machine_consumption_id]?.pallets_produced ?? ""}
                              onChange={(ev) => setAttrEdit(e.machine_consumption_id, "pallets_produced", ev.target.value)}
                            />
                          ) : (
                            e.pallets_produced || 0
                          )}
                        </td>
                      ))}
                      <td><strong>{totalPalletsProduced}</strong></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!isEdit && (
            <div className="detail-card">
              <h3>Downstream Records</h3>
              <div className="detail-grid">
                <Kv
                  label="IPQC"
                  value={record.ipqc_id ? (
                    <Link className="mono" href={`/ipqc?open=${record.ipqc_id}`} style={{ textDecoration: "underline" }}>
                      {record.ipqc_id.slice(0, 8)}… <span style={{ marginLeft: 6 }}><StatusBadge status={record.ipqc_status || "pending"} /></span> →
                    </Link>
                  ) : "Not yet created"}
                />
                <Kv
                  label="RQC"
                  value={record.rqc_id ? (
                    <Link className="mono" href={`/rqc?open=${record.rqc_id}`} style={{ textDecoration: "underline" }}>
                      {record.rqc_id.slice(0, 8)}… <span style={{ marginLeft: 6 }}><StatusBadge status={record.rqc_status || "pending"} /></span> →
                    </Link>
                  ) : "Not yet created"}
                />
                <Kv
                  label="FG QR Generation"
                  value={record.fg_qr_batches.length === 0 ? "Not yet created" : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {record.fg_qr_batches.map((b) => (
                        <Link key={b.id} className="mono" href={`/fg-qr-generation?open=${b.id}`} style={{ textDecoration: "underline" }}>
                          {b.batch_display_id} ({b.status}) →
                        </Link>
                      ))}
                    </div>
                  )}
                />
              </div>
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          {editable && (
            <button className="btn btn-primary" disabled={saving} onClick={() => setShowConsumptionConfirm(true)}>
              {saving ? "Saving…" : "Save"}
            </button>
          )}
          {!isEdit && canEdit && onEdit && (
            <button className="btn btn-primary" onClick={onEdit}>Edit</button>
          )}
        </div>
      </div>
      {showConsumptionConfirm && (
        <ConsumptionConfirmModal
          record={record}
          onCancel={() => setShowConsumptionConfirm(false)}
          onConfirm={() => { setShowConsumptionConfirm(false); handleSave(); }}
        />
      )}
    </>
  );
}
