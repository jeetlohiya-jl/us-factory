"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Category, GoodsReceiptEntry, InspectionDetail, Permissions } from "@/lib/types";
import ImageField from "@/components/inward-vehicle-inspection/ImageField";
import MultiImageField from "@/components/inward-vehicle-inspection/MultiImageField";
import ChecklistStep from "@/components/inward-vehicle-inspection/ChecklistStep";
import { statusLabel } from "@/lib/terms";
import { needsStage } from "./GoodsReceiptDetailPanel";

/**
 * Goods Receipt's own "Inward" flow (2026-09-28) -- a fork of
 * inward-vehicle-inspection/Wizard.tsx, not a new inspection system. Same
 * two-step shape (Details -> Vehicle Inspection checklist), same
 * ImageField/MultiImageField/ChecklistStep components, same
 * save-draft/submit/checklist/cancel API calls and Save Draft/Save/Cancel
 * behavior -- narrowed to what the spec asked for:
 *
 *   - PO/SKU/vendor/shipment number are already known from the Goods
 *     Receipt entry, so they're shown read-only instead of re-collected.
 *   - Page 1 asks only for Quantity (Pallets), Truck/Vehicle Number,
 *     Container Number, Name of Transporter and Seal No. (plus a Base
 *     Tray/LNP Tray pick when the entry's stage isn't known yet -- the same
 *     choice the old inline "Inward" form asked for).
 *   - Quantity (Pallets) is persisted as the inspection's one line item
 *     (the entry's own SKU/version, quantity = pallets, unit = "Pallets"),
 *     so `detail.total_quantity` -- read back by the caller once Approved --
 *     is exactly the pallet count entered here.
 *   - Approval doesn't perform the Goods Receipt "inward" itself; the
 *     caller's onApproved does that (and then opens RM QR Generation), so
 *     an entry is never marked inwarded without a completed inspection.
 */
