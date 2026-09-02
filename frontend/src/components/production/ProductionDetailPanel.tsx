"use client";
import Link from "next/link";
import type { ProductionDetail } from "@/lib/types";
import { formatTime12h } from "@/components/material-consumption/Wizard";

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
  const cls = status === "approved" ? "approved" : status === "hold" ? "hold" : "pending";
  return <span className={`badge ${cls}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

/**
 * Read-only -- Production Runs are exclusively auto-created by Material
 * Consumption's finalize() (see find_or_create_production_run), so there
 * is no "New Record"/edit flow here, only a complete recorded-data view:
 * one section per machine, dynamically matching however many machines the
 * linked Material Consumption record(s) actually ran, each showing that
 * machine's own linked Category/SKU/pallets/times.
 */
export default function ProductionDetailPanel({ record, onClose }: { record: ProductionDetail; onClose: () => void }) {
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
              <Kv label="Total PCS/Pallet" value="—" />
              <Kv label="Rejections" value="—" />
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
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
