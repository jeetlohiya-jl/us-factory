"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { RqcDetail, RqcDefectResult, Machine } from "@/lib/types";
import { RQC_DEFECT_GROUPS_QMP05, RQC_SAMPLING_PLAN } from "@/lib/types";
import { T } from "@/lib/terms";

// Result badge: computed from Found vs. that defect's own group reject
// threshold, never stored -- same rqcRecalcResult logic as the US Factory
// RQC wizard/detail panel, just against the QMP05-filtered item list.
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

/**
 * Factory OS Module 4 -- "New RQC Record" wizard for the combined RQC + FG
 * QR page. Same 3-page structure, same backend routes (rqc_service.create_rqc
 * / the PUT save route), and same per-activity RqcRecord model as US
 * Factory's own RqcWizard -- the only difference is Page 2's defect list:
 * RQC_DEFECT_GROUPS_QMP05 (the QMP05 spreadsheet's exact 4 items) instead of
 * the full 15-item RQC_DEFECT_GROUPS, plus the QMP05 Sampling Plan shown as
 * a reference table so the user never has to recreate it by hand. Nothing
 * about the backend save route changes: found/remarks are still keyed by
 * defect_sr, and RQC_DEFECT_GROUPS_QMP05's sr values (1, 6, 7, 8) are a
 * subset of the same numbering space rqc_service.has_any_reject already
 * evaluates against the correct per-group thresholds.
 *
 * A Save (final) that computes to 'approved' auto-generates this record's
 * own FG QR Generation batch server-side; onSaved(id) hands the id back to
 * the page so it can immediately look up and show that batch inline.
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
                  type="text" placeholder="e.g. US-SHP-2609-0001" autoFocus
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
                  <Kv label={T.shipmentNumber} value={<span className="mono">{record.shipment_number}</span>} />
                  <Kv label={T.sku} value={record.sku_code ? <span className="mono">{record.sku_code}</span> : "—"} />
                  <Kv label={T.skuVersion} value={record.sku_version} />
                </div>
              </div>

              <div className="detail-card">
                <h3>Sampling Plan (QMP05)</h3>
                <table className="qc-obs-table">
                  <thead>
                    <tr><th>Level</th><th style={{ width: 110 }}>Sample Size</th><th style={{ width: 90 }}>AQL</th><th style={{ width: 130 }}>Accept | Reject</th></tr>
                  </thead>
                  <tbody>
                    {RQC_SAMPLING_PLAN.map((row) => (
                      <tr key={row.level}>
                        <td>{row.level}</td>
                        <td className="mono">{row.sampleSize}</td>
                        <td className="mono">{row.aql}</td>
                        <td className="mono">{row.acceptReject}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="detail-card">
                <h3>RQC Inspection Records</h3>
                <div className="hint-text" style={{ marginBottom: 10, fontWeight: 700, color: "var(--ink-70)" }}>
                  Sample Size: {RQC_DEFECT_GROUPS_QMP05[0].sampleSize}
                </div>
                <div className="field" style={{ maxWidth: 260, marginBottom: 16 }}>
                  <label>Number of Pallets <span style={{ color: "var(--red)" }}>*</span></label>
                  <input
                    type="number" min={0} placeholder="0"
                    value={palletsTested} onChange={(e) => setPalletsTested(e.target.value)}
                  />
                  <div className="hint-text">How many pallets were tested in this activity -- not how many passed (Approved Pallets, Page 3), and not the fixed 800-unit sample size above.</div>
                </div>
                <table className="qc-obs-table">
                  <thead>
                    <tr>
                      <th>Defect Type</th><th>Classification</th><th>Inspection Method</th>
                      <th style={{ width: 120 }}>Defects Found</th><th style={{ width: 120 }}>Result</th><th>Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RQC_DEFECT_GROUPS_QMP05.flatMap((group) =>
                      group.items.map((item) => {
                        const defect = defects[item.sr];
                        return (
                          <tr key={item.sr}>
                            <td>{item.type}</td>
                            <td><span className={`classification-badge ${group.badgeClass}`}>{group.classification}</span></td>
                            <td>Visual inspection</td>
                            <td>
                              <input
                                type="number" placeholder="0"
                                value={defect?.found ?? ""}
                                onChange={(e) => setFound(item.sr, e.target.value)}
                              />
                            </td>
                            <td><ResultBadge found={defect?.found ?? null} reject={group.reject} /></td>
                            <td>
                              <input
                                type="text" placeholder="Add remarks (optional)"
                                value={defect?.remarks ?? ""}
                                onChange={(e) => setRemarks(item.sr, e.target.value)}
                              />
                            </td>
                          </tr>
                        );
                      })
                    )}
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
