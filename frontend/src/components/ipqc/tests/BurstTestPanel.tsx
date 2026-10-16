"use client";
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { BurstTest, IpqcAttachment } from "@/lib/types";
import { BURST_THRESHOLD_INHG } from "@/lib/types";
import AttachmentList from "../AttachmentList";
import { HistoryList, Kv, TestStatusBadge, formatDateTime } from "./shared";

type Row = { key: string; sealing_temp_c: string; sealing_time_s: string; burst_inhg: string };

const str = (v: number | string | null) => (v === null || v === undefined ? "" : String(v));
let rowSeq = 0;
const newRow = (r?: Partial<Row>): Row => ({ key: `r${rowSeq++}`, sealing_temp_c: "", sealing_time_s: "", burst_inhg: "", ...r });

// The sheet: "Acceptable: more than 16 inHg" / "Fail: less than 16 inHg".
// Exactly 16 is not defined there, so it is never shown as OK or FAIL.
function classify(v: string): "pass" | "fail" | "undetermined" | null {
  if (v.trim() === "" || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  return n > BURST_THRESHOLD_INHG ? "pass" : n < BURST_THRESHOLD_INHG ? "fail" : "undetermined";
}
function ResultCell({ result }: { result: "pass" | "fail" | "undetermined" | null }) {
  if (result === "pass") return <span className="result-badge ok">Acceptable</span>;
  if (result === "fail") return <span className="result-badge notok">Fail</span>;
  if (result === "undetermined") return <span className="result-badge pending" title="Exactly 16 inHg is not defined on the QC sheet">Not defined</span>;
  return <span className="result-badge pending">–</span>;
}

/**
 * Falcon IPQC -- Burst Test (sheet: "Burst Test Container wise Record Sheet").
 * Same interaction as Outward Vehicle Inspection: opens in "edit" (fill in)
 * or "view", Save Draft / Save, status decided by the server. Production
 * Run, machine, SKU, Version and Shift come from the run and are read-only;
 * who recorded the test and when are stamped by the server.
 */
export default function BurstTestPanel({
  record, onClose, canFill, onSaved, mode, onEdit,
}: {
  record: BurstTest;
  onClose: () => void;
  canFill: boolean;
  onSaved: () => void;
  mode: "view" | "edit";
  onEdit?: () => void;
}) {
  const [current, setCurrent] = useState<BurstTest>(record);
  const [container, setContainer] = useState(record.container_number || "");
  const [remarks, setRemarks] = useState(record.remarks || "");
  const [rows, setRows] = useState<Row[]>(
    record.readings.length > 0
      ? record.readings.map((r) => newRow({ sealing_temp_c: str(r.sealing_temp_c), sealing_time_s: str(r.sealing_time_s), burst_inhg: str(r.burst_inhg) }))
      : [newRow()]
  );
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editable = mode === "edit" && canFill;
  const results = rows.map((r) => classify(r.burst_inhg));
  const anyFail = results.includes("fail");
  const anyUndetermined = results.includes("undetermined");

  const displayRows: Row[] = editable
    ? rows
    : current.readings.map((r) => ({ key: `v${r.sr}`, sealing_temp_c: str(r.sealing_temp_c), sealing_time_s: str(r.sealing_time_s), burst_inhg: str(r.burst_inhg) }));

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function handleSave(saveMode: "draft" | "final") {
    setSaving(saveMode);
    setError(null);
    try {
      await api.saveBurstTest(record.id, {
        save_mode: saveMode,
        container_number: container.trim() || null,
        remarks: remarks.trim() || null,
        // Rows with nothing typed are dropped, so an unused blank row never blocks a Save.
        readings: rows
          .filter((r) => r.sealing_temp_c.trim() || r.sealing_time_s.trim() || r.burst_inhg.trim())
          .map((r) => ({ sealing_temp_c: r.sealing_temp_c, sealing_time_s: r.sealing_time_s, burst_inhg: r.burst_inhg })),
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
  // Attachment add/remove is recorded in the history by the server; refresh just the history lazily on next open.

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open" style={{ width: 760, maxWidth: "100vw" }}>
        <div className="sp-head">
          <div>
            <h2>Burst Test</h2>
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
              <Kv label="Test No. for this run" value={`#${current.test_number}`} />
              <Kv label="Status" value={<TestStatusBadge status={current.status} />} />
            </div>
          </div>

          <div className="detail-card">
            <h3>Burst Test — Container-wise Record</h3>
            <div className="field" style={{ maxWidth: 320, marginBottom: 14 }}>
              <label>Container Number <span style={{ color: "var(--red)" }}>*</span></label>
              {editable ? (
                <input type="text" value={container} placeholder="e.g. MSKU1234567" onChange={(e) => setContainer(e.target.value)} />
              ) : (
                <div className="detail-kv-value mono">{current.container_number || "—"}</div>
              )}
            </div>
            <div className="hint-text" style={{ marginBottom: 8 }}>
              Acceptable: more than {BURST_THRESHOLD_INHG} inHg · Fail: less than {BURST_THRESHOLD_INHG} inHg.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="qc-obs-table">
                <thead>
                  <tr>
                    <th style={{ width: 50 }}>Sr. No.</th>
                    <th>Sealing Temp (°C)</th>
                    <th>Sealing Time (Sec)</th>
                    <th>Burst Test Result (inHg)</th>
                    <th style={{ width: 120 }}>Result</th>
                    {editable && <th style={{ width: 60 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((r, i) => (
                    <tr key={r.key}>
                      <td>{i + 1}</td>
                      {(["sealing_temp_c", "sealing_time_s", "burst_inhg"] as const).map((f) => (
                        <td key={f}>
                          {editable ? (
                            <input type="number" min={0} step="any" value={r[f]} onChange={(e) => setRow(i, { [f]: e.target.value } as Partial<Row>)} />
                          ) : (r[f] || "—")}
                        </td>
                      ))}
                      <td><ResultCell result={classify(r.burst_inhg)} /></td>
                      {editable && (
                        <td>
                          <button type="button" className="btn-tertiary" disabled={rows.length === 1} onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {!editable && current.readings.length === 0 && (
                    <tr className="empty-row"><td colSpan={5}>No readings recorded yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {editable && (
              <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setRows((prev) => [...prev, newRow()])}>+ Add Reading</button>
            )}
            {editable && anyUndetermined && (
              <div className="hint-text" style={{ color: "var(--amber)", fontWeight: 700, marginTop: 10 }}>
                A reading of exactly {BURST_THRESHOLD_INHG} inHg is not defined as acceptable or failed on the QC sheet. Confirm the rule with QA or re-test; it can be saved as a draft but not as final.
              </div>
            )}
            <div className="field" style={{ marginTop: 14 }}>
              <label>Remarks{anyFail ? <span style={{ color: "var(--red)" }}> * required — a reading failed</span> : ""}</label>
              {editable ? (
                <textarea rows={2} value={remarks} placeholder={anyFail ? "Describe the failure" : "No remarks"} onChange={(e) => setRemarks(e.target.value)} />
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
              upload={(f) => api.uploadIpqcTestAttachment("burst", record.id, f)}
              remove={(id) => api.deleteIpqcTestAttachment("burst", record.id, id)}
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
