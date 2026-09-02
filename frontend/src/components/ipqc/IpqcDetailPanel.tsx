"use client";
import { useState } from "react";
import Link from "next/link";
import type { IpqcDetail, IpqcBlockDefect } from "@/lib/types";
import { IPQC_DEFECTS } from "@/lib/types";
import { nowHHMM, formatTime12h } from "@/components/material-consumption/Wizard";
import { api } from "@/lib/api";

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "approved" ? "approved" : status === "hold" ? "hold" : status === "pending" ? "pending" : "draft";
  return <span className={`badge ${cls}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

// Result badge: computed from Failure, never stored -- 0 = OK, >=1 = NOT
// OK, matching ipqcRecalcResult exactly.
function ResultBadge({ failure }: { failure: number | null }) {
  if (failure === null || Number.isNaN(failure)) return <span className="result-badge pending">–</span>;
  const isNotOk = failure >= 1;
  return (
    <span className={`result-badge ${isNotOk ? "notok" : "ok"}`}>
      {isNotOk ? "NOT OK" : "OK"}
      <span className="calc-tag">calc</span>
    </span>
  );
}

type EditableBlock = { key: string; check_time: string | null; overall_result: string | null; defects: Record<number, IpqcBlockDefect> };

function blocksToEditable(blocks: IpqcDetail["check_blocks"]): EditableBlock[] {
  return blocks.map((b, i) => ({
    key: `existing-${b.id}-${i}`,
    check_time: b.check_time,
    overall_result: b.overall_result,
    defects: Object.fromEntries(b.defects.map((d) => [d.defect_sr, d])),
  }));
}

/**
 * IPQC detail view -- read-only Product/Shipment Details and traceability
 * (Production Run + Material Consumption links), plus editable Shift
 * Incharge and Check Time inspection blocks, matching the prototype's
 * panel-ipqc form exactly (IPQC_DEFECTS grid, Failure -> computed Result,
 * free-text Reason and Overall Result per block, "+ Add Another Record").
 * Saving posts the atomic write to FastAPI (backend/app/api/ipqc.py's PUT
 * route).
 */
export default function IpqcDetailPanel({
  record, onClose, canEdit, onSaved,
}: {
  record: IpqcDetail;
  onClose: () => void;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [shiftIncharge, setShiftIncharge] = useState(record.shift_incharge || "");
  const [blocks, setBlocks] = useState<EditableBlock[]>(blocksToEditable(record.check_blocks));
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function addBlock() {
    setBlocks((b) => [...b, { key: `new-${Date.now()}`, check_time: nowHHMM(), overall_result: "", defects: {} }]);
  }
  function setFailure(blockIdx: number, sr: number, value: string) {
    setBlocks((prev) => prev.map((b, i) => {
      if (i !== blockIdx) return b;
      const failure = value === "" ? null : Number(value);
      return { ...b, defects: { ...b.defects, [sr]: { defect_sr: sr, failure, reason: b.defects[sr]?.reason ?? null } } };
    }));
  }
  function setReason(blockIdx: number, sr: number, value: string) {
    setBlocks((prev) => prev.map((b, i) => {
      if (i !== blockIdx) return b;
      return { ...b, defects: { ...b.defects, [sr]: { defect_sr: sr, failure: b.defects[sr]?.failure ?? null, reason: value } } };
    }));
  }
  function setOverall(blockIdx: number, value: string) {
    setBlocks((prev) => prev.map((b, i) => (i === blockIdx ? { ...b, overall_result: value } : b)));
  }

  async function handleSave(mode: "draft" | "final") {
    setSaving(mode);
    setError(null);
    try {
      await api.saveIpqc(record.id, {
        shift_incharge: shiftIncharge || null,
        save_mode: mode,
        blocks: blocks.map((b) => ({
          check_time: b.check_time, overall_result: b.overall_result,
          defects: IPQC_DEFECTS.map((d) => b.defects[d.sr]).filter((d): d is IpqcBlockDefect => !!d && (d.failure !== null || !!d.reason)),
        })),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save record");
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>IPQC Record</h2>
            <div className="sub mono">{record.shipment_number || record.id.slice(0, 8)}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>Product and Shipment Details</h3>
            <div className="detail-grid">
              <Kv label="Shipment Number" value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
              <Kv label="Batch Code" value={record.batch_code} />
              <Kv label="Manufacturer Name" value={record.manufacturer} />
              <Kv label="Shift" value={record.shift} />
              <Kv label="Pad Color" value={record.pad_color} />
              <Kv label="Weight of Pad with Base Material" value={record.weight} />
              <Kv label="Dimensions of Pad" value={record.dimensions} />
              <Kv label="Absorption Rate" value={record.absorption_rate} />
            </div>
          </div>

          <div className="plan-callout">
            <div className="pc-item"><div className="k">Frequency</div><div className="v">Every 2 hours</div></div>
            <div className="pc-item"><div className="k">No. of Samples Tested</div><div className="v">5 samples</div></div>
          </div>

          <div className="detail-card">
            <h3>Record Details</h3>
            <div className="detail-grid">
              <Kv label="SKU Code" value={record.sku_code ? <span className="mono">{record.sku_code}</span> : "—"} />
              <Kv label="SKU Version" value={record.sku_version} />
              <Kv label="Shift Incharge" value={
                canEdit ? (
                  <input type="text" value={shiftIncharge} placeholder="e.g. R. Fernandez" onChange={(e) => setShiftIncharge(e.target.value)} />
                ) : (record.shift_incharge || "—")
              } />
              <Kv label="Status" value={<StatusBadge status={record.status} />} />
              <Kv label="Date" value={record.date} />
            </div>
          </div>

          <div className="detail-card">
            <h3>IPQC Records</h3>
            {blocks.length === 0 ? (
              <div className="hint-text">No inspection blocks recorded yet.</div>
            ) : (
              blocks.map((block, bIdx) => (
                <div key={block.key} className="card card-flush" style={{ marginBottom: 16 }}>
                  <div style={{ padding: "12px 16px", fontWeight: 700, fontSize: 13, borderBottom: "1px solid var(--rule)" }}>
                    Check Time: {block.check_time ? formatTime12h(block.check_time) : "—"}
                  </div>
                  <div style={{ padding: "14px 16px" }}>
                    <div className="hint-text" style={{ marginBottom: 10, fontWeight: 700, color: "var(--ink-70)" }}>
                      Sample Size: {IPQC_DEFECTS[0].sampleSize}
                    </div>
                    <table className="qc-obs-table">
                      <thead>
                        <tr>
                          <th>Defect Type</th><th>Classification</th><th>Inspection Method</th>
                          <th style={{ width: 110 }}>Result</th><th style={{ width: 100 }}>Failure</th><th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {IPQC_DEFECTS.map((d) => {
                          const defect = block.defects[d.sr];
                          return (
                            <tr key={d.sr}>
                              <td>{d.type}</td>
                              <td><span className={`classification-badge ${d.badgeClass}`}>{d.classification}</span></td>
                              <td>{d.method}</td>
                              <td><ResultBadge failure={defect?.failure ?? null} /></td>
                              <td>
                                {canEdit ? (
                                  <input
                                    type="number" placeholder="0"
                                    value={defect?.failure ?? ""}
                                    onChange={(e) => setFailure(bIdx, d.sr, e.target.value)}
                                  />
                                ) : (defect?.failure ?? "—")}
                              </td>
                              <td>
                                {canEdit ? (
                                  <input
                                    type="text" placeholder="Not applicable"
                                    value={defect?.reason ?? ""}
                                    onChange={(e) => setReason(bIdx, d.sr, e.target.value)}
                                  />
                                ) : (defect?.reason || "—")}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="field" style={{ marginTop: 14, maxWidth: 320 }}>
                      <label>Overall Result</label>
                      {canEdit ? (
                        <input type="text" value={block.overall_result ?? ""} onChange={(e) => setOverall(bIdx, e.target.value)} />
                      ) : (
                        <div className="detail-kv-value">{block.overall_result || "—"}</div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
            {canEdit && (
              <button className="btn btn-secondary" onClick={addBlock} style={{ marginTop: 6 }}>+ Add Another Record</button>
            )}
          </div>

          <div className="detail-card">
            <h3>Production &amp; Material Consumption Source</h3>
            <div className="detail-grid">
              <Kv
                label="Production Run"
                value={record.production_run_number ? (
                  <Link className="mono" href={`/production?open=${record.production_run_id}`} style={{ textDecoration: "underline" }}>
                    {record.production_run_number} →
                  </Link>
                ) : "—"}
              />
              <Kv
                label="Material Consumption"
                value={record.material_consumptions.length === 0 ? "—" : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {record.material_consumptions.map((mc) => (
                      <Link key={mc.id} className="mono" href={`/material-consumption?open=${mc.id}`} style={{ textDecoration: "underline" }}>
                        {mc.id.slice(0, 8)}… ({mc.status}) →
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
          {canEdit && (
            <div className="sp-foot-right">
              <button className="btn btn-secondary" disabled={saving !== null} onClick={() => handleSave("draft")}>
                {saving === "draft" ? "Saving…" : "Save Draft"}
              </button>
              <button className="btn btn-primary" disabled={saving !== null} onClick={() => handleSave("final")}>
                {saving === "final" ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
