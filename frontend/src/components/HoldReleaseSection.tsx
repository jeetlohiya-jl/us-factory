"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { HoldReleaseModule, HoldReleaseRecord } from "@/lib/types";

const DISPOSITIONS = ["Release", "Rework", "Reject"];

function StatusBadge({ status }: { status: string }) {
  const cls = status === "completed" ? "approved" : "draft";
  return <span className={`badge ${cls}`}>{status === "completed" ? "Completed" : "Draft"}</span>;
}

/**
 * Hold & Release form -- shown at the TOP of a record's detail view
 * whenever that record's status is 'hold' (Inward Vehicle Inspection,
 * Inward QC, IPQC, RQC, Outward Vehicle Inspection), with the record's own
 * original details rendered below it, unchanged (spec point 12). The
 * find-or-create row (api.getOrCreateHoldRelease) is fetched on mount --
 * idempotent, backed by a DB unique constraint (module, record_id), so
 * opening the same Hold record repeatedly never creates duplicates.
 *
 * Same two-step wizard convention already used elsewhere in this app
 * (OviPanel's Step 1/Step 2): Step 1 is Hold Details, Step 2 is Decision
 * Details, Cancel/Save Draft/Next on step 1 and Cancel/Back/Save Draft/
 * Save on step 2 -- reusing the same field/form-grid/button CSS classes,
 * no new visual design.
 */
