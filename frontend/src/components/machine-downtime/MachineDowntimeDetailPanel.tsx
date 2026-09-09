"use client";
import type { MachineDowntimeRecord } from "@/lib/types";
import { formatDuration } from "./MachineDowntimePanel";

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

export default function MachineDowntimeDetailPanel({
  record, onClose,
}: {
  record: MachineDowntimeRecord;
  onClose: () => void;
}) {
  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>Machine Downtime</h2><div className="sub mono">{record.machine || "—"}</div></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>Downtime Details</h3>
            <div className="detail-grid">
              <Kv label="Machine" value={record.machine} />
              <Kv label="Shift" value={record.shift} />
              <Kv label="Start" value={record.start_time} />
              <Kv label="End" value={record.end_time} />
              <Kv label="Duration" value={formatDuration(record.duration_minutes)} />
              <Kv label="Date" value={new Date(record.created_at).toLocaleDateString()} />
            </div>
          </div>
          <div className="detail-card">
            <h3>Reason</h3>
            <div className="detail-kv-value">{record.reason || "—"}</div>
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
