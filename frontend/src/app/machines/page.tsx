"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { Machine } from "@/lib/types";

/**
 * Admin screen for the Machine master list backing Material Consumption's
 * Machine dropdown (see the Wizard component). Gated on the
 * material_consumption module permission, mirroring how Vendors is gated
 * on inward_vehicle_inspection -- the module the master data actually
 * serves.
 */
export default function MachinesPage() {
  const me = useMe();
  const perms = me?.permissions.material_consumption;
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMachines(await api.machines(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load machines");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleAdd() {
    const code = newCode.trim();
    if (!code) return;
    setError(null);
    try {
      await api.createMachine(code);
      setNewCode("");
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add machine");
    }
  }

  async function toggleActive(m: Machine) {
    try {
      await api.updateMachine(m.id, { is_active: !m.is_active });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update machine");
    }
  }

  async function handleDelete(m: Machine) {
    if (!confirm(`Delete "${m.code}"? This cannot be undone.`)) return;
    try {
      await api.deleteMachine(m.id);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete machine");
    }
  }

  const canEdit = !!perms?.can_edit;
  const visible = machines.filter((m) => showInactive || m.is_active);

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Machines</h1>
          <div className="desc">Manages the machine list used by the Machine dropdown on Material Consumption.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {canEdit && (
        <div className="card" style={{ marginBottom: 20, padding: 18 }}>
          <div className="section-label">Add Machine</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>Machine Code</label>
              <input
                value={newCode} placeholder="e.g. MACH-005"
                onChange={(e) => setNewCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </div>
            <button className="btn btn-primary" disabled={!newCode.trim()} onClick={handleAdd}>+ Add Machine</button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive machines
        </label>
        <div className="showing-count">{loading ? "Loading…" : `${visible.length} machine${visible.length === 1 ? "" : "s"}`}</div>
      </div>

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Machine Code</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.length === 0 ? (
              <tr className="empty-row"><td colSpan={3}>{loading ? "Loading…" : "No machines yet — add one above."}</td></tr>
            ) : (
              visible.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.code}</td>
                  <td><span className={`badge ${m.is_active ? "accepted" : "draft"}`}>{m.is_active ? "Active" : "Inactive"}</span></td>
                  <td style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    {canEdit && (
                      <>
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => toggleActive(m)}>
                          {m.is_active ? "Deactivate" : "Reactivate"}
                        </a>
                        <a className="btn-tertiary" style={{ cursor: "pointer", color: "var(--red)" }} onClick={() => handleDelete(m)}>
                          Delete
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
