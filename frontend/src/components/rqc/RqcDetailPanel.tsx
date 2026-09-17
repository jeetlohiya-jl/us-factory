"use client";
import { useState } from "react";
import Link from "next/link";
import type { RqcDetail, RqcDefectResult, RqcCoaObservation, RqcApprovalEntry } from "@/lib/types";
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
  // Migration 0039 -- the incremental approval ledger. Kept as local state
  // (not derived straight from the `record` prop) so "+ Add Approval
  // Entry" can refresh it in place without closing the panel, unlike the
  // main Save button below.
  const [approvalEntries, setApprovalEntries] = useState<RqcApprovalEntry[]>(record.approval_entries);
  const [fgPalletsGeneratedTotal, setFgPalletsGeneratedTotal] = useState(record.fg_pallets_generated);
  // Production's own count -- the hard ceiling RQC's approved pallets may
  // never exceed (task requirement, 2026-09-17). null when there's no
  // linked Production Run to compare against (server-side enforcement is
  // likewise skipped in that case -- see rqc_service.create_approval_entry).
  const [totalProduced, setTotalProduced] = useState(record.total_pallets_produced);
  const remainingToApprove = totalProduced != null ? Math.max(totalProduced - (fgPalletsGeneratedTotal || 0), 0) : null;
  const isMultiMachine = record.production_run_machines.length > 1;

  // New-entry mini-form state.
  const [entryDate, setEntryDate] = useState(record.date || "");
  const [entryApproved, setEntryApproved] = useState("");
  const [entryTablePerson, setEntryTablePerson] = useState(record.table_person_number || "");
  const [entryAllocations, setEntryAllocations] = useState<Record<string, string>>({});
  const [addingEntry, setAddingEntry] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);

  function setEntryAllocationCount(machineId: string, value: string) {
    setEntryAllocations((prev) => ({ ...prev, [machineId]: value }));
  }

  const entryAllocationTotal = Object.values(entryAllocations).reduce((sum, v) => sum + (Number(v) || 0), 0);
  const entryApprovedTotal = entryApproved === "" ? 0 : Number(entryApproved);

  // Manual retry for an entry recorded before this record could reach FG
  // QR Generation (e.g. an unlinked record, back when that was required --
  // it no longer is). Idempotent, so this is safe to offer on any entry
  // without an fg_qr_status yet.
  const [generatingEntryId, setGeneratingEntryId] = useState<string | null>(null);
  async function handleGenerateFgQr(entryId: string) {
    setGeneratingEntryId(entryId);
    setEntryError(null);
    try {
      await api.generateFgQrForApprovalEntry(record.id, entryId);
      const fresh = await api.getRqc(record.id);
      setApprovalEntries(fresh.approval_entries);
      setFgPalletsGeneratedTotal(fresh.fg_pallets_generated);
      onSaved();
    } catch (e) {
      setEntryError(e instanceof Error ? e.message : "Failed to generate FG QR for this entry");
    } finally {
      setGeneratingEntryId(null);
    }
  }

  async function handleAddApprovalEntry() {
    setEntryError(null);
    const approved = entryApproved === "" ? 0 : Number(entryApproved);
    if (!entryDate) { setEntryError("Date is required."); return; }
    if (approved <= 0) { setEntryError("Approved Pallets must be greater than 0."); return; }
    if (remainingToApprove != null && approved > remainingToApprove) {
      setEntryError(
        `Only ${remainingToApprove} pallet(s) remain unapproved for this Production Run `
        + `(${totalProduced} produced, ${fgPalletsGeneratedTotal || 0} already approved).`
      );
      return;
    }
    if (isMultiMachine && entryAllocationTotal > 0 && entryAllocationTotal !== approved) {
      setEntryError(`Allocated ${entryAllocationTotal}, but Approved Pallets is ${approved}. These must match.`);
      return;
    }
    setAddingEntry(true);
    try {
      await api.createRqcApprovalEntry(record.id, {
        entry_date: entryDate,
        approved_pallets: approved,
        table_person_number: entryTablePerson || null,
        machine_allocations: Object.entries(entryAllocations)
          .filter(([, v]) => Number(v) > 0)
          .map(([machine_id, v]) => ({ machine_id, fg_pallets_count: Number(v) })),
      });
      // Keep the panel open -- unlike the main Save button -- and refetch
      // this record so the new entry (and its FG QR batch status once
      // generate_pallets is run) shows up immediately.
      const fresh = await api.getRqc(record.id);
      setApprovalEntries(fresh.approval_entries);
      setFgPalletsGeneratedTotal(fresh.fg_pallets_generated);
      setTotalProduced(fresh.total_pallets_produced);
      setEntryApproved("");
      setEntryAllocations({});
      onSaved();
    } catch (e) {
      setEntryError(e instanceof Error ? e.message : "Failed to record this approval entry");
    } finally {
      setAddingEntry(false);
    }
  }

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

          {/* Migration 0039 -- RQC Approval Entries. A shipment's RQC
              activity can span multiple dates and operators, each
              approving some number of pallets independently -- never one
              cumulative field. Each entry recorded here independently
              drives its own FG QR Generation batch for exactly its own
              Approved Pallets (see qr_generation_service.
              get_or_create_fg_qr_for_rqc_approval_entry); re-adding the
              same activity is never possible from here (this only ever
              POSTs a brand-new entry), and Previously approved/generated
              pallets are never regenerated. */}
          <div className="detail-card">
            <h3>RQC Approval Entries</h3>
            <div className="hint-text" style={{ marginBottom: 10 }}>
              Total Approved Pallets: <strong>{fgPalletsGeneratedTotal ?? 0}</strong>
              {totalProduced != null && (
                <>
                  {" "}· Produced: <strong>{totalProduced}</strong>
                  {" "}· Remaining to Approve: <strong>{remainingToApprove}</strong>
                </>
              )}
            </div>
            <table className="qc-obs-table" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>Date</th><th>Operator</th><th style={{ width: 120 }}>Approved Pallets</th>
                  <th>Table/Person No.</th><th>FG QR Status</th>
                </tr>
              </thead>
              <tbody>
                {approvalEntries.length === 0 ? (
                  <tr><td colSpan={5} className="hint-text">No approval entries recorded yet.</td></tr>
                ) : (
                  approvalEntries.map((e) => (
                    <tr key={e.id}>
                      <td>{e.entry_date}</td>
                      <td>{e.operator_name || "—"}</td>
                      <td>{e.approved_pallets}</td>
                      <td>{e.table_person_number || "—"}</td>
                      <td>
                        {e.fg_qr_status ? (
                          <span className={`badge ${e.fg_qr_status}`}>{e.fg_qr_status}</span>
                        ) : editable ? (
                          <a
                            className="btn-tertiary" style={{ cursor: "pointer" }}
                            onClick={() => generatingEntryId ? undefined : handleGenerateFgQr(e.id)}
                          >
                            {generatingEntryId === e.id ? "Generating…" : "Generate"}
                          </a>
                        ) : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {editable && (
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                <div className="section-label" style={{ marginBottom: 8 }}>Record New Approval</div>
                <div className="detail-grid">
                  <div className="field">
                    <label>Date</label>
                    <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Approved Pallets{remainingToApprove != null && ` (max ${remainingToApprove})`}</label>
                    <input
                      type="number" min={0} max={remainingToApprove ?? undefined} placeholder="0"
                      value={entryApproved}
                      onChange={(e) => setEntryApproved(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>RQC Table/Person Number</label>
                    <input
                      type="text" placeholder="e.g. 1"
                      value={entryTablePerson}
                      onChange={(e) => setEntryTablePerson(e.target.value)}
                    />
                  </div>
                </div>
                {isMultiMachine && (
                  <div style={{ marginTop: 14 }}>
                    <div className="section-label">Machine Allocation</div>
                    <div className="hint-text" style={{ marginBottom: 8 }}>
                      This Production Run spans multiple machines -- split this entry&apos;s Approved
                      Pallets across them so each pallet&apos;s Batch Code names the machine that
                      actually produced it.
                    </div>
                    <table className="qc-obs-table" style={{ marginBottom: 6 }}>
                      <thead><tr><th>Machine</th><th style={{ width: 130 }}>FG Pallets</th></tr></thead>
                      <tbody>
                        {record.production_run_machines.map((m) => (
                          <tr key={m.id}>
                            <td className="mono">{m.code}</td>
                            <td>
                              <input
                                type="number" min={0} placeholder="0"
                                value={entryAllocations[m.id] ?? ""}
                                onChange={(e) => setEntryAllocationCount(m.id, e.target.value)}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {entryAllocationTotal > 0 && entryAllocationTotal !== entryApprovedTotal && (
                      <div className="hint-text" style={{ color: "var(--red)" }}>
                        Allocated {entryAllocationTotal}, but Approved Pallets is {entryApprovedTotal}. These must match.
                      </div>
                    )}
                  </div>
                )}
                {entryError && <div className="error-banner" style={{ marginTop: 10 }}>{entryError}</div>}
                <button
                  className="btn btn-secondary" style={{ marginTop: 12 }}
                  disabled={addingEntry} onClick={handleAddApprovalEntry}
                >
                  {addingEntry ? "Adding…" : "+ Add Approval Entry"}
                </button>
              </div>
            )}
          </div>

          {showContextCards && (
            <div className="detail-card">
              <h3>Product and Shipment Details</h3>
              <div className="detail-grid">
                <Kv label="Shipment Number" value={record.shipment_number ? <span className="mono">{record.shipment_number}</span> : "—"} />
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
