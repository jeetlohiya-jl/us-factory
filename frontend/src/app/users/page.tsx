"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { USER_MODULES } from "@/lib/types";
import type { AppUser, ModuleKey, Permissions, UserCreateInput } from "@/lib/types";

const MODULE_LABELS: Record<ModuleKey, string> = {
  inward_vehicle_inspection: "Inward Vehicle Inspection",
  inward_qc: "Inward QC",
  rm_qr_generation: "RM QR Generation",
  rm_storage: "RM Storage",
  material_consumption: "Material Consumption",
  production: "Production",
  ipqc: "IPQC",
  fg_qr_generation: "FG QR Generation",
  fg_storage: "FG Storage",
};

const ACTIONS: { key: keyof Permissions; label: string }[] = [
  { key: "can_view", label: "View" },
  { key: "can_create", label: "Create" },
  { key: "can_edit", label: "Edit" },
  { key: "can_delete", label: "Delete" },
  { key: "can_approve", label: "Approve" },
  { key: "can_fill_section", label: "Fill Section" },
];

const BLANK_PERMS: Permissions = {
  can_view: true, can_create: false, can_edit: false, can_delete: false, can_approve: false, can_fill_section: false,
};

function blankPermissionMap(): Record<ModuleKey, Permissions> {
  return Object.fromEntries(USER_MODULES.map((m) => [m, { ...BLANK_PERMS }])) as Record<ModuleKey, Permissions>;
}

/** Shared View/Create/Edit/Delete/Approve/Fill Section checkbox grid, one
 * row per module -- used both in the Add User form and inline per-user
 * editing below, so the two never drift out of sync visually. */
function PermissionMatrix({
  value, onChange, disabled,
}: {
  value: Record<ModuleKey, Permissions>;
  onChange: (module: ModuleKey, key: keyof Permissions, checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="card card-flush" style={{ overflowX: "auto" }}>
      <table className="data">
        <thead>
          <tr>
            <th>Module</th>
            {ACTIONS.map((a) => <th key={a.key} style={{ textAlign: "center" }}>{a.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {USER_MODULES.map((module) => (
            <tr key={module}>
              <td>{MODULE_LABELS[module]}</td>
              {ACTIONS.map((a) => (
                <td key={a.key} style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={value[module][a.key]}
                    onChange={(e) => onChange(module, a.key, e.target.checked)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function UsersPage() {
  const me = useMe();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newFullName, setNewFullName] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [newPerms, setNewPerms] = useState<Record<ModuleKey, Permissions>>(blankPermissionMap());
  const [saving, setSaving] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Record<ModuleKey, Permissions>>(blankPermissionMap());
  const [editSaving, setEditSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await api.users());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (me && !me.is_admin) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <h1>Users</h1>
        <div className="desc">You need admin access to manage users. Ask an existing admin to grant it.</div>
      </div>
    );
  }

  async function handleAdd() {
    const email = newEmail.trim().toLowerCase();
    const full_name = newFullName.trim();
    if (!email || !email.includes("@") || !full_name) return;
    setSaving(true);
    setError(null);
    try {
      const payload: UserCreateInput = { email, full_name, is_admin: newIsAdmin, permissions: newPerms };
      await api.createUser(payload);
      setNewEmail("");
      setNewFullName("");
      setNewIsAdmin(false);
      setNewPerms(blankPermissionMap());
      setShowAddForm(false);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add user");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(u: AppUser) {
    setExpandedId(expandedId === u.id ? null : u.id);
    setEditPerms(u.permissions);
  }

  async function saveEditPerms(u: AppUser) {
    setEditSaving(true);
    setError(null);
    try {
      await api.updateUser(u.id, { permissions: editPerms });
      setExpandedId(null);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update permissions");
    } finally {
      setEditSaving(false);
    }
  }

  async function toggleActive(u: AppUser) {
    setError(null);
    try {
      await api.updateUser(u.id, { is_active: !u.is_active });
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update user");
    }
  }

  async function toggleAdmin(u: AppUser) {
    setError(null);
    try {
      await api.updateUser(u.id, { is_admin: !u.is_admin });
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update user");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Users</h1>
          <div className="desc">
            Add teammates, control which modules they can view/create/edit/delete/approve/fill in, and grant or
            revoke admin access. A new user signs in with Google using the email added here — their account links
            up automatically on first sign-in.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddForm((s) => !s)}>
          {showAddForm ? "Cancel" : "+ Add User"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showAddForm && (
        <div className="card" style={{ marginBottom: 20, padding: 18 }}>
          <div className="section-label">Add User</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 14 }}>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>Full Name</label>
              <input value={newFullName} placeholder="e.g. Priya Sharma" onChange={(e) => setNewFullName(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 240 }}>
              <label>Email</label>
              <input value={newEmail} placeholder="name@gocirkla.com" onChange={(e) => setNewEmail(e.target.value)} />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, paddingBottom: 8 }}>
              <input type="checkbox" checked={newIsAdmin} onChange={(e) => setNewIsAdmin(e.target.checked)} />
              Admin (can manage users)
            </label>
          </div>
          <div className="section-label" style={{ marginBottom: 8 }}>Module Permissions</div>
          <PermissionMatrix value={newPerms} onChange={(m, k, v) => setNewPerms((p) => ({ ...p, [m]: { ...p[m], [k]: v } }))} />
          <div style={{ marginTop: 14 }}>
            <button
              className="btn btn-primary"
              disabled={saving || !newEmail.trim() || !newFullName.trim()}
              onClick={handleAdd}
            >
              {saving ? "Adding…" : "Add User"}
            </button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <div className="showing-count">{loading ? "Loading…" : `${users.length} user${users.length === 1 ? "" : "s"}`}</div>
      </div>

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Name</th><th>Email</th><th>Admin</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.length === 0 ? (
              <tr className="empty-row"><td colSpan={5}>{loading ? "Loading…" : "No users yet — add one above."}</td></tr>
            ) : (
              users.map((u) => (
                <Fragment key={u.id}>
                  <tr>
                    <td>{u.full_name}</td>
                    <td className="mono">{u.email}</td>
                    <td>
                      <a style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => toggleAdmin(u)}>
                        {u.is_admin ? "Yes" : "No"}
                      </a>
                    </td>
                    <td><span className={`badge ${u.is_active ? "accepted" : "draft"}`}>{u.is_active ? "Active" : "Inactive"}</span></td>
                    <td style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => startEdit(u)}>
                        {expandedId === u.id ? "Close" : "Permissions"}
                      </a>
                      <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => toggleActive(u)}>
                        {u.is_active ? "Deactivate" : "Reactivate"}
                      </a>
                    </td>
                  </tr>
                  {expandedId === u.id && (
                    <tr>
                      <td colSpan={5} style={{ background: "var(--bg-2, #f7f7f5)", padding: 16 }}>
                        <PermissionMatrix
                          value={editPerms}
                          onChange={(m, k, v) => setEditPerms((p) => ({ ...p, [m]: { ...p[m], [k]: v } }))}
                        />
                        <div style={{ marginTop: 12 }}>
                          <button className="btn btn-primary" disabled={editSaving} onClick={() => saveEditPerms(u)}>
                            {editSaving ? "Saving…" : "Save Permissions"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
