"use client";
import type { IpqcTestEvent, IpqcTestStatus } from "@/lib/types";

export function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

const STATUS_CLASS: Record<IpqcTestStatus, string> = { draft: "draft", passed: "approved", failed: "hold" };
const STATUS_LABEL: Record<IpqcTestStatus, string> = { draft: "Draft", passed: "Passed", failed: "Failed" };
export function TestStatusBadge({ status }: { status: IpqcTestStatus }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? "draft"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

const ACTION_LABEL: Record<string, string> = {
  created: "Test started", saved: "Saved", attachment_added: "Attachment added", attachment_removed: "Attachment removed",
};
export function HistoryList({ events }: { events: IpqcTestEvent[] }) {
  if (events.length === 0) return <div className="hint-text">No history yet.</div>;
  return (
    <table className="qc-obs-table">
      <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(e.created_at)}</td>
            <td>{e.user_name || "—"}</td>
            <td>
              {ACTION_LABEL[e.action] ?? e.action}
              {e.detail ? <span className="hint-text" style={{ display: "block", margin: 0 }}>{e.detail}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
