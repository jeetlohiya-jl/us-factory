"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { Customer } from "@/lib/types";

/**
 * Admin screen for the Customer master list backing Goods Outward's
 * Customer / Recipient dropdown (2026-09-24), replacing what used to be a
 * freehand text field on Customer Shipment / Goods Outward's "New Record"
 * panel. Gated on the same customer_shipment module permission that
 * module already uses (can_edit to add/deactivate/delete) rather than a
 * separate module -- same "reuse the permission of the module this master
 * data serves" convention as /vendors's own page.
 */
export default function CustomersPage() {
  const me = useMe();
  const perms = me?.permissions.customer_shipment;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  // 2026-09-25 -- Address feeds the Goods Outward "Print Packing List"
  // step's Consignee Address / default Ship To, edited separately from
  // the name (its own inline textarea per row, saved on blur).
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [editingAddressValue, setEditingAddressValue] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCustomers(await api.customers({ includeInactive: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load customers");
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
      await api.createCustomer(name, newAddress.trim() || null);
      setNewName("");
      setNewAddress("");
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add customer");
    }
  }

  async function handleSaveName(c: Customer) {
    const name = editingValue.trim();
    if (!name) return;
    setError(null);
    try {
      await api.updateCustomer(c.id, { name });
      setEditingId(null);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update customer");
    }
  }

  async function handleSaveAddress(c: Customer) {
    setError(null);
    try {
      // Always send a string (possibly empty), never null/undefined -- the
      // backend only touches address `if payload.address is not None`, so
      // an explicit null here would be indistinguishable from "field
      // omitted" and clearing an existing address would silently no-op.
      await api.updateCustomer(c.id, { address: editingAddressValue.trim() });
      setEditingAddressId(null);
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to update address");
    }
  }

  async function toggleActive(c: Customer) {
    try {
      await api.updateCustomer(c.id, { is_active: !c.is_active });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update customer");
    }
  }

  async function handleDelete(c: Customer) {
    if (!confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteCustomer(c.id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete customer");
    }
  }

  const canEdit = !!perms?.can_edit;
  const visible = customers.filter((c) => showInactive || c.is_active);

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Customers</h1>
          <div className="desc">Manages the Customer list used by the Customer / Recipient dropdown on Goods Outward.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {canEdit && (
        <div className="card" style={{ marginBottom: 20, padding: 18 }}>
          <div className="section-label">Add Customer</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>Customer / Recipient Name</label>
              <input
                value={newName} placeholder="e.g. 3P China"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 260 }}>
              <label>Address (optional)</label>
              <input
                value={newAddress} placeholder="e.g. 305 Myles Standish Boulevard, Taunton, MA 02780"
                onChange={(e) => setNewAddress(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </div>
            <button className="btn btn-primary" disabled={!newName.trim()} onClick={handleAdd}>+ Add Customer</button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive customers
        </label>
        <div className="showing-count">{loading ? "Loading…" : `${visible.length} customer${visible.length === 1 ? "" : "s"}`}</div>
      </div>

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Customer Name</th><th>Address</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {visible.length === 0 ? (
              <tr className="empty-row"><td colSpan={4}>{loading ? "Loading…" : "No customers yet — add one above."}</td></tr>
            ) : (
              visible.map((c) => (
                <tr key={c.id}>
                  <td className="mono">
                    {editingId === c.id ? (
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          autoFocus value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleSaveName(c)}
                        />
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => handleSaveName(c)}>Save</a>
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => setEditingId(null)}>Cancel</a>
                      </span>
                    ) : (
                      <a
                        style={{ cursor: canEdit ? "pointer" : "default", textDecoration: canEdit ? "underline" : "none" }}
                        onClick={() => { if (canEdit) { setEditingId(c.id); setEditingValue(c.name); } }}
                      >
                        {c.name}
                      </a>
                    )}
                  </td>
                  <td>
                    {editingAddressId === c.id ? (
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          autoFocus value={editingAddressValue} placeholder="No address on file"
                          onChange={(e) => setEditingAddressValue(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleSaveAddress(c)}
                        />
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => handleSaveAddress(c)}>Save</a>
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => setEditingAddressId(null)}>Cancel</a>
                      </span>
                    ) : (
                      <a
                        style={{ cursor: canEdit ? "pointer" : "default", textDecoration: canEdit ? "underline" : "none", color: c.address ? undefined : "var(--ink-40, #999)" }}
                        onClick={() => { if (canEdit) { setEditingAddressId(c.id); setEditingAddressValue(c.address || ""); } }}
                      >
                        {c.address || "— add address —"}
                      </a>
                    )}
                  </td>
                  <td><span className={`badge ${c.is_active ? "accepted" : "draft"}`}>{c.is_active ? "Active" : "Inactive"}</span></td>
                  <td style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    {canEdit && (
                      <>
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => toggleActive(c)}>
                          {c.is_active ? "Deactivate" : "Reactivate"}
                        </a>
                        <a className="btn-tertiary" style={{ cursor: "pointer", color: "var(--red)" }} onClick={() => handleDelete(c)}>
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
