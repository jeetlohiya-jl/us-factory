"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { Category, SkuCode, SkuVersion } from "@/lib/types";

// Production Details reference attributes (migration 0013) -- entered once
// here per SKU Version, then autopopulated (never re-entered) on every
// Production record that uses that version. Field order/labels match the
// prototype's per-machine "Production Details" table exactly.
const PROD_DETAIL_FIELDS: { key: keyof SkuVersion; label: string; numeric?: boolean }[] = [
  { key: "prod_weight", label: "Weight" },
  { key: "prod_pcs_per_sleeve", label: "Pcs/Sleeve" },
  { key: "prod_sleeve_per_case", label: "Sleeve/Case" },
  { key: "prod_total_pcs_per_pallet", label: "Total No. of Pcs/Pallet", numeric: true },
  { key: "prod_total_pallets", label: "Total No. of Pallets", numeric: true },
  { key: "prod_target_shots", label: "Target Shots" },
  { key: "prod_pad_type", label: "Pad Type" },
  { key: "prod_pad_color", label: "Pad Color" },
  { key: "prod_case_type", label: "Case Type" },
  // Not used by Production's own table -- read only by IPQC's
  // autopopulation (Dimensions of Pad, Absorption Rate), off this same
  // per-SKU-Version reference data (migration 0015).
  { key: "prod_dimensions", label: "Dimensions of Pad" },
  { key: "prod_absorption_rate", label: "Absorption Rate" },
];

type ProdDetailsForm = Partial<Record<string, string>>;

function SkuVersionDetailsModal({
  skuCode, version, onClose, onSave,
}: {
  skuCode: string;
  version: SkuVersion;
  onClose: () => void;
  onSave: (patch: Record<string, string | number | null>) => Promise<void>;
}) {
  const [form, setForm] = useState<ProdDetailsForm>(() => {
    const init: ProdDetailsForm = {};
    for (const f of PROD_DETAIL_FIELDS) init[f.key] = version[f.key] != null ? String(version[f.key]) : "";
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, string | number | null> = {};
      for (const f of PROD_DETAIL_FIELDS) {
        const raw = (form[f.key] || "").trim();
        patch[f.key] = raw === "" ? null : (f.numeric ? Number(raw) : raw);
      }
      await onSave(patch);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Production Details");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>Production Details</h2>
            <div className="sub mono">{skuCode} · {version.version}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {PROD_DETAIL_FIELDS.map((f) => (
            <div className="field" key={f.key}>
              <label>{f.label}</label>
              <input
                type={f.numeric ? "number" : "text"}
                value={form[f.key] || ""}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </div>
          ))}
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </>
  );
}

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
  const [detailsTarget, setDetailsTarget] = useState<{ skuCode: string; version: SkuVersion } | null>(null);

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
                              <a style={{ cursor: "pointer", opacity: 0.7 }} onClick={() => setDetailsTarget({ skuCode: s.code, version: v })}>
                                Details
                              </a>
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

      {detailsTarget && (
        <SkuVersionDetailsModal
          skuCode={detailsTarget.skuCode}
          version={detailsTarget.version}
          onClose={() => setDetailsTarget(null)}
          onSave={async (patch) => {
            await api.updateSkuVersion(detailsTarget.version.id, patch);
            refresh();
          }}
        />
      )}
    </>
  );
}
