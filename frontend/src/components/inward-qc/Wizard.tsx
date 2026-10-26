"use client";
import { skuMatchesCategory } from "@/lib/types";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { QcDetail, QcMeta, Permissions, SkuCode, QuantityUnit } from "@/lib/types";
import { QUANTITY_UNITS, TRAY_FAMILY_QC_CATEGORIES, QC_CATEGORY_LABELS } from "@/lib/types";
import CoaField from "./CoaField";
import FgtrayObservations from "./FgtrayObservations";
import AttributeObservations from "./AttributeObservations";
import ReportObservations from "./ReportObservations";
import { T, statusLabel } from "@/lib/terms";

const CATEGORY_LABELS = QC_CATEGORY_LABELS;
// Forms built from the India inward QC reports (migration 0084).
const INDIA_FORM_KEYS = ["rm_tray", "in_pad", "in_polybag", "in_cfb", "film", "corner_protector"];

function computeClientSamplingPlan(meta: QcMeta, category: string, qty: number | null) {
  if (!category || !qty || qty <= 0) return null;
  if (TRAY_FAMILY_QC_CATEGORIES.includes(category)) {
    return { sampleSize: "Full carton-box check", upperLimit: "0", note: null as string | null };
  }
  const tiers = meta.sampling_plan_tiers.filter((t) => t.category === category);
  if (!tiers.length) return null;
  const tier = tiers.find((t) => qty >= Number(t.min_qty) && (t.max_qty === null || qty <= Number(t.max_qty))) || tiers[tiers.length - 1];
  return { sampleSize: String(tier.sample_size), upperLimit: tier.upper_limit === null ? null : String(tier.upper_limit), note: tier.note };
}

