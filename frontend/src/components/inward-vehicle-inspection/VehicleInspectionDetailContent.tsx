"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import type { InspectionDetail } from "@/lib/types";
import Lightbox from "./Lightbox";

const IMAGE_TYPE_LABELS: Record<string, string> = {
  container: "Container Photo", truck: "Truck Number Photo", seal: "Seal Photo",
  condition: "Physical Condition on First Opening", damage: "Damage Picture", empty_container: "Empty Container Photo",
};

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

/**
 * The read-only content of a Vehicle Inspection record — used both by the
 * Vehicle Inspection module's own Record Details panel and, embedded, by the
 * Inward QC module's "Vehicle Inspection" tab for Tray/FG Non-Padded Tray QC
 * records (see inward-qc/RecordDetail.tsx). Always fetched from the real
 * linked record via the API — never duplicated/copied into QC's own data.
 */
export default function VehicleInspectionDetailContent({ detail }: { detail: InspectionDetail }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  return (
    <>
      <div className="detail-card">
        <h3>Basic Information</h3>
        <div className="detail-grid">
          <Kv label="Shipment Number" value={detail.shipment_number} />
          <Kv label="Material Category" value={detail.category} />
          <Kv label="Status" value={<span className={`badge ${detail.status}`}>{detail.status}</span>} />
          <Kv label="Total Quantity" value={detail.total_quantity} />
          <Kv label="Vendor Name" value={detail.vendor_name} />
          <Kv label="Invoice No." value={detail.invoice_number} />
          <Kv label="Name of Transporter" value={detail.transporter_name} />
          <Kv label="Created" value={new Date(detail.created_at).toLocaleString()} />
          <Kv label="Last Updated" value={new Date(detail.updated_at).toLocaleString()} />
        </div>
      </div>

      <div className="detail-card">
        <h3>SKU / Version / Quantity</h3>
        {detail.line_items.length === 0 ? (
          <div className="hint-text">No SKU entries recorded.</div>
        ) : (
          <table className="qc-obs-table">
            <thead><tr><th>SKU Code</th><th>SKU Version</th><th>Quantity</th></tr></thead>
            <tbody>
              {detail.line_items.map((li) => (
                <tr key={li.id}><td>{li.sku_code || "—"}</td><td>{li.sku_version || "—"}</td><td>{li.quantity}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="detail-card">
        <h3>Vehicle / Container Information</h3>
        <div className="detail-grid">
          <Kv label="Truck / Vehicle Number" value={detail.truck_number} />
          <Kv label="Container Number" value={detail.container_number} />
          <Kv label="Seal No." value={detail.seal_number} />
        </div>
      </div>

      <div className="detail-card">
        <h3>Inspection Checklist</h3>
        {detail.checklist_answers.length === 0 ? (
          <div className="hint-text">Checklist not started.</div>
        ) : (
          detail.checklist_answers.map((a) => (
            <div className="detail-checklist-row" key={a.checklist_item_id}>
              <span>{a.label}</span>
              {a.answer ? (
                <span className={`badge ${a.answer === "ok" ? "approved" : "hold"}`}>{a.answer === "ok" ? "OK" : "NOT OK"}</span>
              ) : (
                <span className="badge draft">Unanswered</span>
              )}
            </div>
          ))
        )}
        {detail.status === "approved" && (
          <div style={{ marginTop: 14 }}>
            <Kv label="Inspection Passed Quantity" value={detail.inspection_passed_quantity} />
          </div>
        )}
      </div>

      <div className="detail-card">
        <h3>Photos / Attachments</h3>
        {detail.images.length === 0 ? (
          <div className="hint-text">No photos uploaded.</div>
        ) : (
          <div className="img-thumb-row">
            {detail.images.map((img) => (
              <div key={img.id}>
                <div className="img-thumb" style={{ marginBottom: 6 }}>
                  {img.public_url && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={api.mediaUrl(img.public_url)} alt={IMAGE_TYPE_LABELS[img.image_type]} onClick={() => setLightboxSrc(api.mediaUrl(img.public_url!))} />
                  )}
                </div>
                <div className="hint-text" style={{ margin: 0, maxWidth: 92 }}>{IMAGE_TYPE_LABELS[img.image_type]}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="detail-card">
        <h3>Remarks / Other Information</h3>
        <Kv label="Other Remarks" value={detail.remarks || "No remarks"} />
        {detail.linked_qc_id && (
          <div style={{ marginTop: 14 }}>
            <Kv label="Linked Inward QC" value={`Auto-created (${detail.linked_qc_id.slice(0, 8)}…)`} />
          </div>
        )}
      </div>

      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
