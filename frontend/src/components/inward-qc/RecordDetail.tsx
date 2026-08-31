"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import type { QcDetail } from "@/lib/types";
import VehicleInspectionDetailContent from "@/components/inward-vehicle-inspection/VehicleInspectionDetailContent";

const CATEGORY_LABELS: Record<string, string> = {
  fgtray: "FG Non-Padded Tray", pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

export default function RecordDetail({ detail, onClose, onEdit, canEdit }: {
  detail: QcDetail; onClose: () => void; onEdit: () => void; canEdit: boolean;
}) {
  const isTray = detail.category === "fgtray";
  const [tab, setTab] = useState<"qc" | "vehicle">("qc");

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{CATEGORY_LABELS[detail.category]} Inward QC Record</h2>
            <div className="sub">Shipment {detail.shipment_number} · <span className={`badge ${detail.status}`}>{detail.status}</span></div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {isTray && (
            <div className="tab-bar">
              <button className={`tab-btn ${tab === "qc" ? "active" : ""}`} onClick={() => setTab("qc")}>QC Details</button>
              <button className={`tab-btn ${tab === "vehicle" ? "active" : ""}`} onClick={() => setTab("vehicle")}>Vehicle Inspection</button>
            </div>
          )}

          {tab === "qc" && (
            <>
              <div className="detail-card">
                <h3>Basic Information</h3>
                <div className="detail-grid">
                  <Kv label="Shipment Number" value={detail.shipment_number} />
                  <Kv label="Category" value={CATEGORY_LABELS[detail.category]} />
                  <Kv label="Status" value={<span className={`badge ${detail.status}`}>{detail.status}</span>} />
                  <Kv label="Vendor" value={detail.vendor_name} />
                  <Kv label={detail.quantity_label || "Quantity"} value={detail.quantity} />
                  <Kv label="QC Date" value={new Date(detail.created_at).toLocaleDateString()} />
                  <Kv label="Submitted" value={detail.submitted_at ? new Date(detail.submitted_at).toLocaleString() : "Not yet submitted"} />
                  <Kv label="Recorded By" value={detail.created_by_name} />
                  {!isTray && <Kv label="SKU Name" value={detail.sku_code} />}
                  {!isTray && <Kv label="SKU Version" value={detail.sku_version} />}
                </div>
              </div>

              {isTray && detail.line_item_snapshots.length > 0 && (
                <div className="detail-card">
                  <h3>SKU / Version / Quantity</h3>
                  <table className="qc-obs-table">
                    <thead><tr><th>SKU Name</th><th>SKU Version</th><th>Quantity</th></tr></thead>
                    <tbody>
                      {detail.line_item_snapshots.map((li, i) => (
                        <tr key={i}><td>{li.sku_code || "—"}</td><td>{li.sku_version || "—"}</td><td>{li.quantity}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="hint-text">Snapshotted from the source Vehicle Inspection at the time this QC record was created.</div>
                </div>
              )}

              <div className="detail-card">
                <h3>Sampling Plan</h3>
                <div className="detail-grid">
                  <Kv label="Sample Size" value={detail.sampling_sample_size} />
                  <Kv label="Upper Limit for Acceptance" value={detail.sampling_upper_limit === null ? (detail.sampling_sample_size ? "Not specified" : null) : (detail.sampling_upper_limit === "0" ? "0 failures" : detail.sampling_upper_limit ? `${detail.sampling_upper_limit} defects` : null)} />
                  {detail.sampling_note && <Kv label="Note" value={detail.sampling_note} />}
                </div>
              </div>

              <div className="detail-card">
                <h3>QC Observations</h3>
                {isTray ? (
                  detail.fgtray_answers.length === 0 ? <div className="hint-text">Not yet recorded.</div> : (
                    <table className="qc-obs-table">
                      <thead><tr><th>Sr.</th><th>Criteria</th><th>Observation</th><th>Remarks</th></tr></thead>
                      <tbody>
                        {detail.fgtray_answers.map((a, i) => (
                          <tr key={a.criteria_id}>
                            <td>{i + 1}</td><td>{a.label}</td>
                            <td>{a.answer ? <span className={`badge ${a.answer === "ok" ? "accepted" : "onhold"}`}>{a.answer === "ok" ? "OK" : "NOT OK"}</span> : <span className="badge draft">Unanswered</span>}</td>
                            <td>{a.remarks || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : (
                  detail.attribute_values.length === 0 ? <div className="hint-text">Not yet recorded.</div> : (
                    <>
                      <table className="qc-obs-table">
                        <thead><tr><th>Attribute</th><th>COA</th><th>Observation</th></tr></thead>
                        <tbody>
                          {detail.attribute_values.map((v) => (
                            <tr key={v.attribute_definition_id}>
                              <td>{v.label}{v.is_required && <span style={{ color: "var(--red)" }}> *</span>}</td>
                              <td className="mono" style={{ fontSize: 12 }}>{detail.coa_filename || "—"}</td>
                              <td>{v.value || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ marginTop: 14 }}><Kv label="Conclusion / Suggestions" value={detail.conclusion_or_suggestions} /></div>
                    </>
                  )
                )}
              </div>

              {!isTray && (
                <div className="detail-card">
                  <h3>Photos / Attachments</h3>
                  {detail.coa_filename ? (
                    <a href={detail.coa_url ? api.mediaUrl(detail.coa_url) : "#"} target="_blank" rel="noreferrer" className="btn-tertiary">{detail.coa_filename}</a>
                  ) : (
                    <div className="hint-text">No COA uploaded.</div>
                  )}
                </div>
              )}
            </>
          )}

          {tab === "vehicle" && detail.vehicle_inspection && (
            <VehicleInspectionDetailContent detail={detail.vehicle_inspection} />
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <div className="sp-foot-right">
            {tab === "qc" && canEdit && <button className="btn btn-primary" onClick={onEdit}>Edit</button>}
          </div>
        </div>
      </div>
    </>
  );
}