export default function GrInwardWizard({
  entry, poNumber, vendorName, inspectionId, initialDetail, permissions, onClose, onApproved, onSaved, isNew = false,
}: {
  entry: GoodsReceiptEntry;
  poNumber: string;
  vendorName: string;
  inspectionId: string;
  initialDetail: InspectionDetail;
  permissions: Permissions;
  onClose: (deleted: boolean) => void;
  // Called once, right when the inspection reaches "approved" (before this
  // component closes itself) -- the caller performs the real Goods Receipt
  // inward and opens RM QR Generation for this entry.
  onApproved: (detail: InspectionDetail) => void;
  onSaved: () => void;
  // True only for an inspection created for this "Inward" click just now
  // (no prior draft/hold existed for this entry) -- mirrors Wizard's isNew,
  // so an unfilled Cancel discards it instead of leaving a stray draft.
  isNew?: boolean;
}) {
  const [detail, setDetail] = useState<InspectionDetail>(initialDetail);
  const [step, setStep] = useState<1 | 2>(1);
  const [stage, setStage] = useState<"tray" | "lnp_tray">(initialDetail.category === "lnp_tray" ? "lnp_tray" : "tray");
  const [pallets, setPallets] = useState(String(initialDetail.total_quantity || ""));
  const [truck, setTruck] = useState(initialDetail.truck_number || "");
  const [container, setContainer] = useState(initialDetail.container_number || "");
  const [transporter, setTransporter] = useState(initialDetail.transporter_name || "");
  const [seal, setSeal] = useState(initialDetail.seal_number || "");
  const [remarks, setRemarks] = useState(initialDetail.remarks || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // Tracks "changed since the last successful persistBasic()" -- separate
  // from `touched` (which, once true, stays true for the rest of the
  // session and only gates the autosave effect). Every caller of
  // persistBasic() used to call it unconditionally, so a "click Next" or
  // "click Submit" on a record that was just autosaved 900ms earlier (the
  // common case: page 1 fields are already saved by the time page 2's
  // checklist -- which has its own per-click save -- is fully answered)
  // still paid for a full extra round trip to nothing but re-save the same
  // values. On a slow/cold backend that's the difference between one wait
  // and two. Skipping the call when nothing is actually dirty removes that
  // wasted trip without changing behavior when there IS unsaved data.
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Confirmed via a screen recording: clicking OK/NOT OK on one item, then
  // quickly correcting an earlier mistake on a DIFFERENT item, could show
  // the wrong item flip back to the wrong answer a second or two later, then
  // self-correct again -- classic out-of-order network responses. Each
  // click fires its own PUT and applies whatever full record comes back;
  // nothing stopped an older click's response (delayed by the backend, or
  // just network jitter) from landing after a newer click's response and
  // clobbering it with stale data. This counter makes only the MOST
  // RECENTLY FIRED checklist save "win": every earlier response is dropped
  // on arrival, so the applied state can never regress to an older answer.
  const checklistReqSeq = useRef(0);

  const stagePickerNeeded = needsStage(entry);
  const isFinalized = detail.status === "approved" || detail.status === "hold";
  const readOnlyStep1 = isFinalized && !permissions.can_edit;
  const canFillSection = permissions.can_fill_section || permissions.can_create || permissions.can_edit;

  function buildBasicPayload() {
    return {
      category: (stagePickerNeeded ? stage : detail.category) as Category,
      shipment_number: detail.shipment_number,
      truck_number: truck,
      container_number: container,
      vendor_name: detail.vendor_name,
      invoice_number: detail.invoice_number || "",
      transporter_name: transporter,
      seal_number: seal,
      remarks,
      line_items: [{
        sku_code_id: entry.sku_code_id,
        sku_version_id: entry.sku_version_id || null,
        quantity: parseFloat(pallets) || 0,
        unit: "Pallets",
      }],
    };
  }

  async function persistBasic(): Promise<InspectionDetail | null> {
    try {
      const updated = await api.updateInspection(inspectionId, buildBasicPayload());
      setDetail(updated);
      dirty.current = false;
      return updated;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      return null;
    }
  }

  // Only actually hits the network when something changed since the last
  // successful persistBasic() (via the debounced autosave, or a prior call
  // from this same function). Safe: it's the exact save that would have run
  // anyway, just skipped when it would be a no-op write of unchanged data.
  async function persistBasicIfDirty(): Promise<InspectionDetail | null> {
    if (!dirty.current) return detail;
    return persistBasic();
  }

  // Debounced autosave of Page 1 fields, same as Wizard -- a draft survives
  // even if the user closes the panel without an explicit Save Draft click.
  useEffect(() => {
    if (!touched) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { persistBasic(); }, 900);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, pallets, truck, container, transporter, seal, remarks, touched]);

  function markTouched<T>(setter: (v: T) => void) {
    return (v: T) => { setTouched(true); dirty.current = true; setter(v); };
  }

  function validatePallets(): string | null {
    const n = Number(pallets);
    if (!(n >= 1) || !Number.isInteger(n)) return "Quantity (Pallets) must be a whole number of at least 1.";
    return null;
  }

  async function handleNext() {
    const invalid = validatePallets();
    if (invalid) { setError(invalid); return; }
    setSaving(true);
    const ok = await persistBasicIfDirty();
    setSaving(false);
    if (ok) { setError(null); setStep(2); }
  }

  async function handleSaveDraft() {
    setSaving(true);
    setError(null);
    try {
      await persistBasicIfDirty();
      const updated = await api.saveDraft(inspectionId);
      setDetail(updated);
      onSaved();
      onClose(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save draft");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetAnswer(checklistItemId: string, val: "ok" | "not_ok") {
    const seq = ++checklistReqSeq.current;
    setDetail((prev) => ({
      ...prev,
      checklist_answers: prev.checklist_answers.map((a) => a.checklist_item_id === checklistItemId ? { ...a, answer: val } : a),
    }));
    try {
      const updated = await api.saveChecklist(inspectionId, { [checklistItemId]: val });
      // A newer click already fired since this one -- its own response
      // (or the optimistic state it applied) is the current truth. Applying
      // this older response now would silently revert that newer answer.
      if (seq !== checklistReqSeq.current) return;
      setDetail(updated);
    } catch (e) {
      if (seq !== checklistReqSeq.current) return;
      setError(e instanceof Error ? e.message : "Failed to save checklist answer");
    }
  }

  const complete = detail.checklist_answers.length > 0 && detail.checklist_answers.every((a) => a.answer === "ok" || a.answer === "not_ok");

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await persistBasicIfDirty();
      const updated = await api.submit(inspectionId);
      setDetail(updated);
      if (updated.status === "approved") {
        onApproved(updated);
      } else {
        onSaved();
      }
      onClose(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to submit");
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    if (isNew) {
      // Never yet Saved/Submitted this session -- discard completely,
      // whatever the debounced autosave already wrote (same as Wizard).
      if (detail.status === "draft") {
        try { await api.discardNewInspection(inspectionId); } catch { /* best-effort */ }
      }
      onClose(true);
      return;
    }
    // Resuming an existing draft: only clean up if it's genuinely blank.
    if (detail.status === "draft") {
      try { await api.discardIfBlank(inspectionId); } catch { /* best-effort */ }
    }
    onClose(false);
  }

  const imageOf = (type: string) => detail.images.find((i) => i.image_type === type);
  const damageImages = detail.images.filter((i) => i.image_type === "damage");
  const containerImages = detail.images.filter((i) => i.image_type === "container");

  return (
    <>
      <div className="panel-overlay open" onClick={handleCancel} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{isFinalized ? "Inward Inspection Record" : "Inward Inspection"}</h2>
            <div className="sub">
              {poNumber} / {entry.shipment_number} · <span className={`badge ${detail.status}`}>{statusLabel(detail.status)}</span>
            </div>
          </div>
          <button className="sp-close" onClick={handleCancel}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          {step === 1 && (
            <div>
              <div className="detail-card" style={{ marginBottom: 18 }}>
                <h3>Goods Receipt Details</h3>
                <div className="detail-grid">
                  <div>
                    <div className="detail-kv-label">PO Number</div>
                    <div className="detail-kv-value mono">{poNumber}</div>
                  </div>
                  <div>
                    <div className="detail-kv-label">Container / Shipment Number</div>
                    <div className="detail-kv-value mono">{entry.shipment_number}</div>
                  </div>
                  <div>
                    <div className="detail-kv-label">SKU</div>
                    <div className="detail-kv-value">{entry.sku_code || "—"}{entry.sku_version ? ` · ${entry.sku_version}` : ""}</div>
                  </div>
                  <div>
                    <div className="detail-kv-label">Vendor</div>
                    <div className="detail-kv-value">{vendorName}</div>
                  </div>
                  <div>
                    <div className="detail-kv-label">PO Quantity</div>
                    <div className="detail-kv-value">{entry.po_quantity} {entry.unit}</div>
                  </div>
                </div>
              </div>

              <div className="form-grid" style={{ marginBottom: 18 }}>
                {stagePickerNeeded && (
                  <div className="field">
                    <label>Category</label>
                    <select disabled={readOnlyStep1} value={stage} onChange={(e) => markTouched(setStage)(e.target.value as "tray" | "lnp_tray")}>
                      <option value="tray">Base Tray</option>
                      <option value="lnp_tray">LNP Tray</option>
                    </select>
                  </div>
                )}
                <div className="field">
                  <label>Quantity (Pallets) <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="number" min={1} step={1} disabled={readOnlyStep1} value={pallets} placeholder="e.g. 20"
                    onChange={(e) => markTouched(setPallets)(e.target.value)} />
                </div>
              </div>

              <div className="form-grid">
                <div className="field"><label>Truck / Vehicle Number</label>
                  <input disabled={readOnlyStep1} value={truck} placeholder="e.g. TRK-88213" style={{ textTransform: "uppercase" }} onChange={(e) => markTouched(setTruck)(e.target.value.toUpperCase())} />
                </div>
                <div className="field"><label>Container Number</label>
                  <input disabled={readOnlyStep1} value={container} placeholder="e.g. CXY-20354" style={{ textTransform: "uppercase" }} onChange={(e) => markTouched(setContainer)(e.target.value.toUpperCase())} />
                </div>
                <div className="field"><label>Name of Transporter</label>
                  <input disabled={readOnlyStep1} value={transporter} placeholder="e.g. ABC Logistics" onChange={(e) => markTouched(setTransporter)(e.target.value)} />
                </div>
                <div className="field"><label>Seal No.</label>
                  <input disabled={readOnlyStep1} value={seal} placeholder="e.g. SL-44210" style={{ textTransform: "uppercase" }} onChange={(e) => markTouched(setSeal)(e.target.value.toUpperCase())} />
                </div>
              </div>

              <div className="section-label">Photos</div>
              <div className="form-grid">
                <ImageField inspectionId={inspectionId} imageType="truck" label="Truck Number Photo" image={imageOf("truck")} disabled={!canFillSection} onChange={(d) => { setDetail(d); setTruck(d.truck_number || ""); }} />
                <ImageField inspectionId={inspectionId} imageType="seal" label="Seal Photo" image={imageOf("seal")} disabled={!canFillSection} onChange={(d) => { setDetail(d); setSeal(d.seal_number || ""); }} />
                <ImageField inspectionId={inspectionId} imageType="condition" label="Physical Condition on First Opening" image={imageOf("condition")} disabled={!canFillSection} onChange={setDetail} />
                <ImageField inspectionId={inspectionId} imageType="empty_container" label="Empty Container Photo" image={imageOf("empty_container")} disabled={!canFillSection} onChange={setDetail} />
              </div>
              <div style={{ marginTop: 16 }}>
                <MultiImageField inspectionId={inspectionId} imageType="container" images={containerImages} label="Container Photo(s)" disabled={!canFillSection} onChange={(d) => { setDetail(d); setContainer(d.container_number || ""); }} />
              </div>
              <div style={{ marginTop: 16 }}>
                <MultiImageField inspectionId={inspectionId} imageType="damage" images={damageImages} disabled={!canFillSection} onChange={setDetail} />
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <ChecklistStep answers={detail.checklist_answers} onSetAnswer={handleSetAnswer} disabled={!canFillSection} />
              <div className="field" style={{ marginTop: 16 }}>
                <label>Other Remarks (if any)</label>
                <textarea rows={2} value={remarks} placeholder="No remarks" onChange={(e) => markTouched(setRemarks)(e.target.value)} />
              </div>
            </div>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
          <div className="sp-foot-right">
            {step === 2 && <button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button>}
            <button className="btn btn-secondary" disabled={saving} onClick={handleSaveDraft}>Save Draft</button>
            {step === 1 && <button className="btn btn-primary" disabled={saving} onClick={handleNext}>Next →</button>}
            {step === 2 && (
              <button className="btn btn-primary" disabled={saving || !complete} onClick={handleSubmit}>
                Submit
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
