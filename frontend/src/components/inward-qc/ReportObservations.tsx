"use client";
import type { QcAttributeValue } from "@/lib/types";

/**
 * Falcon's Inward QC form, laid out like the printed inward QC report.
 * `part` splits it across two pages: the attributes table, then the Defects List.
 */
export default function ReportObservations({
  values, onChange, disabled, part = "all",
}: {
  values: QcAttributeValue[];
  onChange: (attributeDefinitionId: string, value: string) => void;
  disabled?: boolean;
  part?: "all" | "attributes" | "defects";
}) {
  const attrs = values.filter((v) => (v.section || "attribute") !== "defect");
  const defects = values.filter((v) => v.section === "defect");
  const hasMethod = attrs.some((v) => v.inspection_method);

  function input(v: QcAttributeValue) {
    // Pre-filled from the Goods Receipt and fixed there (pallets received).
    const locked = disabled || v.auto_source === "pallet_count";
    if (v.field_type === "dropdown") {
      return (
        <select disabled={locked} value={v.value || ""} onChange={(e) => onChange(v.attribute_definition_id, e.target.value)}>
          <option value="">Select</option>
          {(v.options_json || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    return (
      <input
        // Keyed on the saved value so a value changed from outside (a server
        // pre-fill arriving, a refresh) remounts the uncontrolled input.
        key={v.value ?? ""}
        type={v.field_type === "number" ? "number" : "text"}
        min={v.field_type === "number" ? 0 : undefined}
        step={v.field_type === "number" ? "any" : undefined}
        placeholder={v.field_type === "number" ? "0" : "Enter value"}
        disabled={locked}
        defaultValue={v.value || ""}
        onBlur={(e) => { if (e.target.value !== (v.value || "")) onChange(v.attribute_definition_id, e.target.value); }}
      />
    );
  }

  return (
    <div>
      {part !== "defects" && <div style={{ overflowX: "auto" }}>
        <table className="qc-obs-table">
          <thead>
            <tr>
              <th>Attributes</th><th>Description</th>
              {hasMethod && <th style={{ width: 120 }}>Inspection Method</th>}
              <th style={{ width: 160 }}>Actual Observations</th>
            </tr>
          </thead>
          <tbody>
            {attrs.map((v) => (
              <tr key={v.attribute_definition_id}>
                <td>{v.label}{v.is_required && <span style={{ color: "var(--red)" }}> *</span>}</td>
                <td>{v.description || "—"}</td>
                {hasMethod && <td>{v.inspection_method || "—"}</td>}
                <td>{input(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      {part !== "attributes" && defects.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="qc-obs-table">
            <thead>
              <tr><th>Defects List</th><th style={{ width: 170 }}>No. of failed products</th></tr>
            </thead>
            <tbody>
              {defects.map((v) => {
                const limit = parseFloat(v.acceptable_limit || "");
                const over = Number.isFinite(limit) && parseFloat(v.value || "") > limit;
                return (
                  <tr key={v.attribute_definition_id}>
                    <td>
                      {v.label}
                      {(v.defect_type || v.inspection_method) && (
                        <div className="qc-defect-meta">
                          {v.defect_type && <span className={`classification-badge ${v.defect_type.toLowerCase()}`}>{v.defect_type.toUpperCase()}</span>}
                          {v.inspection_method && <span>{v.inspection_method}</span>}
                        </div>
                      )}
                    </td>
                    <td className={over ? "qc-over-limit" : undefined}>
                      {input(v)}
                      {over && <div className="qc-over-note">Over the limit — goes On Hold</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
