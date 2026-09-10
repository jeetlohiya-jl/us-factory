"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Category, InspectionDetail, Permissions, SkuCode, Vendor } from "@/lib/types";
import LineItemsEditor, { EditableLineItem } from "./LineItemsEditor";
import ImageField from "./ImageField";
import MultiImageField from "./MultiImageField";
import ChecklistStep from "./ChecklistStep";

const CATEGORY_LABELS: Record<Category, string> = {
  tray: "Tray", pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};

function toLineItems(detail: InspectionDetail): EditableLineItem[] {
  if (!detail.line_items.length) return [{ sku_code_id: "", sku_version_id: "", quantity: "" }];
  return detail.line_items.map((li) => ({
    sku_code_id: li.sku_code_id || "", sku_version_id: li.sku_version_id || "", quantity: String(li.quantity ?? ""),
  }));
}

export default function Wizard({
  inspectionId, initialDetail, skuCodes, permissions, onClose, onSaved, isNew = false,
}: {
  inspectionId: string;
  initialDetail: InspectionDetail;
  skuCodes: SkuCode[];
  permissions: Permissions;
  onClose: (deleted: boolean) => void;
  onSaved: () => void;
  // True only for a record just created this session via "+ New Record"
  // (never yet explicitly Saved/Submitted by the user) -- see handleCancel.
  // False when reopening an existing record (including an existing Draft
  // saved in an earlier session) for editing.
  isNew?: boolean;
}) {
  const [detail, setDetail] = useState<InspectionDetail>(initialDetail);
  const [step, setStep] = useState<1 | 2>(1);
  const [category, setCategory] = useState<Category>(initialDetail.category);
  const [shipmentNumber, setShipmentNumber] = useState(initialDetail.shipment_number);
  const [truck, setTruck] = useState(initialDetail.truck_number || "");
  const [container, setContainer] = useState(initialDetail.container_number || "");
  const [vendor, setVendor] = useState(initialDetail.vendor_name || "");
  const [vendorOptions, setVendorOptions] = useState<Vendor[]>([]);
  const [addingVendor, setAddingVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [newVendorCountry, setNewVendorCountry] = useState("");
  const [vendorError, setVendorError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState(initialDetail.invoice_number || "");
  const [transporter, setTransporter] = useState(initialDetail.transporter_name || "");
  const [seal, setSeal] = useState(initialDetail.seal_number || "");
  const [remarks, setRemarks] = useState(initialDetail.remarks || "");
  const [lineItems, setLineItems] = useState<EditableLineItem[]>(toLineItems(initialDetail));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isFinalized = detail.status === "approved" || detail.status === "hold";
  const readOnlyStep1 = isFinalized && !permissions.can_edit;
  const canFillSection = permissions.can_fill_section || permissions.can_create || permissions.can_edit;

  function totalQty() {
    return lineItems.reduce((sum, li) => sum + (parseFloat(li.quantity) || 0), 0);
  }

  function buildBasicPayload() {
    return {
      category,
      shipment_number: category === "tray" ? shipmentNumber : detail.shipment_number,
      truck_number: truck,
      container_number: container,
      vendor_name: vendor,
      invoice_number: invoice,
      transporter_name: transporter,
      seal_number: seal,
      remarks,
      line_items: lineItems
        .filter((li) => li.sku_code_id && li.quantity)
        .map((li) => ({ sku_code_id: li.sku_code_id, sku_version_id: li.sku_version_id || null, quantity: parseFloat(li.quantity) || 0 })),
    };
  }

  async function persistBasic(): Promise<InspectionDetail | null> {
    try {
      const updated = await api.updateInspection(inspectionId, buildBasicPayload());
      setDetail(updated);
      return updated;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      return null;
    }
  }

  // Debounced autosave of Step 1 fields so a draft survives even if the user
  // closes the panel without an explicit Save Draft click.
  useEffect(() => {
    if (!touched) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { persistBasic(); }, 900);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, shipmentNumber, truck, container, vendor, invoice, transporter, seal, remarks, lineItems, touched]);

  function markTouched<T>(setter: (v: T) => void) {
    return (v: T) => { setTouched(true); setter(v); };
  }

  // Vendor Name is a managed per-category list (see /vendors) rather than
  // freehand text -- reload the dropdown's options whenever the inspection's
  // category changes (a Pad vendor list is meaningless for a Glue record).
  useEffect(() => {
    let cancelled = false;
    api.vendors({ category }).then((v) => { if (!cancelled) setVendorOptions(v); }).catch(() => {});
    return () => { cancelled = true; };
  }, [category]);

  async function handleAddVendor() {
    const name = newVendorName.trim();
    const country = newVendorCountry.trim();
    if (!name || country.length !== 2) {
      setVendorError("Vendor name and a 2-letter country code (e.g. US, CN) are both required.");
      return;
    }
    setVendorError(null);
    try {
      const created = await api.createVendor(category, name, country);
      setVendorOptions((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      markTouched(setVendor)(created.name);
      setAddingVendor(false);
      setNewVendorName("");
      setNewVendorCountry("");
    } catch (e) {
      setVendorError(e instanceof Error ? e.message : "Could not add vendor.");
    }
  }

  async function handleNext() {
    setSaving(true);
    const ok = await persistBasic();
    setSaving(false);
    if (ok) setStep(2);
  }

  async function handleSaveDraft() {
    setSaving(true);
    setError(null);
    try {
      await persistBasic();
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
    const optimistic = {
      ...detail,
      checklist_answers: detail.checklist_answers.map((a) => a.checklist_item_id === checklistItemId ? { ...a, answer: val } : a),
    };
    setDetail(optimistic);
    try {
      const updated = await api.saveChecklist(inspectionId, { [checklistItemId]: val });
      setDetail(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save checklist answer");
    }
  }

  const complete = detail.checklist_answers.length > 0 && detail.checklist_answers.every((a) => a.answer === "ok" || a.answer === "not_ok");

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await persistBasic();
      const updated = await api.submit(inspectionId);
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
    if (isNew) {
      // Creating a NEW record: Cancel must discard the unsaved form state
      // completely, whether no fields were entered, some were, or all were
      // -- this record was never explicitly Saved/Submitted by the user in
      // this session (Step 1's autosave only exists so a Save Draft/Submit
      // doesn't lose typed data; it must never be what makes Cancel keep a
      // record the user asked to discard). Always hard-delete, regardless
      // of whether the debounced autosave already wrote data to it.
      if (detail.status === "draft") {
        try { await api.discardNewInspection(inspectionId); } catch { /* best-effort */ }
      }
      onClose(true);
      return;
    }
    // Editing an existing record (including a Draft saved in an earlier
    // session): Cancel only cleans up if the record is genuinely blank --
    // unchanged prior behavior, since this is not "creating a new record".
    if (detail.status === "draft") {
      try { await api.discardIfBlank(inspectionId); } catch { /* best-effort */ }
    }
    onClose(false);
  }

  const imageOf = (type: string) => detail.images.find((i) => i.image_type === type);
  const damageImages = detail.images.filter((i) => i.image_type === "damage");

  return (
    <>
      <div className="panel-overlay open" onClick={handleCancel} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>{isFinalized ? "Vehicle Inspection Record" : "New Vehicle Inspection"}</h2>
            <div className="sub">Shipment {detail.shipment_number || "(pending)"} · <span className={`badge ${detail.status}`}>{detail.status}</span></div>
          </div>
          <button className="sp-close" onClick={handleCancel}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          {step === 1 && (
            <div>
              <div className="form-grid" style={{ marginBottom: 18 }}>
                <div className="field">
                  <label>Material Category</label>
                  <select
                    disabled={readOnlyStep1}
                    value={category}
                    onChange={(e) => markTouched(setCategory)(e.target.value as Category)}
                  >
                    {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Shipment Number <span style={{ color: "var(--red)" }}>*</span></label>
                  {category === "tray" ? (
                    <input
                      type="text"
                      disabled={readOnlyStep1}
                      value={shipmentNumber}
                      placeholder="e.g. A45, D45, E6"
                      onChange={(e) => markTouched(setShipmentNumber)(e.target.value)}
                    />
                  ) : (
                    <div className="readonly-val">{detail.shipment_number}</div>
                  )}
                </div>
                <div className="field">
                  <label>Total Quantity</label>
                  <input type="text" readOnly value={totalQty() || ""} placeholder="Sum of SKU Details quantities" />
                </div>
              </div>

              <div className="form-grid">
                <div className="field"><label>Truck / Vehicle Number</label>
                  <input disabled={readOnlyStep1} value={truck} placeholder="e.g. TRK-88213" onChange={(e) => markTouched(setTruck)(e.target.value)} />
                </div>
                <div className="field"><label>Container Number</label>
                  <input disabled={readOnlyStep1} value={container} placeholder="e.g. CXY-20354" onChange={(e) => markTouched(setContainer)(e.target.value)} />
                </div>
                <div className="field"><label>Vendor Name</label>
                  {addingVendor ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        autoFocus value={newVendorName} placeholder="New vendor name"
                        onChange={(e) => setNewVendorName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleAddVendor()}
                      />
                      <input
                        value={newVendorCountry} placeholder="Country" maxLength={2}
                        style={{ width: 60, textTransform: "uppercase" }}
                        onChange={(e) => setNewVendorCountry(e.target.value.toUpperCase())}
                        onKeyDown={(e) => e.key === "Enter" && handleAddVendor()}
                      />
                      <button type="button" className="btn-tertiary" onClick={handleAddVendor}>Add</button>
                      <button type="button" className="btn-tertiary" onClick={() => { setAddingVendor(false); setVendorError(null); }}>Cancel</button>
                    </div>
                  ) : (
                    <select
                      disabled={readOnlyStep1}
                      value={vendor}
                      onChange={(e) => {
                        if (e.target.value === "__add__") { setAddingVendor(true); return; }
                        markTouched(setVendor)(e.target.value);
                      }}
                    >
                      <option value="">Select vendor</option>
                      {/* A vendor already on this record that isn't in the current
                          managed list (legacy free-text data, or a vendor since
                          deactivated) still shows so existing data is never hidden. */}
                      {vendor && !vendorOptions.some((v) => v.name === vendor) && (
                        <option value={vendor}>{vendor} (not in list)</option>
                      )}
                      {vendorOptions.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
                      {!readOnlyStep1 && <option value="__add__">+ Add new vendor…</option>}
                    </select>
                  )}
                  {vendorError && <div className="hint-text" style={{ color: "var(--red)" }}>{vendorError}</div>}
                </div>
                <div className="field"><label>Invoice No.</label>
                  <input disabled={readOnlyStep1} value={invoice} placeholder="e.g. INV-88213" onChange={(e) => markTouched(setInvoice)(e.target.value)} />
                </div>
                <div className="field"><label>Name of Transporter</label>
                  <input disabled={readOnlyStep1} value={transporter} placeholder="e.g. ABC Logistics" onChange={(e) => markTouched(setTransporter)(e.target.value)} />
                </div>
                <div className="field"><label>Seal No.</label>
                  <input disabled={readOnlyStep1} value={seal} placeholder="e.g. SL-44210" onChange={(e) => markTouched(setSeal)(e.target.value)} />
                </div>
              </div>

              <div className="section-label">SKU Details</div>
              <LineItemsEditor items={lineItems} skuCodes={skuCodes.filter((s) => s.category === category)} disabled={readOnlyStep1} onChange={markTouched(setLineItems)} />

              <div className="section-label">Photos</div>
              <div className="form-grid">
                <ImageField inspectionId={inspectionId} imageType="container" label="Container Photo" image={imageOf("container")} disabled={!canFillSection} onChange={(d) => { setDetail(d); setContainer(d.container_number || ""); }} />
                <ImageField inspectionId={inspectionId} imageType="truck" label="Truck Number Photo" image={imageOf("truck")} disabled={!canFillSection} onChange={(d) => { setDetail(d); setTruck(d.truck_number || ""); }} />
                <ImageField inspectionId={inspectionId} imageType="seal" label="Seal Photo" image={imageOf("seal")} disabled={!canFillSection} onChange={(d) => { setDetail(d); setSeal(d.seal_number || ""); }} />
                <ImageField inspectionId={inspectionId} imageType="condition" label="Physical Condition on First Opening" image={imageOf("condition")} disabled={!canFillSection} onChange={setDetail} />
                <ImageField inspectionId={inspectionId} imageType="empty_container" label="Empty Container Photo" image={imageOf("empty_container")} disabled={!canFillSection} onChange={setDetail} />
              </div>
              <div style={{ marginTop: 16 }}>
                <MultiImageField inspectionId={inspectionId} images={damageImages} disabled={!canFillSection} onChange={setDetail} />
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
