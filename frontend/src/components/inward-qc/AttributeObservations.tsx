"use client";
import type { QcAttributeValue } from "@/lib/types";

export default function AttributeObservations({
  values, coaFilename, onChange, disabled,
}: {
  values: QcAttributeValue[];
  coaFilename: string | null;
  onChange: (attributeDefinitionId: string, value: string) => void;
  disabled?: boolean;
}) {
  return (
    <table className="qc-obs-table">
      <thead><tr><th>Attribute</th><th style={{ width: 130 }}>COA</th><th style={{ width: 150 }}>Observations</th></tr></thead>
      <tbody>
        {values.map((v) => (
          <tr key={v.attribute_definition_id}>
            <td>{v.label}{v.is_required && <span style={{ color: "var(--red)" }}> *</span>}</td>
            <td className="mono" style={{ fontSize: 12 }}>{coaFilename || "—"}</td>
            <td>
              {v.field_type === "dropdown" ? (
                <select disabled={disabled} value={v.value || ""} onChange={(e) => onChange(v.attribute_definition_id, e.target.value)}>
                  <option value="">Select</option>
                  {(v.options_json || []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  // Keyed on the current value so a value injected from
                  // outside (a COA-parse suggestion filling this field
                  // programmatically, not by the operator typing) remounts
                  // the input with the new defaultValue -- an uncontrolled
                  // input otherwise never reflects a prop-driven update.
                  key={v.value ?? ""}
                  type={v.field_type === "number" ? "number" : "text"}
                  placeholder={v.field_type === "number" ? "0" : "Enter value"}
                  disabled={disabled}
                  defaultValue={v.value || ""}
                  onBlur={(e) => onChange(v.attribute_definition_id, e.target.value)}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
