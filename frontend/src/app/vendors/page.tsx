"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { Category, Vendor } from "@/lib/types";

const CATEGORY_LABELS: Record<Category, string> = {
  tray: "Tray", pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};
// Tray vendors aren't offered on Inward Vehicle Inspection today (Tray QC is
// only ever auto-created from an approved inspection, never entered by hand
// the way Pad/Polybag/CFB/Glue are) -- keep the manager scoped to the
// categories that actually use a typed vendor name.
const MANAGED_CATEGORIES: Category[] = ["pad", "polybag", "cfb", "glue"];

/**
 * Admin screen for the per-category Vendor master list backing the Vendor
 * Name dropdown on Inward Vehicle Inspection (see Wizard.tsx). Gated on the
 * same inward_vehicle_inspection module permission the inspection itself
 * uses (can_edit to add/deactivate/delete) rather than a separate module,
 * since this list only exists to serve that one field.
 */
export default function VendorsPage() {
  const me = useMe();
  const perms = me?.permissions.inward_vehicle_inspection;
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>("pad");
  const [newName, setNewName] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setVendors(await api.vendors({ includeInactive: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load vendors");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      await api.createVendor(category, name);
      setNewName("");
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add vendor");
    }
  }

  async function toggleActive(v: Vendor) {
    try {
      await api.updateVendor(v.id, { is_active: !v.is_active });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update vendor");
    }
  }

  async function handleDelete(v: Vendor) {
    if (!confirm(`Delete "${v.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteVendor(v.id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete vendor");
    }
  }

  const canEdit = !!perms?.can_edit;
  const visible = vendors.filter((v) => showInactive || v.is_active);

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Vendors</h1>
          <div className="desc">Manages the per-category vendor list used by the Vendor Name dropdown on Inward Vehicle Inspection.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {canEdit && (
        <div className="card" style={{ marginBottom: 20, padding: 18 }}>
          <div className="section-label">Add Vendor</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {MANAGED_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>Vendor Name</label>
              <input
                value={newName} placeholder="e.g. 3P China"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </div>
            <button className="btn btn-primary" disabled={!newName.trim()} onClick={handleAdd}>+ Add Vendor</button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive vendors
        </label>
        <div className="showing-count">{loading ? "Loading…" : `${visible.length} vendor${visible.length === 1 ? "" : "s"}`}</div>
      </div>

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Category</th><th>Vendor Name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.length === 0 ? (
              <tr className="empty-row"><td colSpan={4}>{loading ? "Loading…" : "No vendors yet — add one above."}</td></tr>
            ) : (
              visible.map((v) => (
                <tr key={v.id}>
                  <td>{CATEGORY_LABELS[v.category] || v.category}</td>
                  <td className="mono">{v.name}</td>
                  <td><span className={`badge ${v.is_active ? "accepted" : "draft"}`}>{v.is_active ? "Active" : "Inactive"}</span></td>
                  <td style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    {canEdit && (
                      <>
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => toggleActive(v)}>
                          {v.is_active ? "Deactivate" : "Reactivate"}
                        </a>
                        <a className="btn-tertiary" style={{ cursor: "pointer", color: "var(--red)" }} onClick={() => handleDelete(v)}>
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
