"use client";
import type { CustomerShipmentDetail } from "@/lib/types";

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

function SpStatusBadge({ status }: { status: string }) {
  const cls = status === "complete" ? "approved" : status === "partial" ? "partial" : "pending";
  const label = status === "complete" ? "Complete" : status === "partial" ? "Partial" : "Pending";
  return <span className={`badge ${cls}`}>{label}</span>;
}

/**
 * Read-only detail / traceability panel -- Customer Shipment is create-once
 * (spec point 6: no Edit action, no fake edit flow), so there is no edit
 * mode here at all, unlike RqcDetailPanel/IpqcDetailPanel. Shows the line
 * items as saved plus the Shipment Picking requests they fanned out into
 * (spec point 22: traceable to Shipment Picking and eventually the actual
 * picked FG pallets).
 */
export default function CustomerShipmentDetailPanel({
  detail, onClose,
}: {
  detail: CustomerShipmentDetail;
  onClose: () => void;
}) {
  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>Customer Shipment</h2>
            <div className="sub mono">{detail.shipment_number}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>Shipment Details</h3>
            <div className="detail-grid">
              <Kv label="Shipment Number" value={<span className="mono">{detail.shipment_number}</span>} />
              <Kv label="Container Number" value={<span className="mono">{detail.container_number}</span>} />
              <Kv label="Customer / Recipient" value={detail.customer} />
              <Kv label="Date" value={new Date(detail.created_at).toLocaleDateString()} />
            </div>
          </div>

          <div className="detail-card">
            <h3>Line Items</h3>
            <table className="qc-obs-table">
              <thead><tr><th>SKU Code</th><th>SKU Version</th><th>No. of Pallets</th></tr></thead>
              <tbody>
                {detail.line_items.map((li) => (
                  <tr key={li.id}>
                    <td className="mono">{li.sku_code || "—"}</td>
                    <td>{li.sku_version || "—"}</td>
                    <td>{li.pallets_required}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="detail-card">
            <h3>Shipment Picking Requests</h3>
            <table className="qc-obs-table">
              <thead><tr><th>SKU Code</th><th>SKU Version</th><th>Qty Required</th><th>Qty Picked</th><th>Status</th></tr></thead>
              <tbody>
                {detail.picking_requests.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.sku_code || "—"}</td>
                    <td>{r.sku_version || "—"}</td>
                    <td>{r.pallets_required}</td>
                    <td>{r.pallets_picked}</td>
                    <td><SpStatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
