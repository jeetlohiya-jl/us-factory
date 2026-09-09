"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Machine, MachineDowntimeRecord } from "@/lib/types";

const SHIFTS = ["Shift A", "Shift B", "Shift C"];

/** Same overnight-wrap-aware calculation as the prototype's mdCalcDuration
 * (e.g. 23:30 -> 00:15 = 45m): if end is earlier than start, treat it as
 * having rolled past midnight rather than producing a negative duration. */
export function calcDurationMinutes(start: string, end: string): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const sMin = sh * 60 + sm;
  const eMin = eh * 60 + em;
  let diff = eMin - sMin;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return "—";
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

export default function MachineDowntimePanel({
  machines, record, onClose, onSaved,
}: {
  machines: Machine[];
  record: MachineDowntimeRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [machineId, setMachineId] = useState(record?.machine_id || machines[0]?.id || "");
  const [shift, setShift] = useState(record?.shift || SHIFTS[0]);
  const [start, setStart] = useState(record?.start_time || "");
  const [end, setEnd] = useState(record?.end_time || "");
  const [reason, setReason] = useState(record?.reason || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duration = calcDurationMinutes(start, end);

  async function handleSave(status: "draft" | "saved") {
    setSaving(true);
    setError(null);
    try {
      const machine = machines.find((m) => m.id === machineId);
      const payload = {
        machine_id: machineId || null,
        machine: machine?.code || null,
        shift: shift || null,
        start_time: start || null,
        end_time: end || null,
        duration_minutes: duration,
        reason: reason || null,
        status,
      };
      if (record) {
        await api.updateMachineDowntime(record.id, payload);
      } else {
        await api.createMachineDowntime(payload);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save record");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>{record ? "Edit Machine Downtime Record" : "New Machine Downtime Record"}</h2></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label>Machine</label>
              <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                {machines.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Shift</label>
              <select value={shift} onChange={(e) => setShift(e.target.value)}>
                {SHIFTS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field"><label>Start Time</label><input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label>End Time</label><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <div className="field" style={{ marginBottom: 18 }}>
            <label>Duration</label>
            <div className="readonly-val">{formatDuration(duration)}</div>
          </div>
          <div className="field">
            <label>Reason</label>
            <textarea rows={3} placeholder="Describe the reason for downtime" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <div className="sp-foot-right">
            <button className="btn btn-secondary" disabled={saving} onClick={() => handleSave("draft")}>{saving ? "Saving…" : "Save Draft"}</button>
            <button className="btn btn-primary" disabled={saving} onClick={() => handleSave("saved")}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </>
  );
}
