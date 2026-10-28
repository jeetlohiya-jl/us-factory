"use client";
import type { ShiftRecordDetail } from "@/lib/types";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import LabelImageButtons from "@/components/LabelImageButtons";

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 3 });

export default function ShiftRecordDetailPanel({ record, canDelete, canGenerate, onClose, onDelete, onGenerate, generating, generateError }: {
  record: ShiftRecordDetail; canDelete: boolean; canGenerate: boolean; onClose: () => void; onDelete: () => void;
  onGenerate: () => void; generating: boolean; generateError: string | null;
}) {
  const generated = !!record.fg_generated_at;
  const [carry, setCarry] = useState(0);
  useEffect(() => {
    setCarry(0);
    if (!generated && record.fg_sku_code_id) api.getShiftRecordCarryIn(record.fg_sku_code_id, record.id).then(setCarry).catch(() => {});
  }, [generated, record.fg_sku_code_id, record.id]);
  const per = record.total_pcs_per_pallet || 0;
  const pool = record.trays_produced + carry;
  const willMake = per > 0 ? Math.floor(pool / per) : 0;
  const labels = () => record.pallets.map((p) => ({ payload: p.qr_payload || JSON.stringify({ t: "fg_pallet", id: p.display_id }), text: p.display_id }));
  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open" style={{ width: "min(720px, 100vw)" }}>
        <div className="sp-head">
          <div><h2>{record.display_id}</h2><div className="hint-text">{record.shift} · {record.machine || "—"} · {record.record_date}</div></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>Recorded</h3>
            <div className="form-grid">
              <div className="field"><label>By</label><div className="readonly-val">{record.recorded_by || "—"}</div></div>
              <div className="field"><label>At</label><div className="readonly-val">{new Date(record.recorded_at).toLocaleString()}</div></div>
              {record.notes && <div className="field" style={{ gridColumn: "1 / -1" }}><label>Notes</label><div className="readonly-val">{record.notes}</div></div>}
            </div>
          </div>
          <div className="detail-card">
            <h3>Materials Used</h3>
            <table className="data compact">
              <thead><tr><th>SKU</th><th>RM Pallet</th><th>Used</th><th>Off Inventory</th></tr></thead>
              <tbody>
                {record.material_lines.map((m) => (
                  <tr key={m.id}>
                    <td>{m.sku_code || "—"}</td>
                    <td className="mono">{m.pallet_display_id || "—"}{!m.fully_consumed ? " (part)" : ""}</td>
                    <td>{fmt(m.quantity)} {m.unit}</td>
                    <td>{m.inventory_quantity != null ? fmt(m.inventory_quantity) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="detail-card">
            <h3>Produced &amp; Scrap</h3>
            <div className="form-grid">
              <div className="field"><label>FG SKU</label><div className="readonly-val">{record.fg_sku_code || "—"}</div></div>
              <div className="field"><label>Trays Produced</label><div className="readonly-val">{fmt(record.trays_produced)}</div></div>
              <div className="field"><label>Trays per Pallet</label><div className="readonly-val">{record.total_pcs_per_pallet ?? "—"}</div></div>
              <div className="field"><label>Pallets Produced</label><div className="readonly-val">{generated ? record.fg_pallets : "Not generated yet"}</div></div>
              <div className="field"><label>Loose Trays</label><div className="readonly-val">{generated ? fmt(record.loose_trays) : "—"}</div></div>
              {generated && record.loose_carried_in > 0 && (
                <div className="field"><label>Loose Trays Carried In</label><div className="readonly-val">{fmt(record.loose_carried_in)}</div></div>
              )}
              <div className="field"><label>Scrap Trays</label><div className="readonly-val">{fmt(record.scrap_trays)}{record.scrap_reason ? ` — ${record.scrap_reason}` : ""}</div></div>
            </div>
            {record.pallets.length > 0 && (
              <table className="data compact" style={{ marginTop: 10 }}>
                <thead><tr><th>FG Pallet</th><th>Trays</th><th>Status</th></tr></thead>
                <tbody>
                  {record.pallets.map((p) => (
                    <tr key={p.id}><td className="mono">{p.display_id}</td><td>{p.trays ?? "—"}</td><td>{p.lifecycle_status}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {!generated && record.fg_sku_code_id && (
              <div className="hint-text" style={{ marginTop: 10 }}>
                FG QRs are made at the end of the record. {carry > 0 ? `${fmt(carry)} loose trays from earlier shifts will be added: ${fmt(record.trays_produced)} + ${fmt(carry)} = ${fmt(pool)} trays → ` : ""}
                {per > 0 ? `${willMake} full pallet${willMake === 1 ? "" : "s"} of ${per} trays, ${fmt(pool - willMake * per)} loose trays left over for the next shift.` : "Trays per Pallet is not set."}
              </div>
            )}
            {generateError && <div className="error-banner" style={{ marginTop: 8 }}>{generateError}</div>}
            {record.qr_batch && <div className="hint-text" style={{ marginTop: 6 }}>QR batch {record.qr_batch} — print the labels, then put the pallets away in FG Storage.</div>}
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <div className="sp-foot-right">
            {!generated && record.fg_sku_code_id && canGenerate && (
              <button className="btn btn-primary" disabled={generating} onClick={onGenerate}>{generating ? "Generating…" : "Generate FG QRs"}</button>
            )}
            {canDelete && <button className="btn btn-ghost" style={{ color: "var(--red)" }} onClick={onDelete}>Delete</button>}
            {record.pallets.length > 0 && <LabelImageButtons labels={labels} source={record.qr_batch || record.display_id} />}
          </div>
        </div>
      </div>
    </>
  );
}
