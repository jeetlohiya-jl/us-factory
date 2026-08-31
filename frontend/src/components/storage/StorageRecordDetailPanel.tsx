"use client";
import Link from "next/link";
import type { StorageRecordDetail } from "@/lib/types";
import { PALLET_STAGE_LABELS, PALLET_STAGE_BADGE_CLASS } from "@/lib/types";

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

/**
 * Opening an RM/FG Storage record later shows exactly what was recorded —
 * never a blank form — per the task's Record View / Record History
 * requirement.
 */
export default function StorageRecordDetailPanel({ record, onClose }: { record: StorageRecordDetail; onClose: () => void }) {
  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{record.storage_type === "rm" ? "RM" : "FG"} Storage Record</h2>
            <div className="sub">Pallet {record.pallet_display_id}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>General Information</h3>
            <div className="detail-grid">
              <Kv label="Storage Record ID" value={<span className="mono">{record.id}</span>} />
              <Kv label="Pallet ID" value={<span className="mono">{record.pallet_display_id}</span>} />
              <Kv label="Shipment Number" value={record.shipment_number} />
              <Kv label="SKU Name" value={record.sku_code} />
              <Kv label="SKU Version" value={record.sku_version} />
              <Kv label="Location" value={<span className="mono">{record.location_display_id}</span>} />
            </div>
          </div>
          <div className="detail-card">
            <h3>Source &amp; Traceability</h3>
            <div className="detail-grid">
              <Kv label={record.storage_type === "rm" ? "Source RM QR Generation Batch" : "Source FG QR Generation Batch"} value={<span className="mono">{record.source_batch_display_id}</span>} />
              {record.source_inward_qc_id && (
                <Kv
                  label="Source Inward QC"
                  value={
                    <Link className="mono" href={`/inward-qc?open=${record.source_inward_qc_id}`} style={{ textDecoration: "underline" }}>
                      View Inward QC record →
                    </Link>
                  }
                />
              )}
              {record.source_production_run_id && <Kv label="Source Production Run" value={<span className="mono">{record.source_production_run_id}</span>} />}
            </div>
          </div>
          <div className="detail-card">
            <h3>Storage Transaction</h3>
            <div className="detail-grid">
              <Kv label="Date / Time" value={new Date(record.stored_at).toLocaleString()} />
              <Kv label="Stored By" value={record.stored_by_name} />
              <Kv label="Current Pallet Status" value={<span className={`badge ${PALLET_STAGE_BADGE_CLASS[record.pallet_status]}`}>{PALLET_STAGE_LABELS[record.pallet_status]}</span>} />
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
