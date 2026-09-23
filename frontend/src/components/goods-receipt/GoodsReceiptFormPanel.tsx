"use client";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { GoodsReceiptDetail, GoodsReceiptEntryDraft, GoodsReceiptSavePayload, SkuCode, Vendor } from "@/lib/types";
import GrEntriesEditor, { blankEntry } from "./GrEntriesEditor";

function draftsFrom(detail: GoodsReceiptDetail | null): GoodsReceiptEntryDraft[] {
  if (!detail) return [blankEntry()];
  return detail.entries.map((e) => ({
    key: e.id, id: e.id, locked: e.status === "inwarded",
    container_name: e.container_name, container_number: e.container_number || "",
    sku_code_id: e.sku_code_id, sku_version_id: e.sku_version_id,
    po_quantity: String(e.po_quantity), unit: e.unit,
  }));
}

/**
 * New / Edit Goods Receipt side panel -- same single-page side-panel
 * pattern as NewCustomerShipmentPanel. Everything is local state until
 * Save / Save Draft; nothing is written to the server before that, so
 * Cancel genuinely discards a new record (no autosaved draft left behind).
 * Save Draft persists an explicitly-saved draft that reopens from the
 * dashboard; containers can only be inwarded once the receipt is Saved.
 */
export default function GoodsReceiptFormPanel({
  existing, vendors, skuCodes, onClose, onSaved,
}: {
  existing: GoodsReceiptDetail | null;
  vendors: Vendor[];
  skuCodes: SkuCode[];
  onClose: () => void;
  onSaved: (saved: GoodsReceiptDetail) => void;
}) {
  const [poNumber, setPoNumber] = useState(existing?.po_number || "");
  const [vendorId, setVendorId] = useState<string>(existing?.vendor_id || "");
  const [entries, setEntries] = useState<GoodsReceiptEntryDraft[]>(() => draftsFrom(existing));
  const [saving, setSaving] = useState<"draft" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const anyInwarded = !!existing?.entries.some((e) => e.status === "inwarded");
  const canSaveDraft = !existing || existing.status === "draft";

  // Vendors are scoped per category in the master data, so one supplier can
  // appear more than once -- label duplicates with their category.
  const vendorOptions = useMemo(() => {
    const counts = new Map<string, number>();
    vendors.forEach((v) => counts.set(v.name, (counts.get(v.name) || 0) + 1));
    return vendors.map((v) => ({ id: v.id, label: (counts.get(v.name) || 0) > 1 ? `${v.name} (${v.category})` : v.name }));
  }, [vendors]);

  function buildPayload(asDraft: boolean): GoodsReceiptSavePayload | string {
    if (!poNumber.trim()) return "PO Number is required.";
    if (!vendorId) return "Vendor is required.";
    // Drop fully blank rows (e.g. the starter row) silently; anything
    // partially filled must be completed so nothing typed is lost unseen.
    const rows = entries.filter((e) => e.locked || e.container_name.trim() || e.sku_code_id || e.po_quantity);
    for (const [i, e] of rows.entries()) {
      if (e.locked) continue;
      const label = e.container_name.trim() || `Row ${i + 1}`;
      if (!e.container_name.trim()) return `${label}: Container Name is required.`;
      if (!e.sku_code_id) return `${label}: select a SKU.`;
      if (!(Number(e.po_quantity) > 0)) return `${label}: PO Quantity must be greater than 0.`;
      const hasVersions = (skuCodes.find((s) => s.id === e.sku_code_id)?.versions || []).some((v) => v.is_active);
      if (!asDraft && hasVersions && !e.sku_version_id) return `${label}: select a SKU Version.`;
    }
    if (!asDraft && rows.length === 0) return "Add at least one container before saving.";
    return {
      po_number: poNumber.trim(), vendor_id: vendorId, as_draft: asDraft,
      entries: rows.map((e) => ({
        id: e.id, container_name: e.container_name.trim(), container_number: e.container_number.trim() || null,
        sku_code_id: e.sku_code_id as string, sku_version_id: e.sku_version_id, po_quantity: Number(e.po_quantity), unit: e.unit,
      })),
    };
  }

  async function handleSave(asDraft: boolean) {
    const payload = buildPayload(asDraft);
    if (typeof payload === "string") { setError(payload); return; }
    setSaving(asDraft ? "draft" : "save");
    setError(null);
    try {
      const saved = existing ? await api.updateGoodsReceipt(existing.id, payload) : await api.createGoodsReceipt(payload);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Goods Receipt");
    } finally {
      setSaving(null);
    }
  }

  const containerCount = entries.filter((e) => e.locked || e.container_name.trim()).length;

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      {/* Wider than the default 760px: seven columns per container row. */}
      <div className="side-panel open" style={{ width: "min(1040px,96vw)" }}>
        <div className="sp-head">
          <div>
            <h2>{existing ? `Edit Goods Receipt · ${existing.po_number}` : "New Goods Receipt"}</h2>
            <div className="sub">{containerCount} container{containerCount === 1 ? "" : "s"} on this PO</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          <div className="form-grid" style={{ marginBottom: 18 }}>
            <div className="field">
              <label>PO Number</label>
              <input type="text" placeholder="e.g. CIPO-00570" value={poNumber} disabled={anyInwarded}
                onChange={(e) => setPoNumber(e.target.value.toUpperCase())} />
            </div>
            <div className="field">
              <label>Vendor</label>
              <select value={vendorId} disabled={anyInwarded} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">Select</option>
                {vendorOptions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
          </div>
          {anyInwarded && (
            <div className="hint-text" style={{ marginBottom: 12 }}>
              PO Number, Vendor and inwarded containers are locked — their RM pallet QRs already reference them.
            </div>
          )}
          <div className="section-label" style={{ marginTop: 0 }}>Containers</div>
          <GrEntriesEditor items={entries} skuCodes={skuCodes} onChange={setEntries} />
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <div className="sp-foot-right">
            {canSaveDraft && (
              <button className="btn btn-secondary" disabled={!!saving} onClick={() => handleSave(true)}>
                {saving === "draft" ? "Saving…" : "Save Draft"}
              </button>
            )}
            <button className="btn btn-primary" disabled={!!saving} onClick={() => handleSave(false)}>
              {saving === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
