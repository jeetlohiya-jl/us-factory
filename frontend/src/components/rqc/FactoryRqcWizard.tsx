"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { RqcDetail, RqcDefectResult, Machine } from "@/lib/types";
import { RQC_DEFECT_ITEMS_FACTORY, RQC_CLASSIFICATION_SUMMARY_FACTORY } from "@/lib/types";

// Result badge: computed from Found vs. that defect's own reject threshold,
// never stored -- same rqcRecalcResult logic as the US Factory RQC wizard/
// detail panel, just against the Factory item list.
function ResultBadge({ found, reject }: { found: number | null; reject: number }) {
  if (found === null || Number.isNaN(found)) return <span className="result-badge pending">–</span>;
  const isNotOk = found >= reject;
  return (
    <span className={`result-badge ${isNotOk ? "notok" : "ok"}`}>
      {isNotOk ? "NOT OK" : "OK"}
      <span className="calc-tag">calc</span>
    </span>
  );
}

// Same classification-level rollup as FactoryRqcDetailPanel's own
// classificationTotal -- kept in sync manually, same convention as the two
// panels' already-duplicated defect-grid rendering.
function classificationTotal(classification: string, defects: Record<number, RqcDefectResult>): number | null {
  const items = RQC_DEFECT_ITEMS_FACTORY.filter((i) => i.classification === classification);
  if (items.length === 0) return null;
  let total = 0;
  let any = false;
  for (const item of items) {
    const found = defects[item.sr]?.found;
    if (found !== null && found !== undefined) { total += found; any = true; }
  }
  return any ? total : 0;
}

/**
 * Factory OS Module 4 -- "New RQC Record" wizard for the combined RQC + FG
 * QR page. Same 3-page structure, same backend routes (rqc_service.create_rqc
 * / the PUT save route), and same per-activity RqcRecord model as US
 * Factory's own RqcWizard -- the only difference is Page 2's defect list:
 * RQC_DEFECT_ITEMS_FACTORY (2026-09-28, the "FINISHED GOODS RANDOM QUALITY
 * ASSURANCE PLAN -- PADDED TRAYS" sheet's own 5 items) instead of the full
 * 15-item RQC_DEFECT_GROUPS, plus its Classification / Sampling Plan summary
 * shown as a reference table so the user never has to recreate it by hand.
 * Nothing about the backend save route changes: found/remarks are still
 * keyed by defect_sr, and RQC_DEFECT_ITEMS_FACTORY's sr values (101-105) are
 * a fresh, independent numbering space rqc_service.has_any_reject already
 * evaluates against the correct thresholds (_REJECT_BY_SR_FACTORY).
 *
 * A Save (final) that computes to 'approved' auto-generates this record's
 * own FG QR Generation batch server-side; onSaved(id) hands the id back to
 * the page so it can immediately look up and show that batch inline (and,
 * as of 2026-09-28, pop the FG QR Generation panel open automatically).
 */
