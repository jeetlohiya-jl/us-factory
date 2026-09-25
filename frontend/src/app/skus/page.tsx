"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { Category, SkuCode, SkuVersion } from "@/lib/types";
import { skuFamily } from "@/lib/types";
import { MODULE_NAMES, T } from "@/lib/terms";

// Production Details reference attributes (migration 0013) -- entered once
// here per SKU Version, then autopopulated (never re-entered) on every
// Production record that uses that version. Field order/labels match the
// prototype's per-machine "Production Details" table exactly.
const PROD_DETAIL_FIELDS: { key: keyof SkuVersion; label: string; numeric?: boolean }[] = [
  { key: "prod_weight", label: "Weight" },
  { key: "prod_pcs_per_sleeve", label: "Trays/Sleeve" },
  { key: "prod_sleeve_per_case", label: "Sleeve/Combo" },
  { key: "prod_total_pcs_per_pallet", label: "Total No. of Pcs/Pallet", numeric: true },
  { key: "prod_total_pallets", label: "Total Quantity", numeric: true },
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

// An SKU belongs to a material FAMILY, not a stage (migration 0049): one
// Tray SKU (e.g. 3P) serves Base Tray, LNP Tray and FG -- the stage is
// chosen on each record, never here.
const MATERIAL_LABELS: Record<string, string> = {
  tray: "Tray (Base Tray / LNP Tray / FG)", film: "Film", pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};
const MANAGED_CATEGORIES: Category[] = ["tray", "film", "pad", "polybag", "cfb", "glue"];
const MATERIAL_SHORT: Record<string, string> = { ...MATERIAL_LABELS, tray: "Tray" };

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
  const [category, setCategory] = useState<Category>("tray");
  const [newDescription, setNewDescription] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newSkuCode, setNewSkuCode] = useState("");
  const [newInitialVersion, setNewInitialVersion] = useState("");
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
      const created = await api.createSku(category, code);
      // SKU Code (a separate, alphanumeric field from both SKU Name above
      // and the numeric-only Batch Number further down this same table --
      // "my sku code has numbers and alphabets : batch number is onky the
      // numbers without the alphabet") and initial Version(s) are both
      // optional and both reuse the exact same updateSku/addSkuVersion
      // calls their table row controls already use -- not new concepts,
      // just available at creation time too instead of requiring a second
      // trip to the table. Versions may be a comma-separated list so more
      // than one can be added in one go.
      const skuCode = newSkuCode.trim();
      const description = newDescription.trim();
      if (skuCode || description) {
        await api.updateSku(created.id, { sku_code: skuCode || null, description: description || null });
      }
      const initialVersions = newInitialVersion.split(",").map((v) => v.trim()).filter(Boolean);
      for (const v of initialVersions) {
        await api.addSkuVersion(created.id, v);
      }
      setNewCode("");
      setNewSkuCode("");
      setNewDescription("");
      setNewInitialVersion("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add SKU");
    }
  }

  async function handleDescriptionChange(s: SkuCode, value: string) {
    try {
      await api.updateSku(s.id, { description: value.trim() || null });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update SKU");
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

  async function handleBatchNumberChange(s: SkuCode, value: string) {
    const batch_number = value.trim() || null;
    try {
      await api.updateSku(s.id, { batch_number });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update SKU");
    }
  }

  async function handleSkuCodeChange(s: SkuCode, value: string) {
    const sku_code = value.trim() || null;
    try {
      await api.updateSku(s.id, { sku_code });
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
          <h1>{MODULE_NAMES.skus}</h1>
          <div className="desc">One SKU per product — a Tray SKU (e.g. 3P) is used for Base Tray, LNP Tray and FG alike.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {canEdit && (
        <div className="card" style={{ marginBottom: 20, padding: 18 }}>
          <div className="section-label">Add {T.sku}</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>Material</label>
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                {MANAGED_CATEGORIES.map((c) => <option key={c} value={c}>{MATERIAL_LABELS[c]}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>{T.sku}</label>
              <input
                value={newCode} placeholder="e.g. 3P"
                onChange={(e) => setNewCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSku()}
              />
            </div>
            <div className="field" style={{ minWidth: 140 }}>
              <label>{T.skuCode} (optional)</label>
              <input
                className="mono" value={newSkuCode} placeholder="e.g. CMP0003P"
                onChange={(e) => setNewSkuCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSku()}
              />
            </div>
            <div className="field" style={{ flex: 2, minWidth: 260 }}>
              <label>Name (optional)</label>
              <input
                value={newDescription} placeholder="e.g. Cirkla Fiber Overwrap 3P Tray - Processor"
                onChange={(e) => setNewDescription(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSku()}
              />
            </div>
            <div className="field" style={{ minWidth: 160 }}>
              <label>Version(s) (optional)</label>
              <input
                value={newInitialVersion} placeholder="e.g. R7"
                onChange={(e) => setNewInitialVersion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSku()}
              />
            </div>
            <button className="btn btn-primary" disabled={!newCode.trim()} onClick={handleAddSku}>+ Add {T.sku}</button>
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
          <thead><tr><th>Material</th><th>{T.sku}</th><th>{T.skuCode}</th><th>Name</th><th>Batch Number</th><th>Versions</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.length === 0 ? (
              <tr className="empty-row"><td colSpan={8}>{loading ? "Loading…" : "No SKUs yet — add one above."}</td></tr>
            ) : (
              visible.map((s) => (
                <tr key={s.id}>
                  <td>{MATERIAL_SHORT[skuFamily(s.category)] || s.category}</td>
                  <td className="mono">{s.code}</td>
                  <td>
                    {canEdit ? (
                      <input
                        className="mono" style={{ width: 100 }} placeholder="e.g. SC-4821A" defaultValue={s.sku_code || ""}
                        onBlur={(e) => e.target.value !== (s.sku_code || "") && handleSkuCodeChange(s, e.target.value)}
                      />
                    ) : (s.sku_code || "—")}
                  </td>
                  <td>
                    {canEdit ? (
                      <input
                        style={{ minWidth: 220 }} placeholder="Full name" defaultValue={s.description || ""}
                        onBlur={(e) => e.target.value !== (s.description || "") && handleDescriptionChange(s, e.target.value)}
                      />
                    ) : (s.description || "—")}
                  </td>
                  <td>
                    {canEdit ? (
                      <input
                        className="mono" style={{ width: 80 }} placeholder="e.g. 03170" defaultValue={s.batch_number || ""}
                        onBlur={(e) => e.target.value !== (s.batch_number || "") && handleBatchNumberChange(s, e.target.value)}
                      />
                    ) : (s.batch_number || "—")}
                  </td>
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
