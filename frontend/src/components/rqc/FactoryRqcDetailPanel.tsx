"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { RqcDetail, RqcDefectResult, Machine } from "@/lib/types";
import { RQC_DEFECT_ITEMS_FACTORY, RQC_CLASSIFICATION_SUMMARY_FACTORY } from "@/lib/types";
import HoldReleaseSection from "@/components/HoldReleaseSection";

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "approved" ? "approved" : status === "hold" ? "hold" : status === "pending" ? "pending" : "draft";
  return <span className={`badge ${cls}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

// This workstation's own local clock, not the backend's (which can run
// anywhere) -- same reasoning as material-consumption/Wizard.tsx's
// nowHHMM(). Inspection Date almost always IS today, so the field starts
// pre-filled instead of making the operator pick a date every time; it
// stays a normal editable input for the rare backdated entry.
function todayYMD(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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

// Classification-level "Total Defects Found" + "Result" on the sheet's own
// Classification / Sampling Plan table -- summed from whatever's entered
// against that classification's own items in the inspection grid above.
// Minor has no items in this plan at all (see RQC_CLASSIFICATION_SUMMARY_
// FACTORY's own comment), so it always reads "–" / "N/A", exactly as
// printed on the sheet, never computed.
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
 * Factory OS Module 4 -- view/edit of one already-saved RQC activity record
 * (a completed FactoryRqcWizard run). Same "view" vs "edit" mode split as
 * the US Factory RqcDetailPanel: "view" is pure traceability/review;
 * "edit" reopens Page 2/3's own fields (defect grid, Number of Pallets,
 * Date/Machine/Shift/Approved Pallets/Table-Person) for correction and
 * re-saves through the same PUT route the wizard's own final Save uses
 * (api.saveRqc) -- now additionally guarded server-side
 * (rqc_service.blocked_edit_reason) once this record's FG QR batch has
 * already been generated, surfaced here as a disabled Edit button plus an
 * inline note rather than a raw 409 the user has to decode.
 *
 * 2026-09-24: Hold & Release is wired in exactly like the non-Factory
 * RqcDetailPanel -- whenever record.status is "hold", HoldReleaseSection
 * renders above everything else so a held record's hold/release workflow
 * is reachable from this page, not just the shared (non-Factory) /rqc page.
 *
 * 2026-09-28 -- redesigned to match the "FINISHED GOODS RANDOM QUALITY
 * ASSURANCE PLAN -- PADDED TRAYS" sheet (V0, 27/09/2026) exactly: Product &
 * Shipment Details up top (Product Name, Product Code, Container/Vehicle
 * Number [=Shipment Number -- there is no separate outbound container
 * concept at RQC time], No. of Pallets, No. of Trays, Inspection Date),
 * the sheet's own 5-item defect list (RQC_DEFECT_ITEMS_FACTORY, replacing
 * the old QMP05-derived 4-item one), and its Classification / Sampling
 * Plan summary table with computed Total Defects Found / Result per
 * classification. Number of Pallets and Inspection Date moved up into the
 * Product & Shipment Details card (previously in Inspection Records /
 * Approval respectively) to match the sheet's own layout; nothing about
 * their validation/gating (inspectionStarted, the Date-required check)
 * changed, only where their inputs render.
 */
export default function FactoryRqcDetailPanel({
  record, onClose, machineCode, hasFgQr, onViewFgQr, onOpenCoa, mode, canEdit, canDelete, onEdit, onDelete, onSaved, onApproved,
}: {
  record: RqcDetail;
  onClose: () => void;
  machineCode: string | null;
  hasFgQr: boolean;
  onViewFgQr: () => void;
  onOpenCoa: () => void;
  mode: "view" | "edit";
  canEdit: boolean;
  canDelete: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onSaved: () => void;
  // 2026-09-28 -- fires (in addition to onSaved) when a Save results in this
  // record's status becoming Approved, so the page can pop the FG QR
  // Generation panel open right away. Optional so nothing else that renders
  // this panel needs to change.
  onApproved?: () => void;
}) {
  const editable = mode === "edit" && canEdit;

  const [defects, setDefects] = useState<Record<number, RqcDefectResult>>(
    Object.fromEntries(record.defect_results.map((d) => [d.defect_sr, d]))
  );
  const [overallResult, setOverallResult] = useState(record.overall_result || "");
  const [palletsTested, setPalletsTested] = useState(record.pallets_tested != null ? String(record.pallets_tested) : "");
  const [activityDate, setActivityDate] = useState(record.activity_date || todayYMD());
  const [activityShift, setActivityShift] = useState(record.shift || "");
  const [machineId, setMachineId] = useState(record.machine_id || "");
  const [approvedPallets, setApprovedPallets] = useState(record.fg_pallets_generated != null ? String(record.fg_pallets_generated) : "");
  const [tablePersonNumber, setTablePersonNumber] = useState(record.table_person_number || "");
  const [allMachines, setAllMachines] = useState<Machine[]>([]);
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const machineOptions: { id: string; code: string }[] =
    record.production_run_machines.length > 0 ? record.production_run_machines : allMachines;

  // Same gate as FactoryRqcWizard's Page 2 -> Page 3 requirement: approval
  // (approved pallets, machine, etc.) isn't recorded until Number of
  // Pallets (the inspection) is actually filled in.
  const inspectionStarted = palletsTested !== "" && Number(palletsTested) > 0;

  useEffect(() => {
    if (editable && record.production_run_machines.length === 0 && allMachines.length === 0) {
      api.machines().then(setAllMachines).catch(() => setAllMachines([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  function setFound(sr: number, value: string) {
    setDefects((prev) => {
      const found = value === "" ? null : Number(value);
      return { ...prev, [sr]: { defect_sr: sr, found, remarks: prev[sr]?.remarks ?? null } };
    });
  }
  function setRemarks(sr: number, value: string) {
    setDefects((prev) => ({ ...prev, [sr]: { defect_sr: sr, found: prev[sr]?.found ?? null, remarks: value } }));
  }

  async function handleSave(saveMode: "draft" | "final") {
    setError(null);
    if (saveMode === "final") {
      if (!activityDate) { setError("Date is required."); return; }
      if (!machineId) { setError("Select which Machine these pallets came from."); return; }
      const tested = palletsTested === "" ? 0 : Number(palletsTested);
      const approved = approvedPallets === "" ? 0 : Number(approvedPallets);
      if (approved > tested) {
        setError(`Approved Pallets (${approved}) cannot exceed Number of Pallets (tested) (${tested}).`);
        return;
      }
    }
    setSaving(saveMode);
    try {
      const result = await api.saveRqc(record.id, {
        manufacturer: record.manufacturer || null,
        overall_result: overallResult || null,
        fg_pallets_generated: approvedPallets === "" ? null : Number(approvedPallets),
        table_person_number: tablePersonNumber || null,
        pallets_tested: palletsTested === "" ? null : Number(palletsTested),
        machine_id: machineId || null,
        shift: activityShift || null,
        activity_date: activityDate || null,
        save_mode: saveMode,
        defect_results: Object.values(defects).filter((d) => d.found !== null || !!d.remarks),
        coa_observations: record.coa_observations,
      });
      onSaved();
      onClose();
      // 2026-09-28 -- pop up the FG QR Generation panel right away once this
      // save lands on Approved, instead of leaving the operator to notice
      // and click "View / Print ->" in Traceability on their own.
      if (result.status === "approved" && onApproved) onApproved();
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
            <h2>RQC Record</h2>
            <div className="sub mono">{record.shipment_number || record.id.slice(0, 8)}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {record.status === "hold" && (
            <HoldReleaseSection module="rqc" recordId={record.id} canFill={canEdit} />
          )}

          {/* 2026-09-28: hidden entirely while still Pending, per explicit
              direction -- a still-Pending record has nothing to reference
              yet (nothing's been inspected), so this card was just more
              text between the operator and the one thing they're actually
              here to do (see "Fill In To Begin" below). Once no longer
              Pending, it's the real record's reference facts and shows as
              before. */}
          {record.status !== "pending" && (
            <div className="detail-card">
              <h3>Product and Shipment Details</h3>
              <div className="detail-grid">
                <Kv label="Product Name" value={record.product_name || "—"} />
                <Kv label="Product Code" value={record.sku_code ? <span className="mono">{record.sku_code}</span> : "—"} />
                <Kv label="Container/Vehicle Number" value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
                <Kv label="No. of Trays" value={record.no_of_trays != null ? record.no_of_trays.toLocaleString() : "—"} />
                <Kv label="Manufacturer" value={record.manufacturer || "—"} />
                <Kv label="Status" value={<StatusBadge status={record.status} />} />
                {!editable && <Kv label="No. of Pallets Checked" value={record.pallets_tested} />}
                {!editable && <Kv label="Inspection Date" value={record.activity_date} />}
              </div>
            </div>
          )}

          {editable && (
            <div className="detail-card">
              <h3>Fill In To Begin</h3>
              <div className="detail-grid">
                <div className="field">
                  <label>No. of Pallets Checked <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="number" min={0} placeholder="0" value={palletsTested} onChange={(e) => setPalletsTested(e.target.value)} />
                </div>
                <div className="field">
                  <label>Inspection Date <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="date" value={activityDate} onChange={(e) => setActivityDate(e.target.value)} />
                </div>
              </div>
            </div>
          )}

          {/* RQC Inspection Records comes before Approval -- same order as
              FactoryRqcWizard's own Page 2 (Inspection) then Page 3
              (Approval): approved pallets should only ever be recorded
              once the inspection grid is actually filled in, not before. */}
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
                        {editable ? (
                          <input type="number" placeholder="0" value={defect?.found ?? ""} onChange={(e) => setFound(item.sr, e.target.value)} />
                        ) : (defect?.found ?? "—")}
                      </td>
                      <td><ResultBadge found={defect?.found ?? null} reject={item.reject} /></td>
                      <td>
                        {editable ? (
                          <input type="text" placeholder={item.remarksHint || "Add remarks (optional)"} value={defect?.remarks ?? ""} onChange={(e) => setRemarks(item.sr, e.target.value)} />
                        ) : (defect?.remarks || (item.remarksHint ? <span className="hint-text">{item.remarksHint}</span> : "—"))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="field" style={{ marginTop: 16, maxWidth: 320 }}>
              <label>Overall Result</label>
              {editable ? (
                <input type="text" value={overallResult} onChange={(e) => setOverallResult(e.target.value)} />
              ) : (
                <div className="detail-kv-value">{record.overall_result || "—"}</div>
              )}
            </div>
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

          <div className="detail-card">
            <h3>Approval</h3>
            {editable && !inspectionStarted ? (
              <div className="hint-text">Fill in No. of Pallets and the Quality Inspection Details above first -- approval is recorded once the inspection is filled in.</div>
            ) : editable ? (
              <div className="detail-grid">
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
                  <label>Approved Pallets{palletsTested !== "" && ` (max ${palletsTested})`}</label>
                  <input
                    type="number" min={0} max={palletsTested === "" ? undefined : Number(palletsTested)} placeholder="0"
                    value={approvedPallets} onChange={(e) => setApprovedPallets(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>RQC Table/Person Number</label>
                  <input type="text" placeholder="e.g. 1" value={tablePersonNumber} onChange={(e) => setTablePersonNumber(e.target.value)} />
                </div>
              </div>
            ) : (
              <div className="detail-grid">
                <Kv label="Machine" value={machineCode ? <span className="mono">{machineCode}</span> : "—"} />
                <Kv label="Shift" value={record.activity_shift} />
                <Kv label="Approved Pallets" value={record.fg_pallets_generated} />
                <Kv label="RQC Table/Person Number" value={record.table_person_number} />
              </div>
            )}
          </div>

          <div className="detail-card">
            <h3>Traceability</h3>
            <div className="detail-grid">
              <Kv
                label="Production Run"
                value={record.production_run_number ? (
                  <a className="mono" href={`/production?open=${record.production_run_id}`} style={{ textDecoration: "underline" }}>
                    {record.production_run_number} →
                  </a>
                ) : "—"}
              />
              <Kv
                label="FG QR"
                value={
                  hasFgQr ? (
                    <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={onViewFgQr}>View / Print →</a>
                  ) : record.status === "approved" ? "Generating…" : "—"
                }
              />
              <Kv
                label="Certificate of Analysis"
                value={<a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={onOpenCoa}>Open COA →</a>}
              />
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          {editable ? (
            <div className="sp-foot-right">
              <button className="btn btn-secondary" disabled={saving !== null} onClick={() => handleSave("draft")}>
                {saving === "draft" ? "Saving…" : "Save Draft"}
              </button>
              <button className="btn btn-primary" disabled={saving !== null} onClick={() => handleSave("final")}>
                {saving === "final" ? "Saving…" : "Save"}
              </button>
            </div>
          ) : (
            <div className="sp-foot-right">
              {canDelete && onDelete && (
                <button className="btn btn-secondary" onClick={onDelete}>Delete</button>
              )}
              {canEdit && onEdit && (
                <button className="btn btn-primary" onClick={onEdit}>Edit</button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
