"use client";
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { IpqcAttachment, PinholeTest } from "@/lib/types";
import AttachmentList from "../AttachmentList";
import { HistoryList, Kv, TestStatusBadge, formatDateTime } from "./shared";

type Row = { key: string; shot_number: string; avg_weight_g: string; trays_failed: string; remarks: string };

const str = (v: number | string | null) => (v === null || v === undefined ? "" : String(v));
let rowSeq = 0;
const newRow = (r?: Partial<Row>): Row => ({ key: `p${rowSeq++}`, shot_number: "", avg_weight_g: "", trays_failed: "", remarks: "", ...r });

// A row fails when Trays Quantity Failed is above 0. The sheet's "+/-1 g" is
// printed on the weight column; it does not say what the average is compared
// against, so it is shown as the column's tolerance but never decides a result.
function rowResult(trays: string): "pass" | "fail" | null {
  if (trays.trim() === "" || !Number.isFinite(Number(trays))) return null;
  return Number(trays) > 0 ? "fail" : "pass";
}

/**
 * Falcon IPQC -- Pinhole Test. Same linkage, interaction and audit rules as
 * the Burst Test panel. Columns follow the QC sheet: Lamination Machine Shot
 * No., Avg Weight of 10 Trays (g) +/-1 g, Trays Quantity Failed, Pinhole
 * Location / Remarks. The sheet image also has a partly hidden column to the
 * right (a dimensions-related one); it is intentionally NOT guessed here.
 */
