"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CustomerShipmentLineItemDraft, SkuCode } from "@/lib/types";
import CsLineItemsEditor from "./CsLineItemsEditor";

/**
 * Single-page side panel -- matches the prototype's panel-customer-shipment
 * exactly (spec point 3: "not a wizard"). Shipment Number / Container
 * Number are shown as a non-incrementing preview (spec point 8) as soon as
 * the panel opens, and are never editable; the real numbers are only
 * allocated atomically at save (customer_shipment_service.create_customer_shipment).
 */
export default function NewCustomerShipmentPanel({
  skuCodes, onClose, onSaved,
}: {
  skuCodes: SkuCode[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [customer, setCustomer] = useState("");
  const [preview, setPreview] = useState<{ shipment: string; container: string } | null>(null);
  const [lineItems, setLineItems] = useState<CustomerShipmentLineItemDraft[]>([
    { key: "li-0", sku_code_id: null, sku_version_id: null, pallets_required: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.peekNextCsNumbers().then(setPreview).catch(() => setPreview(null));
  }, []);

  const validItems = lineItems.filter(
    (li) => li.sku_code_id && li.sku_version_id && Number(li.pallets_required) > 0
  );

  async function handleSave() {
    if (!customer.trim()) {
      setError("Customer / Recipient is required.");
      return;
    }
    if (validItems.length === 0) {
      setError("At least one line item with a SKU, Version and No. of Pallets is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createCustomerShipment({
        customer: customer.trim(),
        line_items: validItems.map((li) => ({
          sku_code_id: li.sku_code_id as string,
          sku_version_id: li.sku_version_id as string,
          pallets_required: Number(li.pallets_required),
        })),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Customer Shipment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="side-panel open" id="panel-customer-shipment">
      <div className="sp-head">
        <div><h2>New Customer Shipment</h2></div>
        <button className="sp-close" onClick={onClose}>×</button>
      </div>
      <div className="sp-body">
        {error && <div className="error-banner">{error}</div>}
        <div className="form-grid" style={{ marginBottom: 18 }}>
          <div className="field">
            <label>Customer / Recipient</label>
            <input type="text" placeholder="e.g. 3P China" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </div>
          <div className="field">
            <label>Shipment Number</label>
            <div className="readonly-val">{preview?.shipment ?? "…"}</div>
          </div>
          <div className="field">
            <label>Container Number</label>
            <div className="readonly-val">{preview?.container ?? "…"}</div>
          </div>
        </div>
        <div className="section-label" style={{ marginTop: 0 }}>Line Items</div>
        <CsLineItemsEditor items={lineItems} skuCodes={skuCodes} onChange={setLineItems} />
      </div>
      <div className="sp-foot">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <div className="sp-foot-right">
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
