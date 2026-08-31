"use client";
import type { QcFgtrayAnswer } from "@/lib/types";

export default function FgtrayObservations({
  answers, onChange, disabled,
}: { answers: QcFgtrayAnswer[]; onChange: (criteriaId: string, answer: "ok" | "not_ok", remarks: string) => void; disabled?: boolean }) {
  return (
    <table className="qc-obs-table">
      <thead><tr><th style={{ width: 36 }}>Sr.</th><th>Criteria</th><th style={{ width: 170 }}>Observation</th><th>Remarks</th></tr></thead>
      <tbody>
        {answers.map((a, i) => (
          <tr key={a.criteria_id}>
            <td>{i + 1}</td>
            <td>{a.label}</td>
            <td>
              <div className="toggle2">
                <button className={`sel-ok ${a.answer === "ok" ? "on" : ""}`} disabled={disabled} onClick={() => onChange(a.criteria_id, "ok", a.remarks || "")}>OK</button>
                <button className={`sel-notok ${a.answer === "not_ok" ? "on" : ""}`} disabled={disabled} onClick={() => onChange(a.criteria_id, "not_ok", a.remarks || "")}>NOT OK</button>
              </div>
            </td>
            <td>
              <input
                type="text"
                placeholder="Remarks"
                disabled={disabled}
                defaultValue={a.remarks || ""}
                onBlur={(e) => a.answer && onChange(a.criteria_id, a.answer, e.target.value)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
