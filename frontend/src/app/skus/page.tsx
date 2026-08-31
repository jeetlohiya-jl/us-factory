"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { Category, SkuCode } from "@/lib/types";

const CATEGORY_LABELS: Record<Category, string> = {
  tray: "Tray", pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};
const MANAGED_CATEGORIES: Category[] = ["tray", "pad", "polybag", "cfb", "glue"];

/**
 * Admin screen for the per-category SKU Name + Version master list backing
 * every SKU picker in the app (Inward Vehicle Inspection line items, Inward
 * QC, RM/FG QR Generation filters). Mirrors /vendors: same permission gate
 * (inward_vehicle_inspection's can_edit), same active/inactive pattern.
 */
export default function SkusPage() {
  const me = useMe();
  const perms = me?.permissions.inward_vehicle_inspection;
  const canEdit = !!perms?.can_edit;

  const [skus, setSkus] = useState<SkuCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>("pad");
  const [newCode, setNewCode] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [newVersionBySkuId, setNewVersionBySkuId] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSkus(await api.skus({ includeInactive: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load SKUs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleAddSku() {
    const code = newCode.trim();
    if (!code) return;
    setError(null);
    try {
      await api.createSku(category, code);
      setNewCode("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add SKU");
    }
  }

  async function toggleSkuActive(s: SkuCode) {
    try {
      await api.updateSku(s.id, { is_active: !s.is_active });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update SKU");
    }
  }

  async function handleDeleteSku(s: SkuCode) {
    if (!confirm(`Delete "${s.code}" and all its versions? This cannot be undone.`)) return;
    try {
      await api.deleteSku(s.id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete SKU");
    }
  }

  async function handleAddVersion(skuId: string) {
    const version = (newVersionBySkuId[skuId] || "").trim();
    if (!version) return;
    setError(null);
    try {
      await api.addSkuVersion(skuId, version);
      setNewVersionBySkuId((prev) => ({ ...prev, [skuId]: "" }));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add version");
    }
  }

  async function toggleVersionActive(versionId: string, isActive: boolean) {
    try {
      await api.updateSkuVersion(versionId, { is_active: !isActive });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update version");
    }
  }

  async function handleDeleteVersion(versionId: string, version: string) {
    if (!confirm(`Delete version "${version}"?`)) return;
    try {
      await api.deleteSkuVersion(versionId);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete version");
    }
  }

  const visible = skus.filter((s) => showInactive || s.is_active);

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>SKU Names</h1>
          <div className="desc">Manages the per-category SKU Name + Version list used across Inward Vehicle Inspection, Inward QC, and QR Generation.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {canEdit && (
        <div className="card" style={{ marginBottom: 20, padding: 18 }}>
          <div className="section-label">Add SKU Name</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {MANAGED_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>SKU Name</label>
              <input
                value={newCode} placeholder="e.g. SKU-3P"
                onChange={(e) => setNewCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSku()}
              />
            </div>
            <button className="btn btn-primary" disabled={!newCode.trim()} onClick={handleAddSku}>+ Add SKU Name</button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive SKUs
        </label>
        <div className="showing-count">{loading ? "Loading…" : `${visible.length} SKU${visible.length === 1 ? "" : "s"}`}</div>
      </div>

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Category</th><th>SKU Name</th><th>Versions</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.length === 0 ? (
              <tr className="empty-row"><td colSpan={5}>{loading ? "Loading…" : "No SKUs yet — add one above."}</td></tr>
            ) : (
              visible.map((s) => (
                <tr key={s.id}>
                  <td>{CATEGORY_LABELS[s.category] || s.category}</td>
                  <td className="mono">{s.code}</td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      {s.versions.filter((v) => showInactive || v.is_active).map((v) => (
                        <span key={v.id} className={`badge ${v.is_active ? "accepted" : "draft"}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {v.version}
                          {canEdit && (
                            <>
                              <a style={{ cursor: "pointer", opacity: 0.7 }} onClick={() => toggleVersionActive(v.id, v.is_active)}>
                                {v.is_active ? "⏸" : "▶"}
                              </a>
                              <a style={{ cursor: "pointer", opacity: 0.7, color: "var(--red)" }} onClick={() => handleDeleteVersion(v.id, v.version)}>✕</a>
                            </>
                          )}
                        </span>
                      ))}
                      {canEdit && (
                        <span style={{ display: "flex", gap: 4 }}>
                          <input
                            style={{ width: 70, fontSize: 12 }}
                            placeholder="+ Version"
                            value={newVersionBySkuId[s.id] || ""}
                            onChange={(e) => setNewVersionBySkuId((prev) => ({ ...prev, [s.id]: e.target.value }))}
                            onKeyDown={(e) => e.key === "Enter" && handleAddVersion(s.id)}
                          />
                          <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => handleAddVersion(s.id)}>Add</a>
                        </span>
                      )}
                    </div>
                  </td>
                  <td><span className={`badge ${s.is_active ? "accepted" : "draft"}`}>{s.is_active ? "Active" : "Inactive"}</span></td>
                  <td style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    {canEdit && (
                      <>
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => toggleSkuActive(s)}>
                          {s.is_active ? "Deactivate" : "Reactivate"}
                        </a>
                        <a className="btn-tertiary" style={{ cursor: "pointer", color: "var(--red)" }} onClick={() => handleDeleteSku(s)}>
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