export default function FactoryRqcWizard({
  onClose, onSaved,
}: {
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [page, setPage] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<string | null>(null);

  // Page 1 state.
  const [shipmentNumber, setShipmentNumber] = useState("");
  const [creating, setCreating] = useState(false);
  const [record, setRecord] = useState<RqcDetail | null>(null);

  // Page 2 state.
  const [defects, setDefects] = useState<Record<number, RqcDefectResult>>({});
  const [palletsTested, setPalletsTested] = useState("");

  // Page 3 state.
  const [activityDate, setActivityDate] = useState("");
  const [allMachines, setAllMachines] = useState<Machine[]>([]);
  const [machineId, setMachineId] = useState("");
  const [activityShift, setActivityShift] = useState("");
  const [approvedPallets, setApprovedPallets] = useState("");
  const [tablePersonNumber, setTablePersonNumber] = useState("");
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);

  function setFound(sr: number, value: string) {
    setDefects((prev) => {
      const found = value === "" ? null : Number(value);
      return { ...prev, [sr]: { defect_sr: sr, found, remarks: prev[sr]?.remarks ?? null } };
    });
  }
  function setRemarks(sr: number, value: string) {
    setDefects((prev) => ({ ...prev, [sr]: { defect_sr: sr, found: prev[sr]?.found ?? null, remarks: value } }));
  }

  async function handleNextFromPage1() {
    if (!shipmentNumber.trim()) { setError("Shipment Number is required."); return; }
    setError(null);
    setCreating(true);
    try {
      const created = await api.createRqc({ shipment_number: shipmentNumber.trim(), manufacturer: null });
      const rec = await api.getRqc(created.id);
      setRecord(rec);
      setActivityDate(rec.date || "");
      setActivityShift(rec.shift || "");
      setTablePersonNumber(rec.table_person_number || "");
      if (rec.production_run_machines.length === 1) setMachineId(rec.production_run_machines[0].id);
      if (rec.production_run_machines.length === 0) {
        try { setAllMachines(await api.machines()); } catch { setAllMachines([]); }
      }
      setPage(2);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to create record");
    } finally {
      setCreating(false);
    }
  }

  function handleNextFromPage2() {
    if (palletsTested === "" || Number(palletsTested) <= 0) {
      setError("Number of Pallets is required.");
      return;
    }
    setError(null);
    setPage(3);
  }

  const machineOptions: { id: string; code: string }[] =
    (record?.production_run_machines.length || 0) > 0 ? record!.production_run_machines : allMachines;

  async function handleSave(saveMode: "draft" | "final") {
    if (!record) return;
    setError(null);
    if (saveMode === "final") {
      if (!activityDate) { setError("Date is required."); return; }
      if (!machineId) { setError("Select which Machine these pallets came from."); return; }
      if (approvedPallets === "" || Number(approvedPallets) < 0) { setError("Approved Pallets is required."); return; }
      const tested = Number(palletsTested) || 0;
      if (Number(approvedPallets) > tested) {
        setError(`Approved Pallets (${approvedPallets}) cannot exceed Number of Pallets tested (${tested}).`);
        return;
      }
    }
    setSaving(saveMode);
    try {
      await api.saveRqc(record.id, {
        manufacturer: null,
        overall_result: null,
        fg_pallets_generated: approvedPallets === "" ? null : Number(approvedPallets),
        table_person_number: tablePersonNumber || null,
        pallets_tested: palletsTested === "" ? null : Number(palletsTested),
        machine_id: machineId || null,
        shift: activityShift || null,
        activity_date: activityDate || null,
        save_mode: saveMode,
        defect_results: Object.values(defects).filter((d) => d.found !== null || !!d.remarks),
        coa_observations: [],
      });
      onSaved(record.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to save record");
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>New RQC Record</h2>
            <div className="sub mono">
              Page {page} of 3 — {page === 1 ? "Shipment" : page === 2 ? "Inspection" : "Approval"}
            </div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}

          {page === 1 && (
            <div className="form-grid">
              <div className="field">
                <label>Shipment Number <span style={{ color: "var(--red)" }}>*</span></label>
                <input
                  type="text" placeholder="e.g. A1" autoFocus
                  value={shipmentNumber} onChange={(e) => setShipmentNumber(e.target.value)}
                />
                <div className="hint-text">Used to identify the linked Production Run, if one already exists. A shipment can have many RQC activity records over time, across different dates.</div>
              </div>
              <div className="field">
                <label>Manufacturer</label>
                <div className="detail-kv-value">Cirkla INC</div>
              </div>
            </div>
          )}

          {page === 2 && record && (
            <>
              <div className="detail-card">
                <h3>Product and Shipment Details</h3>
                <div className="detail-grid">
                  <Kv label="Product Name" value={record.product_name || "—"} />
                  <Kv label="Product Code" value={record.sku_code ? <span className="mono">{record.sku_code}</span> : "—"} />
                  <Kv label="Container/Vehicle Number" value={<span className="mono">{record.shipment_number}</span>} />
                  <div className="field">
                    <label>No. of Pallets <span style={{ color: "var(--red)" }}>*</span></label>
                    <input
                      type="number" min={0} placeholder="0"
                      value={palletsTested} onChange={(e) => setPalletsTested(e.target.value)}
                    />
                    <div className="hint-text">How many pallets were tested in this activity -- not how many passed (Approved Pallets, Page 3), and not the fixed 800-unit sample size below.</div>
                  </div>
                </div>
              </div>

              <div className="detail-card">
                <h3>Quality Inspection Details</h3>
                <div className="hint-text" style={{ marginBottom: 10, fontWeight: 700, color: "var(--ink-70)" }}>
                  Sample Size: {RQC_DEFECT_ITEMS_FACTORY[0].sampleSize}
                </div>
                <table className="qc-obs-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Defect Type</th><th>Classification</th><th>Inspection Method</th>
                      <th style={{ width: 120 }}>Defects Found</th><th style={{ width: 120 }}>Result</th><th>Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RQC_DEFECT_ITEMS_FACTORY.map((item, idx) => {
                      const defect = defects[item.sr];
                      return (
                        <tr key={item.sr}>
                          <td>{idx + 1}</td>
                          <td>{item.type}</td>
                          <td><span className={`classification-badge ${item.badgeClass}`}>{item.classification}</span></td>
                          <td>{item.method}</td>
                          <td>
                            <input
                              type="number" placeholder="0"
                              value={defect?.found ?? ""}
                              onChange={(e) => setFound(item.sr, e.target.value)}
                            />
                          </td>
                          <td><ResultBadge found={defect?.found ?? null} reject={item.reject} /></td>
                          <td>
                            <input
                              type="text" placeholder={item.remarksHint || "Add remarks (optional)"}
                              value={defect?.remarks ?? ""}
                              onChange={(e) => setRemarks(item.sr, e.target.value)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="detail-card">
                <h3>Classification / Sampling Plan</h3>
                <table className="qc-obs-table">
                  <thead>
                    <tr>
                      <th>Classification</th><th style={{ width: 100 }}>Sample Size</th><th style={{ width: 80 }}>AQL %</th>
                      <th style={{ width: 120 }}>Accept | Reject</th><th style={{ width: 120 }}>Total Defects Found</th><th style={{ width: 100 }}>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RQC_CLASSIFICATION_SUMMARY_FACTORY.map((row) => {
                      const total = classificationTotal(row.classification, defects);
                      return (
                        <tr key={row.classification}>
                          <td><span className={`classification-badge ${row.badgeClass}`}>{row.classification}</span></td>
                          <td className="mono">{row.sampleSize}</td>
                          <td className="mono">{row.aqlLabel}</td>
                          <td className="mono">{row.accept} | {row.reject}</td>
                          <td className="mono">{total ?? "–"}</td>
                          <td>{total === null ? "N/A" : <ResultBadge found={total} reject={row.reject} />}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {page === 3 && record && (
            <div className="detail-card">
              <h3>Approval</h3>
              <div className="detail-grid">
                <div className="field">
                  <label>Date <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="date" value={activityDate} onChange={(e) => setActivityDate(e.target.value)} />
                </div>
                <div className="field">
                  <label>Machine <span style={{ color: "var(--red)" }}>*</span></label>
                  <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                    <option value="">Select a machine…</option>
                    {machineOptions.map((m) => (
                      <option key={m.id} value={m.id}>{m.code}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Shift</label>
                  <input type="text" placeholder="e.g. A" value={activityShift} onChange={(e) => setActivityShift(e.target.value)} />
                </div>
                <div className="field">
                  <label>Approved Pallets{palletsTested !== "" && ` (max ${palletsTested})`} <span style={{ color: "var(--red)" }}>*</span></label>
                  <input
                    type="number" min={0} max={palletsTested === "" ? undefined : Number(palletsTested)} placeholder="0"
                    value={approvedPallets} onChange={(e) => setApprovedPallets(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>RQC Table/Person Number</label>
                  <input
                    type="text" placeholder="e.g. 1"
                    value={tablePersonNumber} onChange={(e) => setTablePersonNumber(e.target.value)}
                  />
                </div>
              </div>
              <div className="hint-text" style={{ marginTop: 10 }}>
                Saving as Approved will automatically generate FG QR codes for the Approved Pallets above.
              </div>
            </div>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>{page === 1 ? "Cancel" : "Close"}</button>
          <div className="sp-foot-right">
            {page > 1 && (
              <button className="btn btn-secondary" disabled={saving !== null} onClick={() => setPage((page - 1) as 1 | 2)}>
                Back
              </button>
            )}
            {page === 1 && (
              <button className="btn btn-primary" disabled={creating} onClick={handleNextFromPage1}>
                {creating ? "Creating…" : "Next"}
              </button>
            )}
            {page === 2 && (
              <button className="btn btn-primary" onClick={handleNextFromPage2}>Next</button>
            )}
            {page === 3 && (
              <>
                <button className="btn btn-secondary" disabled={saving !== null} onClick={() => handleSave("draft")}>
                  {saving === "draft" ? "Saving…" : "Save Draft"}
                </button>
                <button className="btn btn-primary" disabled={saving !== null} onClick={() => handleSave("final")}>
                  {saving === "final" ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}
