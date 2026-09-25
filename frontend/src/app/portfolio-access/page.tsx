"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { PortfolioAccess } from "@/lib/types";

/**
 * Setup -> Portfolio Access (admin-only). Controls the post-login
 * Factory / US Factory picker in AppShell -- an email added here with
 * neither box checked can sign in but sees a "no access" screen; one box
 * checked skips the picker and goes straight there; both shows the picker.
 *
 * Deliberately independent of the Users screen: an email added here for
 * Factory access doesn't need (and may never get) an app_users row, since
 * Factory isn't built in this app.
 */
export default function PortfolioAccessPage() {
  const me = useMe();
  const [rows, setRows] = useState<PortfolioAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [newFactory, setNewFactory] = useState(false);
  const [newUsFactory, setNewUsFactory] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await api.portfolioAccessList());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load portfolio access");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (me && !me.is_admin) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <h1>Portfolio Access</h1>
        <div className="desc">You need admin access to manage this. Ask an existing admin to grant it.</div>
      </div>
    );
  }

  async function handleAdd() {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    setSaving(true);
    setError(null);
    try {
      await api.createPortfolioAccess({ email, access_factory: newFactory, access_us_factory: newUsFactory });
      setNewEmail("");
      setNewFactory(false);
      setNewUsFactory(true);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add access");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(row: PortfolioAccess, key: "access_factory" | "access_us_factory") {
    setError(null);
    try {
      await api.updatePortfolioAccess(row.id, { [key]: !row[key] });
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update access");
    }
  }

  async function remove(row: PortfolioAccess) {
    setError(null);
    try {
      await api.deletePortfolioAccess(row.id);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to remove access");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Portfolio Access</h1>
          <div className="desc">
            Control which emails see Factory and/or US Factory right after they sign in. Someone with only one
            of the two skips straight to it; someone with both is asked to choose every time.
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 20, padding: 18 }}>
        <div className="section-label">Add Access</div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>Email</label>
            <input type="email" value={newEmail} placeholder="name@gocirkla.com" onChange={(e) => setNewEmail(e.target.value)} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, paddingBottom: 8 }}>
            <input type="checkbox" checked={newFactory} onChange={(e) => setNewFactory(e.target.checked)} />
            Factory
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, paddingBottom: 8 }}>
            <input type="checkbox" checked={newUsFactory} onChange={(e) => setNewUsFactory(e.target.checked)} />
            US Factory
          </label>
          <button className="btn btn-primary" disabled={saving || !newEmail.trim()} onClick={handleAdd}>
            {saving ? "Adding…" : "+ Add"}
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="showing-count">{loading ? "Loading…" : `${rows.length} email${rows.length === 1 ? "" : "s"}`}</div>
      </div>

      <div className="card card-flush">
        <table className="data">
          <thead>
            <tr>
              <th>Email</th>
              <th style={{ textAlign: "center" }}>Factory</th>
              <th style={{ textAlign: "center" }}>US Factory</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="empty-row"><td colSpan={4}>{loading ? "Loading…" : "No emails yet — add one above."}</td></tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.email}</td>
                  <td style={{ textAlign: "center" }}>
                    <input type="checkbox" checked={row.access_factory} onChange={() => toggle(row, "access_factory")} />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <input type="checkbox" checked={row.access_us_factory} onChange={() => toggle(row, "access_us_factory")} />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => remove(row)}>Remove</a>
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
