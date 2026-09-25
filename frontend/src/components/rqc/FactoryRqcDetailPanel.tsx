"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { RqcDetail, RqcDefectResult, Machine } from "@/lib/types";
import { RQC_DEFECT_GROUPS_QMP05, RQC_SAMPLING_PLAN } from "@/lib/types";
import HoldReleaseSection from "@/components/HoldReleaseSection";
import { T } from "@/lib/terms";

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
 */
export default function FactoryRqcDetailPanel({
  record, onClose, machineCode, hasFgQr, onViewFgQr, onOpenCoa, mode, canEdit, canDelete, onEdit, onDelete, onSaved,
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
}) {
  const editable = mode === "edit" && canEdit;

  const [defects, setDefects] = useState<Record<number, RqcDefectResult>>(
    Object.fromEntries(record.defect_results.map((d) => [d.defect_sr, d]))
  );
  const [overallResult, setOverallResult] = useState(record.overall_result || "");
  const [palletsTested, setPalletsTested] = useState(record.pallets_tested != null ? String(record.pallets_tested) : "");
  const [activityDate, setActivityDate] = useState(record.activity_date || "");
  const [activityShift, setActivityShift] = useState(record.shift || "");
  const [machineId, setMachineId] = useState(record.machine_id || "");
  const [approvedPallets, setApprovedPallets] = useState(record.fg_pallets_generated != null ? String(record.fg_pallets_generated) : "");
  const [tablePersonNumber, setTablePersonNumber] = useState(record.table_person_number || "");
  const [allMachines, setAllMachines] = useState<Machine[]>([]);
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const machineOptions: { id: string; code: string }[] =
    record.production_run_machines.length > 0 ? record.production_run_machines : allMachines;

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
      await api.saveRqc(record.id, {
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

          <div className="detail-card">
            <h3>Product and Shipment Details</h3>
            <div className="detail-grid">
              <Kv label={T.shipmentNumber} value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
              <Kv label={T.sku} value={record.sku_code ? <span className="mono">{record.sku_code}</span> : "—"} />
              <Kv label="Manufacturer" value={record.manufacturer || "—"} />
              <Kv label="Status" value={<StatusBadge status={record.status} />} />
            </div>
          </div>

          <div className="detail-card">
            <h3>Approval</h3>
            {editable ? (
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
                  <label>Number of Pallets (Tested)</label>
                  <input type="number" min={0} placeholder="0" value={palletsTested} onChange={(e) => setPalletsTested(e.target.value)} />
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
                <Kv label="Date" value={record.activity_date} />
                <Kv label="Machine" value={machineCode ? <span className="mono">{machineCode}</span> : "—"} />
                <Kv label="Shift" value={record.activity_shift} />
                <Kv label="Number of Pallets (Tested)" value={record.pallets_tested} />
                <Kv label="Approved Pallets" value={record.fg_pallets_generated} />
                <Kv label="RQC Table/Person Number" value={record.table_person_number} />
              </div>
            )}
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
                          {editable ? (
                            <input type="number" placeholder="0" value={defect?.found ?? ""} onChange={(e) => setFound(item.sr, e.target.value)} />
                          ) : (defect?.found ?? "—")}
                        </td>
                        <td><ResultBadge found={defect?.found ?? null} reject={group.reject} /></td>
                        <td>
                          {editable ? (
                            <input type="text" placeholder="Add remarks (optional)" value={defect?.remarks ?? ""} onChange={(e) => setRemarks(item.sr, e.target.value)} />
                          ) : (defect?.remarks || "—")}
                        </td>
                      </tr>
                    );
                  })
                )}
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
