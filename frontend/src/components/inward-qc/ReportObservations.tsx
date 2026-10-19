"use client";
import type { QcAttributeValue } from "@/lib/types";

/**
 * Falcon's Inward QC form, laid out like the printed inward QC report
 * for the material: Attributes / Description / Inspection Method (when the
 * report has one) / Actual Observations. The report's Tolerance and Defects
 * Type columns are deliberately not shown (the values stay in the field
 * definitions; the tolerance is already part of most labels, e.g. "Length mm (±2)"), and (RM Tray) the separate defects
 * list with its acceptable limit, classification and failed-product count.
 * A column only appears when the report has something in it. Wording comes
 * straight from the field definitions (migration 0084), never from here.
 */
export default function ReportObservations({
  values, onChange, disabled,
}: {
  values: QcAttributeValue[];
  onChange: (attributeDefinitionId: string, value: string) => void;
  disabled?: boolean;
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
      <div style={{ overflowX: "auto" }}>
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
                <td style={{ fontSize: 12.5 }}>{v.description || "—"}</td>
                {hasMethod && <td>{v.inspection_method || "—"}</td>}
                <td>{input(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {defects.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 18 }}>
          <table className="qc-obs-table">
            <thead>
              <tr><th>Defects List</th><th style={{ width: 120 }}>Acceptable Limit</th><th style={{ width: 100 }}>Classification</th><th style={{ width: 150 }}>No. of failed products</th></tr>
            </thead>
            <tbody>
              {defects.map((v) => (
                <tr key={v.attribute_definition_id}>
                  <td>{v.label}{v.is_required && <span style={{ color: "var(--red)" }}> *</span>}</td>
                  <td>{v.acceptable_limit || "—"}</td>
                  <td>{v.defect_type || "—"}</td>
                  <td>{input(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
