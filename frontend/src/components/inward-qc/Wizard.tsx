"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { QcDetail, QcMeta, Permissions, SkuCode, QcManualCategory } from "@/lib/types";
import CoaField from "./CoaField";
import FgtrayObservations from "./FgtrayObservations";
import AttributeObservations from "./AttributeObservations";

const CATEGORY_LABELS: Record<string, string> = {
  fgtray: "FG Non-Padded Tray", pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};

function computeClientSamplingPlan(meta: QcMeta, category: string, qty: number | null) {
  if (!category || !qty || qty <= 0) return null;
  if (category === "fgtray") {
    return { sampleSize: "Full carton-box check", upperLimit: "0", note: null as string | null };
  }
  const tiers = meta.sampling_plan_tiers.filter((t) => t.category === category);
  if (!tiers.length) return null;
  const tier = tiers.find((t) => qty >= Number(t.min_qty) && (t.max_qty === null || qty <= Number(t.max_qty))) || tiers[tiers.length - 1];
  return { sampleSize: String(tier.sample_size), upperLimit: tier.upper_limit === null ? null : String(tier.upper_limit), note: tier.note };
}

export default function Wizard({
  qcId, initialDetail, meta, skuCodes, permissions, onClose, onSaved,
}: {
  qcId: string;
  initialDetail: QcDetail;
  meta: QcMeta;
  skuCodes: SkuCode[];
  permissions: Permissions;
  onClose: (deleted: boolean) => void;
  onSaved: () => void;
}) {
  const isTray = initialDetail.category === "fgtray";
  const [detail, setDetail] = useState<QcDetail>(initialDetail);
  const [step, setStep] = useState<2 | 3>(isTray ? 3 : 2);
  const [vendor, setVendor] = useState(initialDetail.vendor_name || "");
  const [quantity, setQuantity] = useState(initialDetail.quantity != null ? String(initialDetail.quantity) : "");
  const [skuCodeId, setSkuCodeId] = useState(initialDetail.sku_code_id || "");
  const [skuVersionId, setSkuVersionId] = useState(initialDetail.sku_version_id || "");
  const [conclusion, setConclusion] = useState(initialDetail.conclusion_or_suggestions || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canFillSection = permissions.can_fill_section || permissions.can_create || permissions.can_edit;
  const isFinalized = detail.status === "accepted" || detail.status === "onhold";
  const readOnlyBasic = isFinalized && !permissions.can_edit;

  const categorySkus = skuCodes.filter((s) => s.category === detail.category);
  const versionsForSku = categorySkus.find((s) => s.id === skuCodeId)?.versions || [];

  async function persistBasic(): Promise<QcDetail | null> {
    try {
      const updated = await api.updateQcBasic(qcId, {
        vendor_name: vendor, quantity: quantity ? Number(quantity) : null, sku_code_id: skuCodeId || null, sku_version_id: skuVersionId || null,
      });
      setDetail(updated);
      return updated;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      return null;
    }
  }

  useEffect(() => {
    if (!touched || isTray) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { persistBasic(); }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor, quantity, skuCodeId, skuVersionId, touched]);

  function markTouched<T>(setter: (v: T) => void) {
    return (v: T) => { setTouched(true); setter(v); };
  }

  async function handleFgtrayAnswer(criteriaId: string, answer: "ok" | "not_ok", remarks: string) {
    const optimistic = {
      ...detail,
      fgtray_answers: detail.fgtray_answers.map((a) => a.criteria_id === criteriaId ? { ...a, answer, remarks } : a),
    };
    setDetail(optimistic);
    try {
      const updated = await api.saveFgtrayAnswers(qcId, optimistic.fgtray_answers.map((a) => ({ criteria_id: a.criteria_id, answer: a.answer, remarks: a.remarks })));
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save observation");
    }
  }

  const attrSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleAttributeSave(nextValues: typeof detail.attribute_values, nextConclusion: string) {
    if (attrSaveTimer.current) clearTimeout(attrSaveTimer.current);
    attrSaveTimer.current = setTimeout(async () => {
      try {
        const updated = await api.saveQcAttributes(
          qcId,
          nextValues.map((v) => ({ attribute_definition_id: v.attribute_definition_id, value: v.value })),
          nextConclusion
        );
        setDetail(updated);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save observation");
      }
    }, 500);
  }

  function handleAttributeChange(attributeDefinitionId: string, value: string) {
    const next = detail.attribute_values.map((v) => v.attribute_definition_id === attributeDefinitionId ? { ...v, value } : v);
    setDetail({ ...detail, attribute_values: next });
    scheduleAttributeSave(next, conclusion);
  }

  function handleConclusionChange(value: string) {
    setConclusion(value);
    scheduleAttributeSave(detail.attribute_values, value);
  }

  // Completion / status preview mirroring the backend's exact rules, purely
  // to drive the Submit button and hint text — the backend re-validates.
  let complete = false;
  let hasNotOk = false;
  if (isTray) {
    complete = detail.fgtray_answers.length > 0 && detail.fgtray_answers.every((a) => a.answer === "ok" || a.answer === "not_ok");
    hasNotOk = detail.fgtray_answers.some((a) => a.answer === "not_ok");
  } else {
    const requiredFilled = detail.attribute_values.filter((v) => v.is_required).every((v) => v.value != null && v.value !== "");
    complete = requiredFilled && conclusion.trim() !== "";
  }

  const plan = computeClientSamplingPlan(meta, detail.category, quantity ? Number(quantity) : (detail.quantity ? Number(detail.quantity) : null));

  async function handleNext() {
    setSaving(true);
    const ok = await persistBasic();
    setSaving(false);
    if (ok) setStep(3);
  }

  async function handleSaveDraft() {
    setSaving(true);
    setError(null);
    try {
      if (!isTray) await persistBasic();
      const updated = await api.saveQcDraft(qcId);
      setDetail(updated);
      onSaved();
      onClose(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save draft");
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      if (!isTray) await persistBasic();
      const updated = await api.submitQc(qcId);
      setDetail(updated);
      onSaved();
      onClose(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to submit");
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    if (!touched && detail.status === "draft" && !isTray) {
      try { await api.discardQcIfBlank(qcId); } catch { /* best-effort */ }
    }
    onClose(false);
  }

  const conclusionLabel = !isTray ? meta.conclusion_labels[detail.category as QcManualCategory] : "";
  const countLabel = !isTray ? meta.count_labels[detail.category as QcManualCategory] : "";

  return (
    <>
      <div className="panel-overlay open" onClick={handleCancel} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{CATEGORY_LABELS[detail.category]} Inward QC</h2>
            <div className="sub">Shipment {detail.shipment_number || "(pending)"} · <span className={`badge ${detail.status}`}>{detail.status}</span></div>
          </div>
          <button className="sp-close" onClick={handleCancel}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          {isTray && (
            <div className="detail-card" style={{ marginBottom: 20 }}>
              <h3>Vehicle Inspection Information</h3>
              <div className="detail-grid">
                <div><div className="detail-kv-label">Shipment Number</div><div className="detail-kv-value">{detail.shipment_number}</div></div>
                <div><div className="detail-kv-label">Vendor</div><div className="detail-kv-value">{detail.vendor_name || "—"}</div></div>
                <div><div className="detail-kv-label">No. of Pallets</div><div className="detail-kv-value">{detail.quantity ?? "—"}</div></div>
              </div>
              {detail.line_item_snapshots.length > 0 && (
                <table className="qc-obs-table" style={{ marginTop: 14 }}>
                  <thead><tr><th>SKU Name</th><th>SKU Version</th><th>Quantity</th></tr></thead>
                  <tbody>
                    {detail.line_item_snapshots.map((li, i) => (
                      <tr key={i}><td>{li.sku_code || "—"}</td><td>{li.sku_version || "—"}</td><td>{li.quantity}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="hint-text">Populated from the approved Vehicle Inspection that created this record — no re-entry needed.</div>
            </div>
          )}

          {!isTray && step === 2 && (
            <div>
              <div className="form-grid" style={{ marginBottom: 18 }}>
                <div className="field">
                  <label>Shipment Number</label>
                  <div className="readonly-val">{detail.shipment_number}</div>
                </div>
                <div className="field"><label>Vendor</label>
                  <input disabled={readOnlyBasic} value={vendor} placeholder="e.g. 3P China" onChange={(e) => markTouched(setVendor)(e.target.value)} />
                </div>
                <div className="field"><label>{meta.quantity_labels[detail.category]}</label>
                  <input type="number" disabled={readOnlyBasic} value={quantity} placeholder="Enter quantity" onChange={(e) => markTouched(setQuantity)(e.target.value)} />
                </div>
              </div>
              <div className="form-grid" style={{ marginBottom: 18 }}>
                <div className="field"><label>SKU Name <span style={{ color: "var(--red)" }}>*</span></label>
                  <select disabled={readOnlyBasic} value={skuCodeId} onChange={(e) => { markTouched(setSkuCodeId)(e.target.value); setSkuVersionId(""); }}>
                    <option value="">Select</option>
                    {categorySkus.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                  </select>
                </div>
                <div className="field"><label>SKU Version <span style={{ color: "var(--red)" }}>*</span></label>
                  <select disabled={readOnlyBasic} value={skuVersionId} onChange={(e) => markTouched(setSkuVersionId)(e.target.value)}>
                    <option value="">Select</option>
                    {versionsForSku.map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
                  </select>
                </div>
              </div>
              <div className="hint-text" style={{ marginBottom: 18 }}>Sampling Size and Upper Limit for Acceptance will be shown on the QC Observations page, where the record is actually taken.</div>
              <CoaField qcId={qcId} filename={detail.coa_filename} url={detail.coa_url} disabled={readOnlyBasic} onChange={setDetail} />
            </div>
          )}

          {(step === 3 || isTray) && (
            <div>
              {plan && (
                <div className="plan-callout">
                  {isTray ? (
                    <>
                      <div className="pc-item"><div className="k">Sampling Approach</div><div className="v" style={{ fontSize: 13 }}>Fixed 3-point box check</div></div>
                      <div className="pc-item"><div className="k">Upper Limit for Acceptance</div><div className="v">0 failures</div></div>
                    </>
                  ) : (
                    <>
                      <div className="pc-item"><div className="k">Sampling Size</div><div className="v">{plan.sampleSize} samples</div></div>
                      <div className="pc-item"><div className="k">Upper Limit for Acceptance</div><div className="v">{plan.upperLimit === null ? "Not specified" : `${plan.upperLimit} defects`}</div></div>
                    </>
                  )}
                </div>
              )}
              <div className="hint-text" style={{ fontWeight: 700, marginBottom: 14, color: complete ? (hasNotOk ? "var(--red)" : "var(--green-deep)") : "var(--ink-50)" }}>
                {complete
                  ? (isTray ? (hasNotOk ? "One or more criteria are NOT OK — this record will be set to On Hold." : "All criteria OK — this record will be set to Accepted.") : "All required fields and conclusion complete — this record will be set to Accepted.")
                  : (isTray ? "Mark OK / NOT OK for every criterion to complete this inspection. Until then it stays Pending." : "Fill in every required field (marked *) and the conclusion to complete this inspection. Until then it stays Pending.")}
              </div>

              {isTray ? (
                <FgtrayObservations answers={detail.fgtray_answers} onChange={handleFgtrayAnswer} disabled={!canFillSection} />
              ) : (
                <>
                  {countLabel && <div className="hint-text" style={{ marginBottom: 10 }}>{countLabel}: {plan ? `${plan.sampleSize} samples (auto, from Sampling Plan)` : ""}</div>}
                  <AttributeObservations values={detail.attribute_values} coaFilename={detail.coa_filename} onChange={handleAttributeChange} disabled={!canFillSection} />
                  <div className="field" style={{ marginTop: 14 }}>
                    <label>{conclusionLabel}</label>
                    <textarea rows={2} disabled={!canFillSection} defaultValue={conclusion} onBlur={(e) => handleConclusionChange(e.target.value)} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
          <div className="sp-foot-right">
            {!isTray && step === 3 && <button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button>}
            {!isTray && <button className="btn btn-secondary" disabled={saving} onClick={handleSaveDraft}>Save Draft</button>}
            {!isTray && step === 2 && (
              <button className="btn btn-primary" disabled={saving || !skuCodeId || !skuVersionId || !quantity} onClick={handleNext}>Next →</button>
            )}
            {(isTray || step === 3) && (
              <button className="btn btn-primary" disabled={saving || !complete} onClick={handleSubmit}>Submit</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