export default function HoldReleaseSection({
  module, recordId, canFill,
}: {
  module: HoldReleaseModule;
  recordId: string;
  canFill: boolean;
}) {
  const [record, setRecord] = useState<HoldReleaseRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [collapsed, setCollapsed] = useState(false);

  const [dateOfHold, setDateOfHold] = useState("");
  const [productName, setProductName] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [pointOfDetection, setPointOfDetection] = useState("");
  const [qtyOfHold, setQtyOfHold] = useState("");
  const [reasonForHold, setReasonForHold] = useState("");
  const [recordFilledBy, setRecordFilledBy] = useState("");
  const [dateOfDecision, setDateOfDecision] = useState("");
  const [disposition, setDisposition] = useState("");
  const [reasonOfDisposition, setReasonOfDisposition] = useState("");
  const [qtyDecided, setQtyDecided] = useState("");
  const [doneBy, setDoneBy] = useState("");
  const [approvedBy, setApprovedBy] = useState("");
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function applyRecord(rec: HoldReleaseRecord) {
    setRecord(rec);
    setDateOfHold(rec.date_of_hold || "");
    setProductName(rec.product_name || "");
    setBatchCode(rec.batch_code || "");
    setPointOfDetection(rec.point_of_detection || "");
    setQtyOfHold(rec.qty_of_hold || "");
    setReasonForHold(rec.reason_for_hold || "");
    setRecordFilledBy(rec.record_filled_by || "");
    setDateOfDecision(rec.date_of_decision || "");
    setDisposition(rec.disposition || "");
    setReasonOfDisposition(rec.reason_of_disposition || "");
    setQtyDecided(rec.qty_decided || "");
    setDoneBy(rec.done_by || "");
    setApprovedBy(rec.approved_by || "");
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api.getOrCreateHoldRelease(module, recordId)
      .then((rec) => { if (!cancelled) applyRecord(rec); })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : "Failed to load Hold & Release form"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module, recordId]);

  const editable = canFill;

  async function handleSave(mode: "draft" | "final") {
    if (!record) return;
    setSaving(mode);
    setError(null);
    try {
      const saved = await api.saveHoldRelease(record.id, {
        date_of_hold: dateOfHold || null,
        product_name: productName || null,
        batch_code: batchCode || null,
        point_of_detection: pointOfDetection || null,
        qty_of_hold: qtyOfHold || null,
        reason_for_hold: reasonForHold || null,
        record_filled_by: recordFilledBy || null,
        date_of_decision: dateOfDecision || null,
        disposition: disposition || null,
        reason_of_disposition: reasonOfDisposition || null,
        qty_decided: qtyDecided || null,
        done_by: doneBy || null,
        approved_by: approvedBy || null,
        status: mode === "draft" ? "draft" : "completed",
      });
      applyRecord(saved);
      if (mode === "final") setCollapsed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Hold & Release form");
    } finally {
      setSaving(null);
    }
  }

  function handleCancel() {
    // This row already exists (find-or-create on open) -- Cancel here just
    // discards any unsaved edits by reverting local state to the last
    // saved values, same as reopening the record would show. It does not
    // delete the row: this is not the "creating a new record" flow (there
    // is no "+ New Record" for Hold & Release; it is always attached to an
    // existing Hold record), so there is nothing to discard beyond the
    // in-progress edit.
    if (record) applyRecord(record);
    setStep(1);
    setError(null);
  }

  if (loading) {
    return (
      <div className="detail-card">
        <h3>Hold &amp; Release</h3>
        <div className="hint-text">Loading…</div>
      </div>
    );
  }

  if (loadError || !record) {
    return (
      <div className="detail-card">
        <h3>Hold &amp; Release</h3>
        <div className="error-banner">{loadError || "Could not load the Hold & Release form."}</div>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="detail-card">
        <div className="sp-head" style={{ padding: 0, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Hold &amp; Release</h3>
          <StatusBadge status={record.status} />
        </div>
        <div className="hint-text">
          Disposition: {record.disposition || "—"} — completed by {record.approved_by || "—"}.{" "}
          {editable && <a onClick={() => setCollapsed(false)} style={{ cursor: "pointer", textDecoration: "underline" }}>Edit</a>}
        </div>
      </div>
    );
  }

  return (
    <div className="detail-card">
      <div className="sp-head" style={{ padding: 0, marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>Hold &amp; Release</h3>
        <StatusBadge status={record.status} />
      </div>

      {error && <div className="error-banner">{error}</div>}

      {step === 1 && (
        <div>
          <div className="section-label">Hold Details</div>
          <div className="form-grid">
            <div className="field"><label>Date of Hold</label><input type="date" value={dateOfHold} disabled={!editable} onChange={(e) => setDateOfHold(e.target.value)} /></div>
            <div className="field"><label>Product Name</label><input type="text" value={productName} disabled={!editable} onChange={(e) => setProductName(e.target.value)} /></div>
            <div className="field"><label>Batch Code</label><input type="text" value={batchCode} disabled={!editable} onChange={(e) => setBatchCode(e.target.value)} /></div>
            <div className="field"><label>Point of Detection</label><input type="text" value={pointOfDetection} disabled={!editable} onChange={(e) => setPointOfDetection(e.target.value)} /></div>
            <div className="field"><label>Qty of Hold</label><input type="text" value={qtyOfHold} disabled={!editable} onChange={(e) => setQtyOfHold(e.target.value)} /></div>
            <div className="field"><label>Record Filled By</label><input type="text" value={recordFilledBy} disabled={!editable} onChange={(e) => setRecordFilledBy(e.target.value)} /></div>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Reason for Hold</label>
            <textarea rows={2} value={reasonForHold} disabled={!editable} onChange={(e) => setReasonForHold(e.target.value)} />
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div className="section-label">Decision Details</div>
          <div className="form-grid">
            <div className="field"><label>Date of Decision</label><input type="date" value={dateOfDecision} disabled={!editable} onChange={(e) => setDateOfDecision(e.target.value)} /></div>
            <div className="field">
              <label>Disposition</label>
              <select value={disposition} disabled={!editable} onChange={(e) => setDisposition(e.target.value)}>
                <option value="">Select…</option>
                {DISPOSITIONS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="field"><label>Qty Decided</label><input type="text" value={qtyDecided} disabled={!editable} onChange={(e) => setQtyDecided(e.target.value)} /></div>
            <div className="field"><label>Done By</label><input type="text" value={doneBy} disabled={!editable} onChange={(e) => setDoneBy(e.target.value)} /></div>
            <div className="field"><label>Approved By</label><input type="text" value={approvedBy} disabled={!editable} onChange={(e) => setApprovedBy(e.target.value)} /></div>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Reason of Disposition</label>
            <textarea rows={2} value={reasonOfDisposition} disabled={!editable} onChange={(e) => setReasonOfDisposition(e.target.value)} />
          </div>
        </div>
      )}

      {editable && (
        <div className="sp-foot" style={{ padding: "14px 0 0", border: 0 }}>
          <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
          <div className="sp-foot-right">
            {step === 2 && <button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button>}
            <button className="btn btn-secondary" disabled={saving !== null} onClick={() => handleSave("draft")}>{saving === "draft" ? "Saving…" : "Save Draft"}</button>
            {step === 1 && <button className="btn btn-primary" onClick={() => setStep(2)}>Next →</button>}
            {step === 2 && <button className="btn btn-primary" disabled={saving !== null} onClick={() => handleSave("final")}>{saving === "final" ? "Saving…" : "Save"}</button>}
          </div>
        </div>
      )}
    </div>
  );
}
