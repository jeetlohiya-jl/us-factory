"use client";
import type { RqcCoaObservation, RqcCoaParamDef } from "@/lib/types";

/**
 * Shared COA table pieces -- originally inline in RqcDetailPanel.tsx, now
 * factored out (2026-09-17, item 7 of the RQC redesign) so both the legacy
 * RqcDetailPanel (still renders these read-only for pre-existing records
 * that saved COA the old rqc_record_id-linked way) and the new
 * CoaEntryPanel (the per-shipment flow, backend/app/api/rqc_coa.py) use the
 * exact same rendering -- no reinvented COA UI.
 */
export function coaKey(group: string, sr: number) {
  return `${group}:${sr}`;
}

export function coaListToMap(observations: RqcCoaObservation[]): Record<string, RqcCoaObservation> {
  return Object.fromEntries(observations.map((o) => [coaKey(o.coa_group, o.sr), o]));
}

export function CoaTable({
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
