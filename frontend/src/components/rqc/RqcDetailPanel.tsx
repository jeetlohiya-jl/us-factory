"use client";
import { useState } from "react";
import Link from "next/link";
import type { RqcDetail, RqcDefectResult, RqcCoaObservation } from "@/lib/types";
import { RQC_DEFECT_GROUPS, RQC_COA_BASE, RQC_COA_FUNCTIONAL, RQC_COA_PACKING, RQC_COA_PRINTING } from "@/lib/types";
import type { RqcCoaParamDef } from "@/lib/types";
import { api } from "@/lib/api";
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

// Result badge: computed from Found vs. that defect's own group reject
// threshold, never stored -- matches rqcRecalcResult exactly.
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

function coaKey(group: string, sr: number) {
  return `${group}:${sr}`;
}

function coaListToMap(observations: RqcCoaObservation[]): Record<string, RqcCoaObservation> {
  return Object.fromEntries(observations.map((o) => [coaKey(o.coa_group, o.sr), o]));
}

function CoaTable({
  title, group, params, values, editable, onChange,
}: {
  title: string;
  group: string;
  params: RqcCoaParamDef[];
  values: Record<string, RqcCoaObservation>;
  editable: boolean;
  onChange: (group: string, sr: number, value: string) => void;
}) {
  return (
    <div className="detail-card">
      <h3>{title}</h3>
      <table className="qc-obs-table">
        <thead>
          <tr><th>Parameter</th><th>Specification</th><th>Observation</th></tr>
        </thead>
        <tbody>
          {params.map((p) => {
            const obs = values[coaKey(group, p.sr)];
            return (
              <tr key={p.sr}>
                <td>{p.param}</td>
                <td>{p.spec}</td>
                <td>
                  {editable ? (
                    <input
                      type="text" placeholder="Observation"
                      value={obs?.observation ?? ""}
                      onChange={(e) => onChange(group, p.sr, e.target.value)}
                    />
                  ) : (obs?.observation || "—")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * RQC (Final Quality Control) detail view, opened in one of two modes (a
 * pencil-icon "Edit" and a separate "View" action on the list row, since
 * these records are always auto-created -- there's no "New Record" flow to
 * fold this into):
 *
 * - "edit": the focused fill-in form -- Manufacturer + the fixed 15-item
 *   defect grid (one flat table spanning all 4 classification groups,
 *   matching the prototype's own single rqc-defects-body exactly -- not
 *   grouped into per-classification boxes) + the 4 COA parameter tables +
 *   Overall Result. Every row's Result, and the record's overall Approved/
 *   Hold status, are always computed from the sampling plan's own per-
 *   classification accept/reject thresholds (RQC_DEFECT_GROUPS) -- the
 *   same thresholds and the same found>=reject comparison as the
 *   prototype's rqcRecalcResult/rqcOverallStatus, never a generic "any
 *   defect found = Hold" rule, and never something the user can override.
 *   While the record is still untouched (status "pending")
 *   the Product/Shipment Details card is hidden here too -- there's nothing
 *   filled in yet worth showing, and the point of this mode is to get the
 *   inspection done, not review context.
 * - "view": the full read-only record, plus the traceability link back to
 *   IPQC/Production. Only offered from the list once status is Hold or
 *   Approved, since a Pending/Draft record has nothing finished to review.
 *
 * Saving (edit mode only) posts the atomic write to FastAPI
 * (backend/app/api/rqc.py's PUT route). A save that reaches Approved is
 * what auto-populates FG QR Generation for this run -- entirely server-side,
 * nothing extra to do here.
 */
export default function RqcDetailPanel({
  record, onClose, canEdit, onSaved, mode, onEdit,
}: {
  record: RqcDetail;
  onClose: () => void;
  canEdit: boolean;
  onSaved: () => void;
  mode: "view" | "edit";
  onEdit?: () => void;
}) {
  const [manufacturer, setManufacturer] = useState(record.manufacturer || "");
  const [overallResult, setOverallResult] = useState(record.overall_result || "");
  const [defects, setDefects] = useState<Record<number, RqcDefectResult>>(
    Object.fromEntries(record.defect_results.map((d) => [d.defect_sr, d]))
  );
  const [coa, setCoa] = useState<Record<string, RqcCoaObservation>>(coaListToMap(record.coa_observations));
  const [saving, setSaving] = useState<"draft" | "final" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editing is only live in "edit" mode -- "view" always renders read-only,
  // even for a user who otherwise has edit permission on this module.
  const editable = mode === "edit" && canEdit;
  // Nothing autopopulated is worth showing yet on an untouched record --
  // hide the context card until there's actually something in it.
  // Shipment Number is now the user-entered key filled in at creation (not
  // something the record only "earns" once IPQC/Production auto-populate
  // it), so the context cards always have something real to show, even on
  // a fresh Pending record -- unlike the old auto-created-from-IPQC flow,
  // there is no "nothing filled in yet" state to hide it during.
  const showContextCards = true;

  function setFound(sr: number, value: string) {
    setDefects((prev) => {
      const found = value === "" ? null : Number(value);
      return { ...prev, [sr]: { defect_sr: sr, found, remarks: prev[sr]?.remarks ?? null } };
    });
  }
  function setRemarks(sr: number, value: string) {
    setDefects((prev) => ({ ...prev, [sr]: { defect_sr: sr, found: prev[sr]?.found ?? null, remarks: value } }));
  }
  function setCoaValue(group: string, sr: number, value: string) {
    setCoa((prev) => ({ ...prev, [coaKey(group, sr)]: { coa_group: group, sr, observation: value } }));
  }

  async function handleSave(saveMode: "draft" | "final") {
    setSaving(saveMode);
    setError(null);
    try {
      await api.saveRqc(record.id, {
        manufacturer: manufacturer || null,
        overall_result: overallResult || null,
        save_mode: saveMode,
        defect_results: Object.values(defects).filter((d) => d.found !== null || !!d.remarks),
        coa_observations: Object.values(coa).filter((o) => !!o.observation),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save record");
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
          {showContextCards && (
            <div className="detail-card">
              <h3>Product and Shipment Details</h3>
              <div className="detail-grid">
                <Kv label="Shipment Number" value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
                <Kv label="No. of Pallets" value={record.total_fg_pallets ?? "—"} />
                <Kv label="Shift" value={record.shift} />
                <Kv label="Date" value={record.date} />
              </div>
            </div>
          )}

          <div className="detail-card">
            <h3>Record Details</h3>
            <div className="detail-grid">
              <Kv label="SKU Code" value={record.sku_code ? <span className="mono">{record.sku_code}</span> : "—"} />
              <Kv label="SKU Version" value={record.sku_version} />
              <Kv label="Manufacturer Name" value={
                editable ? (
                  <input type="text" value={manufacturer} placeholder="e.g. Cirkla Manufacturing" onChange={(e) => setManufacturer(e.target.value)} />
                ) : (record.manufacturer || "—")
              } />
              <Kv label="Status" value={<StatusBadge status={record.status} />} />
            </div>
          </div>

          <div className="detail-card">
            <h3>RQC Inspection Records</h3>
            {/* One flat table across every classification group -- matches
                the prototype's rqcRenderDefectsTable exactly (a single
                rqc-defects-body, not a box per classification). Sample
                Size is one shared hint line above the table (every group
                uses the same 800-unit sample in the prototype's own
                RQC_DEFECT_GROUPS data) -- Accept/Reject numbers are the
                sampling plan's internal thresholds, used to compute Result
                below, and are never rendered to the user, exactly like the
                prototype never shows them either. */}
            <div className="hint-text" style={{ marginBottom: 10, fontWeight: 700, color: "var(--ink-70)" }}>
              Sample Size: {RQC_DEFECT_GROUPS[0].sampleSize}
            </div>
            <table className="qc-obs-table">
              <thead>
                <tr>
                  <th>Defect Type</th><th>Classification</th><th>Inspection Method</th>
                  <th style={{ width: 120 }}>Defects Found</th><th style={{ width: 120 }}>Result</th><th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {RQC_DEFECT_GROUPS.flatMap((group) =>
                  group.items.map((item) => {
                    const defect = defects[item.sr];
                    return (
                      <tr key={item.sr}>
                        <td>{item.type}</td>
                        <td><span className={`classification-badge ${group.badgeClass}`}>{group.classification}</span></td>
                        <td>Visual inspection</td>
                        <td>
                          {editable ? (
                            <input
                              type="number" placeholder="0"
                              value={defect?.found ?? ""}
                              onChange={(e) => setFound(item.sr, e.target.value)}
                            />
                          ) : (defect?.found ?? "—")}
                        </td>
                        {/* Result is always computed -- found >= this defect's
                            own group reject threshold, exactly matching
                            rqcRecalcResult. There is no path for the user to
                            set this directly, in edit or view mode. */}
                        <td><ResultBadge found={defect?.found ?? null} reject={group.reject} /></td>
                        <td>
                          {editable ? (
                            <input
                              type="text" placeholder="Add remarks (optional)"
                              value={defect?.remarks ?? ""}
                              onChange={(e) => setRemarks(item.sr, e.target.value)}
                            />
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

          <CoaTable title="COA — Base Material" group="base" params={RQC_COA_BASE} values={coa} editable={editable} onChange={setCoaValue} />
          <CoaTable title="COA — Functional Parameters" group="functional" params={RQC_COA_FUNCTIONAL} values={coa} editable={editable} onChange={setCoaValue} />
          <CoaTable title="COA — Packing Details" group="packing" params={RQC_COA_PACKING} values={coa} editable={editable} onChange={setCoaValue} />
          <CoaTable title="COA — Printing & Labelling" group="printing" params={RQC_COA_PRINTING} values={coa} editable={editable} onChange={setCoaValue} />

          {showContextCards && (
            <div className="detail-card">
              <h3>IPQC &amp; Production Source</h3>
              <div className="detail-grid">
                <Kv
                  label="Production Run"
                  value={record.production_run_number ? (
                    <Link className="mono" href={`/production?open=${record.production_run_id}`} style={{ textDecoration: "underline" }}>
                      {record.production_run_number} →
                    </Link>
                  ) : "—"}
                />
                <Kv
                  label="IPQC Record"
                  value={record.ipqc_id ? (
                    <Link className="mono" href={`/ipqc?open=${record.ipqc_id}`} style={{ textDecoration: "underline" }}>
                      {record.ipqc_id.slice(0, 8)}… →
                    </Link>
                  ) : "—"}
                />
              </div>
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          {editable && (
            <div className="sp-foot-right">
              <button className="btn btn-secondary" disabled={saving !== null} onClick={() => handleSave("draft")}>
                {saving === "draft" ? "Saving…" : "Save Draft"}
              </button>
              <button className="btn btn-primary" disabled={saving !== null} onClick={() => handleSave("final")}>
                {saving === "final" ? "Saving…" : "Save"}
              </button>
            </div>
          )}
          {mode === "view" && canEdit && onEdit && (
            <button className="btn btn-primary" onClick={onEdit}>Edit</button>
          )}
        </div>
      </div>
    </>
  );
}
