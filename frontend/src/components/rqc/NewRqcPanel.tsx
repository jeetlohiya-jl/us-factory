"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

/**
 * "+ New Record" for RQC (manual creation only -- see rqc_service.create_rqc).
 * Single-page panel, matching NewCustomerShipmentPanel's convention: only
 * Shipment Number (required, unique -- the business key used to look up
 * the linked Production Run / IPQC record) and an optional Manufacturer
 * name. Everything else (SKU Code/Version, traceability, the defect grid,
 * COA observations) is filled in afterward, in the same RqcDetailPanel
 * every other RQC record uses.
 *
 * Cancel never calls the API at all -- nothing is created until Save, so
 * there is nothing to discard.
 */
export default function NewRqcPanel({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [shipmentNumber, setShipmentNumber] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!shipmentNumber.trim()) {
      setError("Shipment Number is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.createRqc({ shipment_number: shipmentNumber.trim(), manufacturer: manufacturer.trim() || null });
      onCreated(res.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to create record");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>New RQC Record</h2></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label>Shipment Number <span style={{ color: "var(--red)" }}>*</span></label>
              <input
                type="text" placeholder="e.g. US-SHP-2609-0001"
                value={shipmentNumber} onChange={(e) => setShipmentNumber(e.target.value)}
              />
              <div className="hint-text">Used to identify the linked Production Run / IPQC record, if one already exists.</div>
            </div>
            <div className="field">
              <label>Manufacturer Name</label>
              <input
                type="text" placeholder="e.g. Cirkla Manufacturing"
                value={manufacturer} onChange={(e) => setManufacturer(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Creating…" : "Save"}</button>
        </div>
      </div>
    </>
  );
}
