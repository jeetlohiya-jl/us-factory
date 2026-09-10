"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import type { OviDetail, OviAnswer, OviImage } from "@/lib/types";
import { OVI_QUESTIONS, OVI_IMAGE_TYPES } from "@/lib/types";
import HoldReleaseSection from "@/components/HoldReleaseSection";
import OviImageField from "./OviImageField";

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
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`badge ${cls}`}>{label}</span>;
}

/**
 * Outward Vehicle Inspection detail/fill-in panel -- two modes, same
 * convention as RqcDetailPanel (auto-created records with no "New Record"
 * flow to fold this into):
 * - "edit": the prototype's exact two-step side panel (Step 1 fields,
 *   Step 2 the 7-question checklist + Remarks), Cancel/Save Draft/Next on
 *   step 1 and Cancel/Back/Save Draft/Save on step 2.
 * - "view": full read-only record, offered once status is Hold or
 *   Approved (a Pending/Draft record has nothing finished to review).
 *
 * Shipment Number and Customer Name are always read-only -- locked-in
 * snapshots from Customer Shipment (spec: never re-ask for information the
 * system already knows). Quantity stays editable (matches the prototype's
 * own plain-text Quantity field; it's the best figure available at
 * Customer-Shipment-creation time, before Shipment Picking has run).
 */
