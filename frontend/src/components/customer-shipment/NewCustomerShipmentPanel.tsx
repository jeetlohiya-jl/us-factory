"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Customer, CustomerShipmentLineItemDraft, GoodsOutwardDetail, SkuCode } from "@/lib/types";
import CsLineItemsEditor from "./CsLineItemsEditor";

/**
 * Single-page side panel -- matches the prototype's panel-customer-shipment
 * exactly (spec point 3: "not a wizard"). Shipment Number is manually
 * entered by the user (corrected per explicit feedback -- it's a real-
 * world identifier the customer/forwarder supplies, not something this
 * app should invent); Container Number is still shown as a non-
 * incrementing preview as soon as the panel opens and stays read-only --
 * it's a genuine internal auto-allocation, only allocated atomically at
 * save (customer_shipment_service.create_customer_shipment).
 *
 * 2026-09-24 -- Goods Outward Edit: this same panel now doubles as the edit
 * form when `editTarget` is passed (an already-saved GoodsOutwardDetail).
 * Only what's genuinely different in edit mode changes: fields prefill
 * from the existing record instead of starting blank, each line item
 * carries its real `id` (see CustomerShipmentLineItemDraft) so the PUT
 * payload can diff by id, and Save calls api.updateCustomerShipment
 * instead of api.createCustomerShipment. A line item that already has FG
 * pallets picked against it is still fully editable here -- the 409 that
 * comes back from a blocked change (SKU/Version/Quantity change or
 * removal) is surfaced as this panel's own error banner, same as any other
 * save failure; nothing here tries to pre-emptively lock those rows, since
 * an operator correcting an unrelated line item shouldn't be blocked from
 * saving at all.
 *
 * Container Number is still allocated atomically at save (customer_
 * shipment_service.create_customer_shipment) -- it's just no longer shown
 * anywhere in this UI (2026-09-24): it exists purely for internal table
 * relationships/traceability, not something an operator needs to see or
 * act on here.
 *
 * Customer / Recipient is a dropdown (2026-09-24) backed by the Customer
 * master list (api.customers, managed from /customers) instead of a
 * freehand text field, so shipments consistently reuse the same customer
 * names. "+ Add new customer" reveals an inline text field so an operator
 * with edit rights doesn't have to leave this panel to add one on the fly.
 */
export default function NewCustomerShipmentPanel({
  skuCodes, onClose, onSaved, editTarget,
}: {
  skuCodes: SkuCode[];
  onClose: () => void;
  onSaved: () => void;
  editTarget?: GoodsOutwardDetail | null;
}) {
  const isEdit = !!editTarget;
  const [customer, setCustomer] = useState(editTarget?.customer || "");
  const [shipmentNumber, setShipmentNumber] = useState(editTarget?.shipment_number || "");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [lineItems, setLineItems] = useState<CustomerShipmentLineItemDraft[]>(
    editTarget && editTarget.line_items.length > 0
      ? editTarget.line_items.map((li) => ({
          key: li.id,
          id: li.id,
          sku_code_id: li.sku_code_id,
          sku_version_id: li.sku_version_id,
          pallets_required: li.pallets_required,
          pcs: li.pcs ?? "",
          pcs_per_sleeve: li.pcs_per_sleeve || "",
        }))
      : [{ key: "li-0", sku_code_id: null, sku_version_id: null, pallets_required: "", pcs: "", pcs_per_sleeve: "" }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit) {
      // Container Number is still allocated at save time -- previewing it
      // is no longer needed since it's not shown anywhere in this panel.
    }
    api.customers().then(setCustomers).catch(() => setCustomers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAddCustomer() {
    const name = newCustomerName.trim();
    if (!name) return;
    setCustomerError(null);
    try {
      const created = await api.createCustomer(name);
      setCustomers((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setCustomer(created.name);
      setNewCustomerName("");
      setAddingCustomer(false);
    } catch (e) {
      setCustomerError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to add customer");
    }
  }

  const validItems = lineItems.filter(
    (li) => li.sku_code_id && li.sku_version_id && Number(li.pallets_required) > 0
  );

  async function handleSave() {
    if (!customer.trim()) {
      setError("Customer / Recipient is required.");
      return;
    }
    if (!shipmentNumber.trim()) {
      setError("Shipment Number is required.");
      return;
    }
    if (validItems.length === 0) {
      setError("At least one line item with a SKU, Version and Quantity is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit && editTarget) {
        await api.updateCustomerShipment(editTarget.id, {
          customer: customer.trim(),
          shipment_number: shipmentNumber.trim(),
          line_items: validItems.map((li) => ({
            id: li.id || null,
            sku_code_id: li.sku_code_id as string,
            sku_version_id: li.sku_version_id as string,
            pallets_required: Number(li.pallets_required),
            pcs: li.pcs === "" ? null : Number(li.pcs),
            pcs_per_sleeve: li.pcs_per_sleeve || null,
          })),
        });
      } else {
        await api.createCustomerShipment({
          customer: customer.trim(),
          shipment_number: shipmentNumber.trim(),
          line_items: validItems.map((li) => ({
            sku_code_id: li.sku_code_id as string,
            sku_version_id: li.sku_version_id as string,
            pallets_required: Number(li.pallets_required),
            pcs: li.pcs === "" ? null : Number(li.pcs),
            pcs_per_sleeve: li.pcs_per_sleeve || null,
          })),
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : `Failed to save ${isEdit ? "changes" : "Customer Shipment"}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="side-panel open" id="panel-customer-shipment">
      <div className="sp-head">
        <div><h2>{isEdit ? "Edit Goods Outward Record" : "New Customer Shipment"}</h2></div>
        <button className="sp-close" onClick={onClose}>×</button>
      </div>
      <div className="sp-body">
        {error && <div className="error-banner">{error}</div>}
        <div className="form-grid" style={{ marginBottom: 18 }}>
          <div className="field">
            <label>Customer / Recipient</label>
            {addingCustomer ? (
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text" autoFocus placeholder="New customer name" value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddCustomer()}
                />
                <button type="button" className="btn btn-secondary" onClick={handleAddCustomer}>Add</button>
                <button type="button" className="btn btn-ghost" onClick={() => { setAddingCustomer(false); setNewCustomerName(""); setCustomerError(null); }}>Cancel</button>
              </div>
            ) : (
              <select
                value={customer}
                onChange={(e) => {
                  if (e.target.value === "__add__") { setAddingCustomer(true); return; }
                  setCustomer(e.target.value);
                }}
              >
                <option value="">Select</option>
                {customer && !customers.some((c) => c.name === customer) && (
                  <option value={customer}>{customer}</option>
                )}
                {customers.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                <option value="__add__">+ Add new customer…</option>
              </select>
            )}
            {customerError && <div className="hint-text" style={{ color: "var(--red)" }}>{customerError}</div>}
          </div>
          <div className="field">
            <label>Shipment Number</label>
            <input type="text" placeholder="e.g. US-SHP-2609-0001" value={shipmentNumber} onChange={(e) => setShipmentNumber(e.target.value)} />
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
