"use client";
import type { ChecklistAnswer } from "@/lib/types";

export default function ChecklistStep({
  answers, onSetAnswer, disabled,
}: {
  answers: ChecklistAnswer[];
  onSetAnswer: (checklistItemId: string, val: "ok" | "not_ok") => void;
  disabled?: boolean;
}) {
  const hasNotOk = answers.some((a) => a.answer === "not_ok");
  const complete = answers.length > 0 && answers.every((a) => a.answer === "ok" || a.answer === "not_ok");

  return (
    <div>
      <div className="section-label">Vehicle conditions to be inspected for:</div>
      {!complete && (
        <div className="hint-text" style={{ fontWeight: 700, marginBottom: 14 }}>
          Mark OK / NOT OK for every condition to enable Submit. Use Save Draft to keep this Pending in the meantime.
        </div>
      )}
      {complete && (
        <div className="hint-text" style={{ fontWeight: 700, marginBottom: 14, color: hasNotOk ? "var(--red)" : "var(--green-deep)" }}>
          {hasNotOk ? "One or more conditions are NOT OK — this record will be set to Hold." : "All conditions OK — this record will be set to Approved."}
        </div>
      )}
      <table className="ynq-table">
        <tbody>
          {answers.map((a) => (
            <tr key={a.checklist_item_id}>
              <td className="q-label">{a.label}</td>
              <td>
                <div className="toggle2">
                  <button
                    className={`sel-ok ${a.answer === "ok" ? "on" : ""}`}
                    disabled={disabled}
                    onClick={() => onSetAnswer(a.checklist_item_id, "ok")}
                  >OK</button>
                  <button
                    className={`sel-notok ${a.answer === "not_ok" ? "on" : ""}`}
                    disabled={disabled}
                    onClick={() => onSetAnswer(a.checklist_item_id, "not_ok")}
                  >NOT OK</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