export default function OviPanel({
  record, onClose, canFill, onSaved, mode,
}: {
  record: OviDetail;
  onClose: () => void;
  canFill: boolean;
  onSaved: () => void;
  mode: "view" | "edit";
}) {
  const [step, setStep] = useState(1);
  const [quantity, setQuantity] = useState(record.quantity || "");
  const [truck, setTruck] = useState(record.truck_number || "");
  const [invoice, setInvoice] = useState(record.invoice_number || "");
  const [transporter, setTransporter] = useState(record.transporter_name || "");
  const [seal, setSeal] = useState(record.seal_number || "");
  const [remarks, setRemarks] = useState(record.remarks || "");
  const [answers, setAnswers] = useState<Record<number, "ok" | "not_ok" | null>>(
    Object.fromEntries(OVI_QUESTIONS.map((q) => [q.sr, record.answers.find((a) => a.question_sr === q.sr)?.answer ?? null]))
  );
  const [images, setImages] = useState<OviImage[]>(record.images);
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imageOf = (type: string) => images.find((i) => i.image_type === type);

  const editable = mode === "edit" && canFill;
  const hasNotOk = Object.values(answers).some((a) => a === "not_ok");
  const allAnswered = OVI_QUESTIONS.every((q) => answers[q.sr] === "ok" || answers[q.sr] === "not_ok");

  function setAnswer(sr: number, val: "ok" | "not_ok") {
    setAnswers((prev) => ({ ...prev, [sr]: val }));
  }

  async function handleSave(saveMode: "draft" | "final") {
    setSaving(saveMode);
    setError(null);
    try {
      const payload: OviAnswer[] = OVI_QUESTIONS.map((q) => ({ question_sr: q.sr, answer: answers[q.sr] ?? null }));
      await api.saveOvi(record.id, {
        truck_number: truck || null,
        invoice_number: invoice || null,
        transporter_name: transporter || null,
        seal_number: seal || null,
        quantity: quantity || null,
        remarks: remarks || null,
        save_mode: saveMode,
        answers: payload,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save record");
    } finally {
      setSaving(null);
    }
  }

  if (mode === "view") {
    return (
      <>
        <div className="panel-overlay open" onClick={onClose} />
        <div className="side-panel open">
          <div className="sp-head">
            <div><h2>Outward Vehicle Inspection</h2><div className="sub mono">{record.shipment_number || record.id.slice(0, 8)}</div></div>
            <button className="sp-close" onClick={onClose}>×</button>
          </div>
          <div className="sp-body">
            {record.status === "hold" && (
              <HoldReleaseSection module="outward_vehicle_inspection" recordId={record.id} canFill={canFill} />
            )}
            <div className="detail-card">
              <h3>Shipment Details</h3>
              <div className="detail-grid">
                <Kv label="Shipment Number" value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
                <Kv label="Quantity" value={record.quantity} />
                <Kv label="Customer Name" value={record.customer_name} />
                <Kv label="Truck / Vehicle Number" value={record.truck_number} />
                <Kv label="Invoice No." value={record.invoice_number} />
                <Kv label="Name of Transporter" value={record.transporter_name} />
                <Kv label="Seal No." value={record.seal_number} />
                <Kv label="Status" value={<StatusBadge status={record.status} />} />
              </div>
            </div>
            <div className="detail-card">
              <h3>Vehicle Conditions</h3>
              <table className="qc-obs-table">
                <thead><tr><th>Condition</th><th>Answer</th></tr></thead>
                <tbody>
                  {OVI_QUESTIONS.map((q) => {
                    const a = record.answers.find((x) => x.question_sr === q.sr)?.answer;
                    return (
                      <tr key={q.sr}>
                        <td>{q.label}</td>
                        <td>{a === "ok" ? <span className="result-badge ok">OK</span> : a === "not_ok" ? <span className="result-badge notok">NOT OK</span> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="detail-card">
              <h3>Loading Photos</h3>
              {images.length === 0 ? (
                <div className="hint-text">No photos uploaded.</div>
              ) : (
                <div className="img-thumb-row">
                  {OVI_IMAGE_TYPES.filter((t) => imageOf(t.key)).map((t) => {
                    const img = imageOf(t.key)!;
                    return (
                      <div key={img.id}>
                        <div className="img-thumb" style={{ marginBottom: 6 }}>
                          {img.public_url && (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={api.mediaUrl(img.public_url)} alt={t.label} />
                          )}
                        </div>
                        <div className="hint-text" style={{ margin: 0, maxWidth: 92 }}>{t.label}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="detail-card">
              <h3>Remarks</h3>
              <div className="detail-kv-value">{record.remarks || "No remarks"}</div>
            </div>
          </div>
          <div className="sp-foot">
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>Outward Vehicle Inspection</h2><div className="sub mono">{record.shipment_number || record.id.slice(0, 8)}</div></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {record.status === "hold" && (
            <HoldReleaseSection module="outward_vehicle_inspection" recordId={record.id} canFill={canFill} />
          )}
          {error && <div className="error-banner">{error}</div>}

          {step === 1 && (
            <div>
              <div className="form-grid" style={{ marginBottom: 18 }}>
                <div className="field">
                  <label>Shipment Number <span style={{ color: "var(--red)" }}>*</span></label>
                  <div className="readonly-val">{record.shipment_number || "—"}</div>
                </div>
                <div className="field">
                  <label>Quantity <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="text" placeholder="e.g. 44 pallets" value={quantity} disabled={!editable} onChange={(e) => setQuantity(e.target.value)} />
                </div>
              </div>
              <div className="form-grid">
                <div className="field"><label>Truck / Vehicle Number</label><input type="text" placeholder="e.g. TRK-88213" value={truck} disabled={!editable} onChange={(e) => setTruck(e.target.value)} /></div>
                <div className="field"><label>Customer Name</label><div className="readonly-val">{record.customer_name || "—"}</div></div>
                <div className="field"><label>Invoice No.</label><input type="text" placeholder="e.g. INV-88213" value={invoice} disabled={!editable} onChange={(e) => setInvoice(e.target.value)} /></div>
                <div className="field"><label>Name of Transporter</label><input type="text" placeholder="e.g. ABC Logistics" value={transporter} disabled={!editable} onChange={(e) => setTransporter(e.target.value)} /></div>
                <div className="field"><label>Seal No.</label><input type="text" placeholder="e.g. SL-44210" value={seal} disabled={!editable} onChange={(e) => setSeal(e.target.value)} /></div>
              </div>

              <div className="section-label">Loading Photos</div>
              <div className="form-grid">
                {OVI_IMAGE_TYPES.map((t) => (
                  <OviImageField
                    key={t.key}
                    recordId={record.id}
                    imageType={t.key}
                    label={t.label}
                    image={imageOf(t.key)}
                    disabled={!editable}
                    onChange={setImages}
                  />
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="section-label">Vehicle conditions to be inspected for:</div>
              {allAnswered && (
                <div className="hint-text" style={{ fontWeight: 700, marginBottom: 14, color: hasNotOk ? "var(--red)" : "var(--green-deep)" }}>
                  {hasNotOk ? "One or more conditions are NOT OK — this record will be set to Hold." : "All conditions OK — this record will be set to Approved."}
                </div>
              )}
              <table className="ynq-table">
                <tbody>
                  {OVI_QUESTIONS.map((q) => (
                    <tr key={q.sr}>
                      <td className="q-label">{q.label}</td>
                      <td>
                        <div className="toggle2">
                          <button className={`sel-ok ${answers[q.sr] === "ok" ? "on" : ""}`} disabled={!editable} onClick={() => setAnswer(q.sr, "ok")}>OK</button>
                          <button className={`sel-notok ${answers[q.sr] === "not_ok" ? "on" : ""}`} disabled={!editable} onClick={() => setAnswer(q.sr, "not_ok")}>NOT OK</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="field" style={{ marginTop: 16 }}>
                <label>Other Remarks (if any)</label>
                <textarea rows={2} placeholder="No remarks" value={remarks} disabled={!editable} onChange={(e) => setRemarks(e.target.value)} />
              </div>
            </div>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <div className="sp-foot-right">
            {step === 2 && <button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button>}
            {editable && <button className="btn btn-secondary" disabled={saving !== null} onClick={() => handleSave("draft")}>{saving === "draft" ? "Saving…" : "Save Draft"}</button>}
            {step === 1 && <button className="btn btn-primary" onClick={() => setStep(2)}>Next →</button>}
            {step === 2 && editable && <button className="btn btn-primary" disabled={saving !== null} onClick={() => handleSave("final")}>{saving === "final" ? "Saving…" : "Save"}</button>}
          </div>
        </div>
      </div>
    </>
  );
}
