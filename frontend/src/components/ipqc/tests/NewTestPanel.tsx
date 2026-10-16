"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { BurstTest, IpqcRunOption, IpqcTestKind, PinholeTest } from "@/lib/types";

// A UUID (the server requires one). crypto.randomUUID needs a secure context;
// fall back to getRandomValues, which works everywhere.
function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * "+ New Burst Test" / "+ New Pinhole Test": pick the Production Run the test
 * is for, confirm the lamination machine (LM1-LM7), and Start. SKU, SKU
 * Version and Shift are read from the run on the server and shown after.
 *
 * The request id is created once when the panel opens and re-sent on every
 * click / retry, so a double click or a retry after a dropped connection can
 * never create two tests. Opening the panel again (a new "+ New") is a new
 * request, which is how a legitimate second test for the same run is made.
 */
export default function NewTestPanel({
  kind, initialRunId, onClose, onCreated,
}: {
  kind: IpqcTestKind;
  initialRunId?: string;
  onClose: () => void;
  onCreated: (record: BurstTest | PinholeTest) => void;
}) {
  const [requestId] = useState(newRequestId);
  const [search, setSearch] = useState("");
  const [runs, setRuns] = useState<IpqcRunOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId ?? null);
  const [machineId, setMachineId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = kind === "burst" ? "Burst Test" : "Pinhole Test";

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.ipqcRunOptions(search);
        if (!cancelled) setRuns(res);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load Production Runs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, search ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);

  const selected = runs.find((r) => r.production_run_id === selectedId) ?? null;
  // The run's own lamination machines when it has them; otherwise any of LM1-LM7.
  const choices = selected ? (selected.machines.length > 0 ? selected.machines : selected.all_machines) : [];
  const effectiveMachine = machineId || (choices.length === 1 ? choices[0].machine_id : "");

  function select(r: IpqcRunOption) {
    setSelectedId(r.production_run_id);
    setMachineId("");
    setError(null);
  }

  async function start() {
    if (!selected) return;
    setCreating(true);
    setError(null);
    try {
      const payload = { client_request_id: requestId, production_run_id: selected.production_run_id, machine_id: effectiveMachine || null };
      const rec = kind === "burst" ? await api.createBurstTest(payload) : await api.createPinholeTest(payload);
      onCreated(rec);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the test");
      setCreating(false); // the same request id is reused if the user tries again
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div><h2>New {label}</h2><div className="sub">Choose the Production Run being tested</div></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          <div className="field">
            <label>Search Production Run or {`Shipment`} Number</label>
            <input type="text" value={search} placeholder="e.g. PR-2610-0001" onChange={(e) => setSearch(e.target.value)} autoFocus />
          </div>
          <div style={{ marginTop: 10 }}>
            {loading && <div className="hint-text">Loading…</div>}
            {!loading && runs.length === 0 && <div className="hint-text">No Production Runs match.</div>}
            <table className="qc-obs-table">
              <tbody>
                {runs.map((r) => (
                  <tr key={r.production_run_id} style={{ cursor: "pointer", background: r.production_run_id === selectedId ? "var(--ink-08)" : undefined }} onClick={() => select(r)}>
                    <td style={{ width: 28 }}><input type="radio" readOnly checked={r.production_run_id === selectedId} /></td>
                    <td>
                      <div className="mono" style={{ fontWeight: 700 }}>{r.run_number}</div>
                      <div className="hint-text" style={{ margin: 0 }}>
                        {[r.production_date, r.shift, r.sku_code && `${r.sku_code}${r.sku_version ? ` ${r.sku_version}` : ""}`].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </td>
                    <td className="mono">{r.machines.length > 0 ? r.machines.map((m) => m.machine_code).join(", ") : <span className="hint-text">no LM recorded</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected && (
            <div className="detail-card" style={{ marginTop: 16 }}>
              <h3>{selected.run_number}</h3>
              <div className="field" style={{ maxWidth: 320 }}>
                <label>Lamination Machine <span style={{ color: "var(--red)" }}>*</span></label>
                {choices.length === 1 ? (
                  <div className="readonly-val mono">{choices[0].machine_code}</div>
                ) : (
                  <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                    <option value="">Select…</option>
                    {choices.map((m) => <option key={m.machine_id} value={m.machine_id}>{m.machine_code}</option>)}
                  </select>
                )}
                <div className="hint-text" style={{ margin: "4px 0 0" }}>
                  {selected.machines.length === 0
                    ? "No lamination machine is recorded on this run yet, so any of LM1–LM7 can be chosen."
                    : selected.machines.length === 1
                      ? "The lamination machine used on this run."
                      : "This run used more than one lamination machine — choose the one being tested."}
                </div>
              </div>
              <div className="hint-text" style={{ marginTop: 10 }}>SKU, SKU Version and Shift are filled in from this run automatically.</div>
            </div>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <div className="sp-foot-right">
            <button className="btn btn-primary" disabled={!selected || !effectiveMachine || creating} onClick={start}>
              {creating ? "Starting…" : `Start ${label}`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
