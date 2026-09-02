"use client";
import { useState } from "react";
import Link from "next/link";
import type { ProductionDetail, Machine } from "@/lib/types";
import { formatTime12h } from "@/components/material-consumption/Wizard";
import { api } from "@/lib/api";

const CATEGORY_LABELS: Record<string, string> = { tray: "Base Tray", fgtray: "FG Non-Padded Tray" };

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
  record, onClose, canEdit, machines, onSaved,
}: {
  record: ProductionDetail;
  onClose: () => void;
  canEdit: boolean;
  machines: Machine[];
  onSaved: () => void;
}) {
  const [rc, setRc] = useState(record.rejection_classification);
  const [totalFgPallets, setTotalFgPallets] = useState<number | "">(record.total_fg_pallets || "");
  const [wastage, setWastage] = useState<EditableWastage[]>(
    record.wastage_entries.map((w) => ({ machine_id: w.machine_id, trays: w.trays, reason: w.reason }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editable = canEdit;
  const totalPcsPerPallet = sumProductionDetails(record.machine_entries, "prod_total_pcs_per_pallet");
  const totalRejections = sumRejections(rc);

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
        rejection_damage: rc.damage,
        rejection_misplaced_glue: rc.misplaced_glue,
        rejection_misplaced_pad: rc.misplaced_pad,
        rejection_glue_on_pad: rc.glue_on_pad,
        rejection_pad_placement_direction: rc.pad_placement_direction,
        rejection_adhesion_issue: rc.adhesion_issue,
        total_fg_pallets: totalFgPallets === "" ? 0 : Number(totalFgPallets),
        wastage_entries: wastage.map((w) => ({ machine_id: w.machine_id, trays: w.trays, reason: w.reason })),
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
          <div className="detail-card">
            <h3>General Information</h3>
            <div className="detail-grid">
              <Kv label="Production Run ID" value={<span className="mono">{record.run_number}</span>} />
              <Kv label="Shipment Number" value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
              <Kv label="SKU Code(s)" value={record.sku_codes || "—"} />
              <Kv label="Date" value={record.date} />
              <Kv label="Shift" value={record.shift} />
              <Kv label="Operator" value={record.operator} />
              <Kv label="Status" value={<StatusBadge status={record.status} />} />
              <Kv label="Total PCS/Pallet" value={totalPcsPerPallet ?? "—"} />
              <Kv label="Total Rejections" value={totalRejections} />
              <Kv label="FG Pallets Generated" value={record.total_fg_pallets || "—"} />
            </div>
          </div>

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
                    <Kv label="SKU Name" value={entry.sku_code} />
                    <Kv label="SKU Version" value={entry.sku_version} />
                    <Kv
                      label="Start – End Time"
                      value={entry.start_time ? `${formatTime12h(entry.start_time)}${entry.end_time ? ` – ${formatTime12h(entry.end_time)}` : " – …"}` : "—"}
                    />
                  </div>

                  {entry.production_details && (
                    <>
                      <div className="section-label">Production Details</div>
                      <div className="detail-grid">
                        <Kv label="Weight" value={entry.production_details.prod_weight} />
                        <Kv label="Pcs/Sleeve" value={entry.production_details.prod_pcs_per_sleeve} />
                        <Kv label="Sleeve/Case" value={entry.production_details.prod_sleeve_per_case} />
                        <Kv label="Total No. of Pcs/Pallet" value={entry.production_details.prod_total_pcs_per_pallet} />
                        <Kv label="Total No. of Pallets" value={entry.production_details.prod_total_pallets} />
                        <Kv label="Target Shots" value={entry.production_details.prod_target_shots} />
                        <Kv label="Pad Type" value={entry.production_details.prod_pad_type} />
                        <Kv label="Pad Color" value={entry.production_details.prod_pad_color} />
                        <Kv label="Case Type" value={entry.production_details.prod_case_type} />
                      </div>
                    </>
                  )}

                  <table className="qc-obs-table" style={{ marginTop: 10 }}>
                    <thead><tr><th>Pallet</th><th>SKU Name</th><th>SKU Version</th><th style={{ width: 90 }}>Quantity</th></tr></thead>
                    <tbody>
                      {entry.pallets.length === 0 ? (
                        <tr><td colSpan={4} className="hint-text">No pallets recorded.</td></tr>
                      ) : (
                        entry.pallets.map((p) => (
                          <tr key={p.id}>
                            <td className="mono">{p.pallet_display_id}</td>
                            <td>{p.sku_code}</td>
                            <td>{p.sku_version}</td>
                            <td>{p.quantity}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 8 }}>
                    <Link className="mono" href={`/material-consumption?open=${entry.material_consumption_id}`} style={{ textDecoration: "underline", fontSize: 12.5 }}>
                      View source Material Consumption record →
                    </Link>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="detail-card">
            <h3>Rejection Classification</h3>
            <table className="qc-obs-table">
              <tbody>
                {REJECTION_FIELDS.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td style={{ width: 140 }}>
                      {editable ? (
                        <input
                          type="number"
                          min={0}
                          value={rc[f.key] === 0 ? "" : rc[f.key]}
                          onChange={(e) => setRc((prev) => ({ ...prev, [f.key]: e.target.value === "" ? 0 : Number(e.target.value) }))}
                        />
                      ) : (
                        rc[f.key] || 0
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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

          <div className="detail-card">
            <h3>FG Pallets</h3>
            <div className="field">
              <label>Total Number of FG Pallets Generated</label>
              {editable ? (
                <input
                  type="number"
                  min={0}
                  value={totalFgPallets}
                  onChange={(e) => setTotalFgPallets(e.target.value === "" ? "" : Number(e.target.value))}
                />
              ) : (
                <div className="detail-kv-value">{record.total_fg_pallets || "—"}</div>
              )}
            </div>
          </div>

          <div className="detail-card">
            <h3>Downstream Records</h3>
            <div className="detail-grid">
              <Kv
                label="IPQC"
                value={record.ipqc_id ? (
                  <span className="mono">{record.ipqc_id.slice(0, 8)}… <span style={{ marginLeft: 6 }}><StatusBadge status={record.ipqc_status || "pending"} /></span></span>
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

          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          {editable && (
            <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