export default function Wizard({
  qcId, initialDetail, meta, skuCodes, permissions, onClose, onSaved, onSubmitted, isNew = false,
}: {
  qcId: string;
  initialDetail: QcDetail;
  meta: QcMeta;
  skuCodes: SkuCode[];
  permissions: Permissions;
  onClose: (deleted: boolean) => void;
  onSaved: () => void;
  // Called with the saved record right after Submit succeeds (before onClose),
  // so the page can go straight on to QR generation for an Accepted record.
  onSubmitted?: (submitted: QcDetail) => void;
  // True only for a record just created this session via "+ New Record"
  // (never yet explicitly Saved/Submitted) -- see handleCancel.
  isNew?: boolean;
}) {
  // "Tray" here means the fixed OK / NOT OK checklist. The India RM Tray
  // report form is a tray QC too, but an attribute form like the others.
  const isTray = initialDetail.uses_fgtray ?? TRAY_FAMILY_QC_CATEGORIES.includes(initialDetail.category);
  const [detail, setDetail] = useState<QcDetail>(initialDetail);
  // Falcon: created from a Goods Receipt entry -- its shipment, SKU,
  // vendor and quantities are already known (read-only), so it opens straight
  // on the observations, and a COA is required to approve.
  const grLinked = !!initialDetail.source_goods_receipt_entry_id;
  const [step, setStep] = useState<2 | 3>(isTray || grLinked ? 3 : 2);
  const [vendor, setVendor] = useState(initialDetail.vendor_name || "");
  const [quantity, setQuantity] = useState(initialDetail.quantity != null ? String(initialDetail.quantity) : "");
  const [quantityUnit, setQuantityUnit] = useState<QuantityUnit>((initialDetail.quantity_unit as QuantityUnit) || "Pallets");
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

  const categorySkus = skuCodes.filter((s) => skuMatchesCategory(s.category, detail.category));
  const versionsForSku = categorySkus.find((s) => s.id === skuCodeId)?.versions || [];

  async function persistBasic(): Promise<QcDetail | null> {
    try {
      const updated = await api.updateQcBasic(qcId, {
        vendor_name: vendor, quantity: quantity ? Number(quantity) : null, quantity_unit: quantityUnit,
        sku_code_id: skuCodeId || null, sku_version_id: skuVersionId || null,
      });
      setDetail(updated);
      return updated;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      return null;
    }
  }

  useEffect(() => {
    if (!touched || isTray || grLinked) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { persistBasic(); }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor, quantity, quantityUnit, skuCodeId, skuVersionId, touched]);

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
  const pendingAttrSave = useRef<{ values: typeof detail.attribute_values; conclusion: string } | null>(null);
  async function flushAttributeSave() {
    const pending = pendingAttrSave.current;
    if (!pending) return;
    pendingAttrSave.current = null;
    if (attrSaveTimer.current) clearTimeout(attrSaveTimer.current);
    try {
      const updated = await api.saveQcAttributes(
        qcId,
        pending.values.map((v) => ({ attribute_definition_id: v.attribute_definition_id, value: v.value })),
        pending.conclusion
      );
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save observation");
    }
  }
  function scheduleAttributeSave(nextValues: typeof detail.attribute_values, nextConclusion: string) {
    pendingAttrSave.current = { values: nextValues, conclusion: nextConclusion };
    if (attrSaveTimer.current) clearTimeout(attrSaveTimer.current);
    attrSaveTimer.current = setTimeout(flushAttributeSave, 500);
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

  const formKey = detail.form_key || detail.category;
  const india = INDIA_FORM_KEYS.includes(formKey);
  const ev = detail.evaluation;
  // Completion / status preview mirroring the backend's exact rules, purely
  // to drive the Submit button and hint text — the backend re-validates.
  let complete = false;
  let hasNotOk = false;
  if (isTray) {
    complete = detail.fgtray_answers.length > 0 && detail.fgtray_answers.every((a) => a.answer === "ok" || a.answer === "not_ok");
    hasNotOk = detail.fgtray_answers.some((a) => a.answer === "not_ok");
  } else if (india) {
    // India report forms: the server decides (required fields, valid numbers,
    // sampling plan, the report's accept / hold rule) and sends its reading
    // back with every save -- the form just shows it.
    complete = !!ev?.complete;
  } else {
    const requiredFilled = detail.attribute_values.filter((v) => v.is_required).every((v) => v.value != null && v.value !== "");
    complete = requiredFilled && conclusion.trim() !== "";
  }

  // The server decides (trays -- incl. the RM Tray report form -- never have a COA).
  const coaRequired = detail.requires_coa ?? (grLinked && !isTray);
  const coaOk = !coaRequired || !!detail.coa_filename;
  const canSubmit = complete && coaOk;
  const plan = india
    ? (ev?.sampling ? { sampleSize: ev.sampling.sample_size, upperLimit: ev.sampling.upper_limit, note: ev.sampling.note } : null)
    : computeClientSamplingPlan(meta, detail.category, quantity ? Number(quantity) : (detail.quantity ? Number(detail.quantity) : null));

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
      if (!isTray && !grLinked) await persistBasic();
      await flushAttributeSave();
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
      if (!isTray && !grLinked) await persistBasic();
      await flushAttributeSave();  // never submit ahead of the last typed value
      const updated = await api.submitQc(qcId);
      setDetail(updated);
      onSubmitted?.(updated);
      onSaved();
      onClose(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to submit");
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    if (isNew) {
      // Creating a NEW record: Cancel must discard the unsaved form state
      // completely regardless of whether any fields were touched/autosaved
      // -- this record was never explicitly Saved/Submitted in this
      // session. Always hard-delete rather than the blank-only check.
      if (detail.status === "draft" && !isTray && !grLinked) {
        try { await api.discardNewQc(qcId); } catch { /* best-effort */ }
      }
      onClose(true);
      return;
    }
    if (!touched && detail.status === "draft" && !isTray && !grLinked) {
      try { await api.discardQcIfBlank(qcId); } catch { /* best-effort */ }
    }
    await flushAttributeSave();  // keep what was typed in the last half second
    onClose(false);
  }

  const conclusionLabel = !isTray ? (meta.conclusion_labels[formKey] || "Conclusion") : "";
  const countLabel = !isTray ? (meta.count_labels[formKey] || "") : "";

  return (
    <>
      <div className="panel-overlay open" onClick={handleCancel} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{CATEGORY_LABELS[detail.category]} Inward QC</h2>
            <div className="sub">Shipment {detail.shipment_number || "(pending)"}{detail.sku_code ? ` · ${detail.sku_code}` : ""}{detail.vendor_name ? ` · ${detail.vendor_name}` : ""} · <span className={`badge ${detail.status}`}>{statusLabel(detail.status)}</span></div>
          </div>
          <button className="sp-close" onClick={handleCancel}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          {grLinked && isFinalized && detail.goods_receipt && (
            <div className="detail-card" style={{ marginBottom: 20 }}>
              <h3>Inward Details</h3>
              <div className="detail-grid">
                <div><div className="detail-kv-label">PO Number</div><div className="detail-kv-value mono">{detail.goods_receipt.po_number || "—"}</div></div>
                <div><div className="detail-kv-label">Vendor</div><div className="detail-kv-value">{detail.goods_receipt.vendor_name || detail.vendor_name || "—"}</div></div>
                <div><div className="detail-kv-label">{T.shipmentNumber}</div><div className="detail-kv-value mono">{detail.shipment_number}</div></div>
                <div><div className="detail-kv-label">{T.sku}</div><div className="detail-kv-value mono">{detail.sku_code || "—"}</div></div>
                <div><div className="detail-kv-label">SKU Version</div><div className="detail-kv-value">{detail.sku_version || "—"}</div></div>
                <div><div className="detail-kv-label">PO Quantity</div><div className="detail-kv-value">{detail.goods_receipt.po_quantity ?? "—"} {detail.goods_receipt.unit || ""}</div></div>
                <div><div className="detail-kv-label">Received</div><div className="detail-kv-value">{detail.goods_receipt.received_quantity ?? "—"} {detail.goods_receipt.unit || ""}</div></div>
                {detail.goods_receipt.pallet_count != null && (
                  <div><div className="detail-kv-label">Pallets</div><div className="detail-kv-value">{detail.goods_receipt.pallet_count}</div></div>
                )}
                {detail.goods_receipt.received_at && (
                  <div><div className="detail-kv-label">Receiving Date</div><div className="detail-kv-value">{new Date(detail.goods_receipt.received_at).toLocaleString()}</div></div>
                )}
                {detail.submitted_at && (
                  <div><div className="detail-kv-label">Inspection Date</div><div className="detail-kv-value">{new Date(detail.submitted_at).toLocaleString()}</div></div>
                )}
              </div>
              {detail.goods_receipt.sku_spec && (
                <div style={{ marginTop: 12 }}>
                  <div className="detail-kv-label">SKU specification (for reference)</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                    {Object.entries(detail.goods_receipt.sku_spec).map(([k, v]) => `${k}: ${v}`).join("  ·  ")}
                  </div>
                </div>
              )}
              {detail.goods_receipt.batch_numbers.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="detail-kv-label">Batch Numbers ({detail.goods_receipt.batch_numbers.length})</div>
                  <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.7, maxHeight: 96, overflowY: "auto" }}>
                    {detail.goods_receipt.batch_numbers.map((b, i) => `${i + 1}: ${b}`).join("  ·  ")}
                  </div>
                </div>
              )}
            </div>
          )}

          {isTray && !grLinked && (
            <div className="detail-card" style={{ marginBottom: 20 }}>
              <h3>Vehicle Inspection Information</h3>
              <div className="detail-grid">
                <div><div className="detail-kv-label">{T.shipmentNumber}</div><div className="detail-kv-value">{detail.shipment_number}</div></div>
                <div><div className="detail-kv-label">Vendor</div><div className="detail-kv-value">{detail.vendor_name || "—"}</div></div>
                <div><div className="detail-kv-label">Quantity</div><div className="detail-kv-value">{detail.quantity ?? "—"}</div></div>
              </div>
              {detail.line_item_snapshots.length > 0 && (
                <table className="qc-obs-table" style={{ marginTop: 14 }}>
                  <thead><tr><th>{T.sku}</th><th>Quantity</th></tr></thead>
                  <tbody>
                    {detail.line_item_snapshots.map((li, i) => (
                      <tr key={i}><td>{li.sku_code || "—"}</td><td>{li.quantity}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {!isTray && !grLinked && step === 2 && (
            <div>
              <div className="form-grid" style={{ marginBottom: 18 }}>
                <div className="field">
                  <label>{T.shipmentNumber}</label>
                  <div className="readonly-val">{detail.shipment_number}</div>
                </div>
                <div className="field"><label>Vendor</label>
                  <input disabled={readOnlyBasic} value={vendor} placeholder="e.g. 3P China" onChange={(e) => markTouched(setVendor)(e.target.value)} />
                </div>
                <div className="field"><label>{meta.quantity_labels[detail.category]}</label>
                  <input type="number" disabled={readOnlyBasic} value={quantity} placeholder="Enter quantity" onChange={(e) => markTouched(setQuantity)(e.target.value)} />
                </div>
                <div className="field"><label>Unit</label>
                  <select disabled={readOnlyBasic} value={quantityUnit} onChange={(e) => markTouched(setQuantityUnit)(e.target.value as QuantityUnit)}>
                    {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-grid" style={{ marginBottom: 18 }}>
                <div className="field"><label>{T.sku} <span style={{ color: "var(--red)" }}>*</span></label>
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
              <CoaField qcId={qcId} filename={detail.coa_filename} url={detail.coa_url} disabled={readOnlyBasic} onChange={setDetail} parsesValues={!india && !isTray} />
            </div>
          )}

          {(step === 3 || isTray) && (
            <div>
              {coaRequired && (
                <div style={{ marginBottom: 18 }}>
                  <CoaField qcId={qcId} filename={detail.coa_filename} url={detail.coa_url} disabled={!canFillSection || isFinalized} onChange={setDetail} parsesValues={!india && !isTray} />
                  {!detail.coa_filename && <div className="hint-text" style={{ color: "var(--red)", marginTop: 4 }}>A COA is required before this can be approved.</div>}
                </div>
              )}
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
                      {plan.note && <div className="pc-item"><div className="k">Note</div><div className="v" style={{ fontSize: 13 }}>{plan.note}</div></div>}
                    </>
                  )}
                </div>
              )}
              {india && !plan && (
                <div className="hint-text" style={{ marginBottom: 12 }}>
                  {ev?.lot_quantity
                    ? `The report's sampling plan has no entry for a lot of ${ev.lot_quantity}. Confirm the sample size with QA.`
                    : "Enter the quantity received (or Quantity/Pallet for the RM Tray) to see the sampling plan."}
                </div>
              )}
              {india && (
                <div className="hint-text" style={{ fontWeight: 700, marginBottom: 14, color: !complete ? "var(--ink-50)" : ev?.outcome === "onhold" ? "var(--red)" : "var(--green-deep)" }}>
                  {!complete
                    ? `Still needed before this can be approved: ${(ev?.missing || []).join("; ") || "—"}. Until then it stays Pending.`
                    : !coaOk
                    ? "Upload the COA to approve this record. Until then it stays Pending."
                    : ev?.outcome === "onhold"
                    ? "Complete — this record will be set to On Hold."
                    : "Complete — this record will be set to Accepted."}
                  {(ev?.messages || []).map((m, i) => <div key={i} style={{ fontWeight: 600 }}>{m}</div>)}
                </div>
              )}
              <div hidden={india} className="hint-text" style={{ fontWeight: 700, marginBottom: 14, color: complete ? (hasNotOk ? "var(--red)" : "var(--green-deep)") : "var(--ink-50)" }}>
                {complete && !coaOk
                  ? "Upload the COA to approve this record. Until then it stays Pending."
                  : complete
                  ? (isTray ? (hasNotOk ? "One or more criteria are NOT OK — this record will be set to On Hold." : "All criteria OK — this record will be set to Accepted.") : "All required fields and conclusion complete — this record will be set to Accepted.")
                  : (isTray ? "Mark OK / NOT OK for every criterion to complete this inspection. Until then it stays Pending." : "Fill in every required field (marked *) and the conclusion to complete this inspection. Until then it stays Pending.")}
              </div>

              {isTray ? (
                <FgtrayObservations answers={detail.fgtray_answers} onChange={handleFgtrayAnswer} disabled={!canFillSection} />
              ) : (
                <>
                  {countLabel && <div className="hint-text" style={{ marginBottom: 10 }}>{countLabel}: {plan ? `${plan.sampleSize} samples (auto, from Sampling Plan)` : ""}</div>}
                  {india && ev?.failed_count != null && <div className="hint-text" style={{ marginBottom: 10 }}>Failed products so far: {ev.failed_count}{ev.upper_limit != null ? ` of an upper limit of ${ev.upper_limit}` : ""}</div>}
                  {india
                    ? <ReportObservations values={detail.attribute_values} onChange={handleAttributeChange} disabled={!canFillSection || (detail.status === "accepted")} />
                    : <AttributeObservations values={detail.attribute_values} coaFilename={detail.coa_filename} onChange={handleAttributeChange} disabled={!canFillSection} />}
                  <div className="field" style={{ marginTop: 14 }}>
                    <label>{conclusionLabel}{india ? " (optional)" : ""}</label>
                    <textarea rows={2} disabled={!canFillSection || (grLinked && detail.status === "accepted")} defaultValue={conclusion} onBlur={(e) => handleConclusionChange(e.target.value)} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
          <div className="sp-foot-right">
            {!isTray && !grLinked && step === 3 && <button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button>}
            {!isTray && <button className="btn btn-secondary" disabled={saving} onClick={handleSaveDraft}>Save Draft</button>}
            {!isTray && !grLinked && step === 2 && (
              <button className="btn btn-primary" disabled={saving || !skuCodeId || !skuVersionId || !quantity} onClick={handleNext}>Next →</button>
            )}
            {(isTray || step === 3) && (
              <button className="btn btn-primary" disabled={saving || !canSubmit} onClick={handleSubmit}>Submit</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
