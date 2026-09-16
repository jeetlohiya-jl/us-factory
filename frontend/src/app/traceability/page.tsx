"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";

/**
 * Section 15 -- PDF Export by Shipment Number. A single-purpose page: type
 * a Shipment Number, download the full traceability-chain PDF for it. No
 * module permission gate (matching the backend endpoint, which is only
 * gated on being logged in) since this spans every module and has no
 * single natural owner -- any user who could already see the individual
 * stages by visiting each module can see them combined here.
 */
export default function TraceabilityPage() {
  const [shipmentNumber, setShipmentNumber] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    const sn = shipmentNumber.trim();
    if (!sn) return;
    setDownloading(true);
    setError(null);
    try {
      await api.exportTraceabilityPdf(sn);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to generate the traceability PDF");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Traceability</h1>
          <div className="desc">
            Export the full traceability chain for a Shipment Number -- Inward Vehicle Inspection through
            Shipment Picking -- as a single PDF. Stages not yet recorded for the Shipment Number are shown
            as not-yet-available rather than blocking the export.
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ maxWidth: 480, padding: 18 }}>
        <div className="section-label">Export by Shipment Number</div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>Shipment Number</label>
            <input
              value={shipmentNumber}
              placeholder="e.g. D4"
              onChange={(e) => setShipmentNumber(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !downloading && handleExport()}
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={!shipmentNumber.trim() || downloading}
            onClick={handleExport}
          >
            {downloading ? "Generating…" : "Export PDF"}
          </button>
        </div>
      </div>
    </>
  );
}
