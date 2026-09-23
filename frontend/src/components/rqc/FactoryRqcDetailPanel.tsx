"use client";
import type { RqcDetail } from "@/lib/types";
import { RQC_DEFECT_GROUPS_QMP05, RQC_SAMPLING_PLAN } from "@/lib/types";

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

function ResultBadge({ found, reject }: { found: number | null; reject: number }) {
  if (found === null || Number.isNaN(found)) return <span className="result-badge pending">–</span>;
  const isNotOk = found >= reject;
  return (
    <span className={`result-badge ${isNotOk ? "notok" : "ok"}`}>
      {isNotOk ? "NOT OK" : "OK"}
      <span className="calc-tag">calc</span>
    </span>
  );
}

/**
 * Factory OS Module 4 -- read-only view of one already-saved RQC activity
 * record (a completed FactoryRqcWizard run). Everything here is
 * traceability/review, not editing -- this record's fields are only ever
 * written through the wizard's own Page 3 Save. "View FG QR" opens the
 * batch this record's own approval auto-generated (get_or_create_fg_qr_for_
 * rqc_record), via onViewFgQr -- the page owns fetching/showing that
 * separately (QrGenerationPanel) so this component stays a pure detail
 * view, same separation the US Factory RqcDetailPanel keeps.
 */
export default function FactoryRqcDetailPanel({
  record, onClose, machineCode, hasFgQr, onViewFgQr, onOpenCoa,
}: {
  record: RqcDetail;
  onClose: () => void;
  machineCode: string | null;
  hasFgQr: boolean;
  onViewFgQr: () => void;
  onOpenCoa: () => void;
}) {
  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>RQC Record</h2>
            <div className="sub mono">{record.shipment_number || record.id.slice(0, 8)}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>Product and Shipment Details</h3>
            <div className="detail-grid">
              <Kv label="Shipment Number" value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
              <Kv label="SKU Code" value={record.sku_code ? <span className="mono">{record.sku_code}</span> : "—"} />
              <Kv label="SKU Version" value={record.sku_version} />
              <Kv label="Manufacturer" value={record.manufacturer || "—"} />
              <Kv label="Status" value={<StatusBadge status={record.status} />} />
            </div>
          </div>

          <div className="detail-card">
            <h3>Approval</h3>
            <div className="detail-grid">
              <Kv label="Date" value={record.activity_date} />
              <Kv label="Machine" value={machineCode ? <span className="mono">{machineCode}</span> : "—"} />
              <Kv label="Shift" value={record.activity_shift} />
              <Kv label="Number of Pallets (Tested)" value={record.pallets_tested} />
              <Kv label="Approved Pallets" value={record.fg_pallets_generated} />
              <Kv label="RQC Table/Person Number" value={record.table_person_number} />
            </div>
          </div>

          <div className="detail-card">
            <h3>Sampling Plan (QMP05)</h3>
            <table className="qc-obs-table">
              <thead>
                <tr><th>Level</th><th style={{ width: 110 }}>Sample Size</th><th style={{ width: 90 }}>AQL</th><th style={{ width: 130 }}>Accept | Reject</th></tr>
              </thead>
              <tbody>
                {RQC_SAMPLING_PLAN.map((row) => (
                  <tr key={row.level}>
                    <td>{row.level}</td>
                    <td className="mono">{row.sampleSize}</td>
                    <td className="mono">{row.aql}</td>
                    <td className="mono">{row.acceptReject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="detail-card">
            <h3>RQC Inspection Records</h3>
            <div className="hint-text" style={{ marginBottom: 10, fontWeight: 700, color: "var(--ink-70)" }}>
              Sample Size: {RQC_DEFECT_GROUPS_QMP05[0].sampleSize}
            </div>
            <table className="qc-obs-table">
              <thead>
                <tr>
                  <th>Defect Type</th><th>Classification</th><th>Inspection Method</th>
                  <th style={{ width: 120 }}>Defects Found</th><th style={{ width: 120 }}>Result</th><th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {RQC_DEFECT_GROUPS_QMP05.flatMap((group) =>
                  group.items.map((item) => {
                    const defect = record.defect_results.find((d) => d.defect_sr === item.sr);
                    return (
                      <tr key={item.sr}>
                        <td>{item.type}</td>
                        <td><span className={`classification-badge ${group.badgeClass}`}>{group.classification}</span></td>
                        <td>Visual inspection</td>
                        <td>{defect?.found ?? "—"}</td>
                        <td><ResultBadge found={defect?.found ?? null} reject={group.reject} /></td>
                        <td>{defect?.remarks || "—"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            <div className="field" style={{ marginTop: 16, maxWidth: 320 }}>
              <label>Overall Result</label>
              <div className="detail-kv-value">{record.overall_result || "—"}</div>
            </div>
          </div>

          <div className="detail-card">
            <h3>Traceability</h3>
            <div className="detail-grid">
              <Kv
                label="Production Run"
                value={record.production_run_number ? (
                  <a className="mono" href={`/production?open=${record.production_run_id}`} style={{ textDecoration: "underline" }}>
                    {record.production_run_number} →
                  </a>
                ) : "—"}
              />
              <Kv
                label="FG QR"
                value={
                  hasFgQr ? (
                    <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={onViewFgQr}>View / Print →</a>
                  ) : record.status === "approved" ? "Generating…" : "—"
                }
              />
              <Kv
                label="Certificate of Analysis"
                value={<a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={onOpenCoa}>Open COA →</a>}
              />
            </div>
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