export default function PinholeTestPanel({
  record, onClose, canFill, onSaved, mode, onEdit,
}: {
  record: PinholeTest;
  onClose: () => void;
  canFill: boolean;
  onSaved: () => void;
  mode: "view" | "edit";
  onEdit?: () => void;
}) {
  const [current, setCurrent] = useState<PinholeTest>(record);
  const [container, setContainer] = useState(record.container_number || "");
  const [remarks, setRemarks] = useState(record.remarks || "");
  const [rows, setRows] = useState<Row[]>(
    record.readings.length > 0
      ? record.readings.map((r) => newRow({ shot_number: str(r.shot_number), avg_weight_g: str(r.avg_weight_g), trays_failed: str(r.trays_failed), remarks: str(r.remarks) }))
      : [newRow()]
  );
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editable = mode === "edit" && canFill;
  const displayRows: Row[] = editable
    ? rows
    : current.readings.map((r) => ({ key: `v${r.sr}`, shot_number: str(r.shot_number), avg_weight_g: str(r.avg_weight_g), trays_failed: str(r.trays_failed), remarks: str(r.remarks) }));

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function handleSave(saveMode: "draft" | "final") {
    setSaving(saveMode);
    setError(null);
    try {
      await api.savePinholeTest(record.id, {
        save_mode: saveMode,
        container_number: container.trim() || null,
        remarks: remarks.trim() || null,
        readings: rows
          .filter((r) => r.shot_number.trim() || r.avg_weight_g.trim() || r.trays_failed.trim() || r.remarks.trim())
          .map((r) => ({ shot_number: r.shot_number, avg_weight_g: r.avg_weight_g, trays_failed: r.trays_failed, remarks: r.remarks })),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save test");
    } finally {
      setSaving(null);
    }
  }

  const setAttachments = (next: IpqcAttachment[]) => setCurrent((c) => ({ ...c, attachments: next }));

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open" style={{ width: 820, maxWidth: "100vw" }}>
        <div className="sp-head">
          <div>
            <h2>Pinhole Test</h2>
            <div className="sub mono">{current.run_number} · {current.machine_code} · Test #{current.test_number}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="detail-card">
            <h3>Linked Production Run</h3>
            <div className="detail-grid">
              <Kv label="Production Run" value={
                <Link className="mono" href={`/production?open=${current.production_run_id}`} style={{ textDecoration: "underline" }}>{current.run_number} →</Link>
              } />
              <Kv label="Lamination Machine" value={<span className="mono">{current.machine_code}</span>} />
              <Kv label="SKU" value={current.sku_code ? <span className="mono">{current.sku_code}</span> : "—"} />
              <Kv label="SKU Version" value={current.sku_version} />
              <Kv label="Shift" value={current.shift} />
              <Kv label="Production Date" value={current.production_date} />
              <Kv label="SKU weight (reference)" value={current.sku_weight} />
              <Kv label="Test No. for this run" value={`#${current.test_number}`} />
              <Kv label="Status" value={<TestStatusBadge status={current.status} />} />
            </div>
          </div>

          <div className="detail-card">
            <h3>Pinhole Test Readings</h3>
            <div className="field" style={{ maxWidth: 320, marginBottom: 14 }}>
              <label>Container Number</label>
              {editable ? (
                <input type="text" value={container} placeholder="optional" onChange={(e) => setContainer(e.target.value)} />
              ) : (
                <div className="detail-kv-value mono">{current.container_number || "—"}</div>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="qc-obs-table">
                <thead>
                  <tr>
                    <th style={{ width: 50 }}>Sr. No.</th>
                    <th>Lamination Machine Shot No.</th>
                    <th>Avg Weight of 10 Trays (g) ±1g</th>
                    <th>Trays Quantity Failed</th>
                    <th>Pinhole Location / Remarks</th>
                    <th style={{ width: 80 }}>Result</th>
                    {editable && <th style={{ width: 60 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((r, i) => {
                    const res = rowResult(r.trays_failed);
                    const needsRemark = res === "fail" && r.remarks.trim() === "";
                    return (
                      <tr key={r.key}>
                        <td>{i + 1}</td>
                        <td>{editable ? <input type="text" value={r.shot_number} onChange={(e) => setRow(i, { shot_number: e.target.value })} /> : (r.shot_number || "—")}</td>
                        <td>{editable ? <input type="number" min={0} step="any" value={r.avg_weight_g} onChange={(e) => setRow(i, { avg_weight_g: e.target.value })} /> : (r.avg_weight_g || "—")}</td>
                        <td>{editable ? <input type="number" min={0} step={1} value={r.trays_failed} onChange={(e) => setRow(i, { trays_failed: e.target.value })} /> : (r.trays_failed || "—")}</td>
                        <td>
                          {editable ? (
                            <input
                              type="text" value={r.remarks}
                              placeholder={res === "fail" ? "Required — where is the pinhole?" : ""}
                              style={needsRemark ? { borderColor: "var(--red)" } : undefined}
                              onChange={(e) => setRow(i, { remarks: e.target.value })}
                            />
                          ) : (r.remarks || "—")}
                        </td>
                        <td>
                          {res === "pass" && <span className="result-badge ok">OK</span>}
                          {res === "fail" && <span className="result-badge notok">FAIL</span>}
                          {res === null && <span className="result-badge pending">–</span>}
                        </td>
                        {editable && (
                          <td><button type="button" className="btn-tertiary" disabled={rows.length === 1} onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button></td>
                        )}
                      </tr>
                    );
                  })}
                  {!editable && current.readings.length === 0 && <tr className="empty-row"><td colSpan={6}>No readings recorded yet.</td></tr>}
                </tbody>
              </table>
            </div>
            {editable && <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setRows((prev) => [...prev, newRow()])}>+ Add Reading</button>}
            <div className="hint-text" style={{ marginTop: 8 }}>
              A row fails when Trays Quantity Failed is above 0, and then needs its Pinhole Location / Remarks.
              The ±1 g tolerance is printed on the sheet but its reference weight is not specified, so it is not used to pass or fail a row.
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label>Other Remarks</label>
              {editable ? (
                <textarea rows={2} value={remarks} placeholder="No remarks" onChange={(e) => setRemarks(e.target.value)} />
              ) : (
                <div className="detail-kv-value">{current.remarks || "No remarks"}</div>
              )}
            </div>
          </div>

          <div className="detail-card">
            <h3>Attachments</h3>
            <AttachmentList
              attachments={current.attachments}
              canEdit={editable}
              upload={(f) => api.uploadIpqcTestAttachment("pinhole", record.id, f)}
              remove={(id) => api.deleteIpqcTestAttachment("pinhole", record.id, id)}
              onChange={setAttachments}
              emptyHint="No attachments. Add test photos, scans or reports (images, PDF, DOCX)."
            />
          </div>

          <div className="detail-card">
            <h3>Record Details</h3>
            <div className="detail-grid">
              <Kv label="Tested At" value={formatDateTime(current.tested_at)} />
              <Kv label="Recorded By" value={current.recorded_by_name} />
              <Kv label="Last Saved" value={formatDateTime(current.updated_at)} />
              <Kv label="Last Saved By" value={current.updated_by_name} />
            </div>
            <div className="hint-text" style={{ margin: "8px 0" }}>The time and the person are recorded automatically from the server and your login.</div>
            <HistoryList events={current.events} />
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>{editable ? "Cancel" : "Close"}</button>
          {editable && (
            <div className="sp-foot-right">
              <button className="btn btn-secondary" disabled={saving !== null} onClick={() => handleSave("draft")}>{saving === "draft" ? "Saving…" : "Save Draft"}</button>
              <button className="btn btn-primary" disabled={saving !== null} onClick={() => handleSave("final")}>{saving === "final" ? "Saving…" : "Save"}</button>
            </div>
          )}
          {mode === "view" && canFill && onEdit && <button className="btn btn-primary" onClick={onEdit}>Edit</button>}
        </div>
      </div>
    </>
  );
}
