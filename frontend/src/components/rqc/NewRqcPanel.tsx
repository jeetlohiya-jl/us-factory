"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

/**
 * "+ New Record" for RQC (manual creation only -- see rqc_service.create_rqc).
 * Single-page panel, matching NewCustomerShipmentPanel's convention: just
 * Shipment Number (required -- no longer unique across RQC records as of
 * the per-activity redesign, see rqc_service.create_rqc; it's only ever
 * used to look up the linked Production Run / IPQC record, and the same
 * shipment can have many RQC activity records over time). Manufacturer is
 * no longer collected here -- it's always "Cirkla INC"
 * (rqc_service.RQC_MANUFACTURER_PLACEHOLDER), set server-side. Everything
 * else (SKU Code/Version, traceability, the defect grid) is filled in
 * afterward, in the same RqcDetailPanel every other RQC record uses.
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
      const res = await api.createRqc({ shipment_number: shipmentNumber.trim(), manufacturer: null });
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
