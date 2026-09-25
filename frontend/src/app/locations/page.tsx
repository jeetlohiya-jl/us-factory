"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { LocationAdmin } from "@/lib/types";
import { MODULE_NAMES } from "@/lib/terms";
import { T } from "@/lib/terms";

// One zone per material. "FNPG" belongs only to FNP Trays -- secondary
// materials are not FNP, so their zones are just the material. FG stays FPG.
// (Existing locations keep their names; this is the list for new ones.)
const ZONES: { code: string; label: string }[] = [
  { code: "TRAY", label: T.baseTray },
  { code: "FNPGTRAY", label: T.fnpTray },
  { code: "FILM", label: "Film" },
  { code: "PAD", label: "Soaker Pad" },
  { code: "POLYBAG", label: "Polybag" },
  { code: "CFB", label: "CFB" },
  { code: "GLUE", label: "Glue" },
  { code: "FPG", label: T.finishedGoods },
];

const two = (v: string) => (v.trim() ? v.trim().padStart(2, "0").slice(-2) : "");

function LocationQr({ loc }: { loc: LocationAdmin }) {
  const [src, setSrc] = useState<string | null>(loc.qr_url ? api.mediaUrl(loc.qr_url) : null);
  useEffect(() => {
    if (loc.qr_url) return;
    const payload = loc.qr_payload || JSON.stringify({ t: "location", id: loc.display_id, zone: loc.zone });
    QRCode.toDataURL(payload, { margin: 1, width: 240 }).then(setSrc).catch(() => setSrc(null));
  }, [loc]);
  return (
    <div className="qr-tile">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt={`QR for ${loc.display_id}`} /> : <div style={{ width: 120, height: 120, background: "var(--ink-08)" }} />}
      <div className="qr-id">{loc.display_id}</div>
    </div>
  );
}

/**
 * Setup -> Locations: the storage locations RM / FG Storage scan. Per unit
 * (migration 0048) -- Factory and US Factory each manage their own list.
 * New locations follow the existing naming convention
 * <ZONE>-A##-R##-L##-P##-<letter>, built from the fields below, and get a
 * printable QR label (same 2x2in label printing as pallet QRs).
 * Gated on RM Storage edit, the module that uses them.
 */
export default function LocationsPage() {
  const me = useMe();
  const canEdit = !!me?.permissions.rm_storage?.can_edit;
  const [locations, setLocations] = useState<LocationAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [zone, setZone] = useState("");
  const [aisle, setAisle] = useState("");
  const [rack, setRack] = useState("");
  const [level, setLevel] = useState("");
  const [position, setPosition] = useState("");
  const [sub, setSub] = useState("A");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLocations(await api.locationsAdmin(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load locations");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const displayId = useMemo(() => {
    if (!zone || !two(aisle) || !two(rack) || !two(level) || !two(position) || !sub.trim()) return "";
    return `${zone}-A${two(aisle)}-R${two(rack)}-L${two(level)}-P${two(position)}-${sub.trim().toUpperCase().slice(0, 1)}`;
  }, [zone, aisle, rack, level, position, sub]);

  async function handleAdd() {
    if (!displayId) return;
    setError(null);
    try {
      await api.createLocation(displayId, zone);
      setPosition("");
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add location");
    }
  }

  async function toggleActive(l: LocationAdmin) {
    try {
      await api.updateLocation(l.id, { is_active: !l.is_active });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update location");
    }
  }

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  const visible = locations.filter((l) => showInactive || l.is_active);
  const toPrint = locations.filter((l) => selected.has(l.id));

  return (
    <>
      <div className="no-print">
        <div className="page-head2">
          <div>
            <h1>{MODULE_NAMES.locations}</h1>
            <div className="desc">Storage locations scanned in RM Storage and FG Storage, with their QR labels.</div>
          </div>
          <button className="btn btn-secondary" disabled={toPrint.length === 0} onClick={() => window.print()}>
            Print {toPrint.length || ""} QR Label{toPrint.length === 1 ? "" : "s"}
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {canEdit && (
          <div className="card" style={{ marginBottom: 20, padding: 18 }}>
            <div className="section-label">Add Location</div>
            <div className="form-grid">
              <div className="field"><label>Zone</label>
                <select value={zone} onChange={(e) => setZone(e.target.value)}>
                  <option value="">Select zone</option>
                  {ZONES.map((z) => <option key={z.code} value={z.code}>{z.code} — {z.label}</option>)}
                </select></div>
              <div className="field"><label>Aisle</label><input type="number" min={1} max={99} value={aisle} onChange={(e) => setAisle(e.target.value)} /></div>
              <div className="field"><label>Rack</label><input type="number" min={1} max={99} value={rack} onChange={(e) => setRack(e.target.value)} /></div>
              <div className="field"><label>Level</label><input type="number" min={1} max={99} value={level} onChange={(e) => setLevel(e.target.value)} /></div>
              <div className="field"><label>Position</label><input type="number" min={1} max={99} value={position} onChange={(e) => setPosition(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAdd()} /></div>
              <div className="field"><label>Sub-position</label><input maxLength={1} value={sub} onChange={(e) => setSub(e.target.value.toUpperCase())} /></div>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button className="btn btn-primary" disabled={!displayId} onClick={handleAdd}>+ Add Location</button>
              <span className="mono" style={{ color: "var(--ink-50)" }}>{displayId || "Fill every field to build the Location ID"}</span>
            </div>
          </div>
        )}

        <div className="toolbar">
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive locations
          </label>
          <div className="showing-count">{loading ? "Loading…" : `${visible.length} location${visible.length === 1 ? "" : "s"}`}</div>
        </div>

        <div className="card card-flush">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" aria-label="Select all for printing"
                    checked={visible.length > 0 && visible.every((l) => selected.has(l.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((l) => l.id)) : new Set())} />
                </th>
                <th>Location ID</th><th>Zone</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr className="empty-row"><td colSpan={5}>{loading ? "Loading…" : "No locations yet — add one above."}</td></tr>
              ) : (
                visible.map((l) => (
                  <tr key={l.id}>
                    <td><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Print ${l.display_id}`} /></td>
                    <td className="mono">{l.display_id}</td>
                    <td className="mono">{l.zone}</td>
                    <td><span className={`badge ${l.is_active ? "accepted" : "draft"}`}>{l.is_active ? "Active" : "Inactive"}</span></td>
                    <td style={{ textAlign: "right" }}>
                      {canEdit && (
                        <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => toggleActive(l)}>
                          {l.is_active ? "Deactivate" : "Reactivate"}
                        </a>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* One 2in x 2in label per selected location (globals.css print rules). */}
      <div className="print-only">
        {toPrint.map((l) => (
          <div className="qr-print-page" key={l.id}>
            <div className="qr-print-label"><LocationQr loc={l} /></div>
          </div>
        ))}
      </div>
    </>
  );
}
