"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { T } from "@/lib/terms";

/**
 * "+ New Record" for IPQC (manual creation -- see ipqc_service.create_ipqc).
 * Mirrors NewRqcPanel exactly: a single-page panel with just Shipment
 * Number (optional here, unlike RQC's required/unique one -- IPQC has
 * never had a uniqueness constraint on it) and an optional Manufacturer
 * name. Everything else (SKU Code/Version, Shift Incharge, the Check Time
 * blocks) is filled in afterward, in the same IpqcDetailPanel every other
 * IPQC record uses. This is purely additive -- the existing auto-created,
 * production-linked workflow (Material Consumption finalize ->
 * find_or_create_ipqc) is completely unchanged.
 *
 * Cancel never calls the API at all -- nothing is created until Save, so
 * there is nothing to discard.
 */
export default function NewIpqcPanel({
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
    setSaving(true);
    setError(null);
    try {
      const res = await api.createIpqc({ shipment_number: shipmentNumber.trim() || null, manufacturer: manufacturer.trim() || null });
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
          <div><h2>New IPQC Record</h2></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label>{T.shipmentNumber}</label>
              <input
                type="text" placeholder="e.g. US-SHP-2609-0001"
                value={shipmentNumber} onChange={(e) => setShipmentNumber(e.target.value)}
              />
              <div className="hint-text">Optional -- used to identify the linked Production Run, if one already exists.</div>
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
