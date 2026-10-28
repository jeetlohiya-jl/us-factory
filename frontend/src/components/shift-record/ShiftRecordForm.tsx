"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Machine, ShiftRecordScanPreview, ShiftRecordUnit, SkuCode } from "@/lib/types";

const SHIFTS = ["Shift A", "Shift B", "Shift C"];
const TRAY_CATEGORIES = ["tray", "lnp_tray", "fgtray"];
const UNITS: ShiftRecordUnit[] = ["Pallets", "Boxes", "Pcs", "Kgs"];

type Line = {
  key: number;
  skuId: string;
  scan: string;
  checked: ShiftRecordScanPreview | null;   // the scan, once confirmed against the SKU
  checking: boolean;
  lineError: string | null;
  quantity: string;
  unit: ShiftRecordUnit;
  fully: boolean;
};

let lineKey = 1;
const newLine = (): Line => ({ key: lineKey++, skuId: "", scan: "", checked: null, checking: false, lineError: null, quantity: "1", unit: "Pallets", fully: true });
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/**
 * New Shift Record: one shift on one machine. What was used (each material:
 * SKU -> its RM pallet QR -> quantity), what was produced (FG trays -> pallets,
 * worked out as Production does) and the scrap. Saving takes the materials off
 * Inventory, marks the pallets used and creates the FG pallets (migration 0103).
 */
export default function ShiftRecordForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [skus, setSkus] = useState<SkuCode[]>([]);
  const [date, setDate] = useState(today());
  const [shift, setShift] = useState("");
  const [machineId, setMachineId] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [trays, setTrays] = useState("");
  const [perOverride, setPerOverride] = useState("");
  const [defaultPer, setDefaultPer] = useState<number | null>(null);
  const [scrap, setScrap] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    api.machines().then(setMachines).catch(() => {});
    api.skus().then((all) => setSkus(all.filter((s) => s.category !== ("fgtray" as string)))).catch(() => {});
  }, []);

  const skuById = useMemo(() => new Map(skus.map((s) => [s.id, s])), [skus]);
  const isTraySku = (id: string) => TRAY_CATEGORIES.includes(skuById.get(id)?.category || "");

  // The FG SKU is whichever tray was scanned; its Total Pcs per Pallet is Production's own number.
  const trayLine = lines.find((l) => l.checked && TRAY_CATEGORIES.includes(l.checked.category || ""));
  const fgVersionId = trayLine?.checked?.sku_version_id || null;
  useEffect(() => {
    setDefaultPer(null);
    if (fgVersionId) api.getShiftRecordPcsPerPallet(fgVersionId).then(setDefaultPer).catch(() => {});
  }, [fgVersionId]);

  const traysN = Number(trays) || 0;
  const per = Number(perOverride) > 0 ? Math.trunc(Number(perOverride)) : defaultPer;
  const palletPlan = useMemo(() => {
    if (!(traysN > 0) || !per || per <= 0) return [];
    const n = Math.max(Math.floor(traysN / per), 1);
    return Array.from({ length: n }, (_, i) => (n === 1 ? traysN : i === n - 1 ? traysN - per * (n - 1) : per));
  }, [traysN, per]);

  function patch(key: number, p: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  function onSkuChange(l: Line, skuId: string) {
    const tray = isTraySku(skuId);
    patch(l.key, { skuId, checked: null, lineError: null, scan: "", unit: "Pallets", quantity: "1", fully: true });
  }

  async function check(l: Line) {
    const scan = l.scan.trim();
    if (!scan) return;
    patch(l.key, { checking: true, lineError: null });
    try {
      const pv = await api.previewShiftRecordScan(scan, l.skuId || null);
      const dup = lines.find((o) => o.key !== l.key && o.checked?.pallet_id === pv.pallet_id);
      if (dup) throw new Error(`Pallet ${pv.display_id} is already on this record.`);
      // Picking the pallet first? Fill the SKU in from what was scanned.
      patch(l.key, { checking: false, checked: pv, skuId: l.skuId || pv.sku_code_id || "", scan: pv.display_id,
        ...(TRAY_CATEGORIES.includes(pv.category || "") ? { unit: "Pallets" as ShiftRecordUnit, quantity: "1", fully: true } : {}) });
    } catch (e) {
      patch(l.key, { checking: false, checked: null, lineError: e instanceof Error ? e.message : "Could not check this pallet." });
    }
  }

  async function handleSave() {
    setError(null);
    if (!date) return setError("Select the Date.");
    if (!shift) return setError("Select a Shift.");
    if (!machineId) return setError("Select a Machine.");
    const used = lines.filter((l) => l.scan.trim() || l.skuId);
    if (used.length === 0) return setError("Add at least one material used.");
    for (const [i, l] of used.entries()) {
      if (!l.scan.trim()) return setError(`Material ${i + 1}: scan or type the RM pallet QR value.`);
      if (!(Number(l.quantity) > 0)) return setError(`Material ${i + 1}: enter the quantity used.`);
    }
    if (traysN > 0 && palletPlan.length === 0) return setError("Total Pcs per Pallet is not set for this tray SKU — enter it so the pallets can be worked out.");
    setSaving(true);
    try {
      const res = await api.saveShiftRecord({
        record_date: date, shift, machine_id: machineId, client_time: new Date().toLocaleString(), notes: notes.trim() || undefined,
        trays_produced: traysN, scrap_trays: Number(scrap) || 0, total_pcs_per_pallet: Number(perOverride) > 0 ? Math.trunc(Number(perOverride)) : null,
        materials: used.map((l) => ({
          sku_code_id: l.skuId || null, scan: l.scan.trim(), quantity: Number(l.quantity), unit: l.unit, fully_consumed: l.fully,
        })),
      });
      onSaved(res.id);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Failed to save the Shift Record");
    } finally {
      setSaving(false);
    }
  }

  const skuLabel = (s: SkuCode) => (s.sku_code && s.sku_code !== s.code ? `${s.code} (${s.sku_code})` : s.code);

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open" style={{ width: "min(760px, 100vw)" }}>
        <div className="sp-head">
          <div><h2>New Shift Record</h2></div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          <div className="detail-card">
            <h3>Shift</h3>
            <div className="form-grid">
              <div className="field">
                <label>Date <span style={{ color: "var(--red)" }}>*</span></label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="field">
                <label>Shift <span style={{ color: "var(--red)" }}>*</span></label>
                <select value={shift} onChange={(e) => setShift(e.target.value)}>
                  <option value="">Select</option>
                  {SHIFTS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Machine <span style={{ color: "var(--red)" }}>*</span></label>
                <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                  <option value="">Select</option>
                  {machines.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="detail-card">
            <h3>Materials Used</h3>
            <div className="hint-text" style={{ marginBottom: 10 }}>
              Trays, pads, glue, polybags… pick the SKU, scan its RM pallet QR, then enter how much was used. Add a line for each material.
            </div>
            {lines.map((l, i) => {
              const tray = l.checked ? TRAY_CATEGORIES.includes(l.checked.category || "") : isTraySku(l.skuId);
              return (
                <div key={l.key} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  <div className="form-grid">
                    <div className="field">
                      <label>SKU {i + 1}</label>
                      <select value={l.skuId} onChange={(e) => onSkuChange(l, e.target.value)}>
                        <option value="">Select</option>
                        {skus.map((s) => <option key={s.id} value={s.id}>{skuLabel(s)}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label>RM Pallet QR {l.checked && <span style={{ color: "var(--green, #15803d)" }}>✓</span>}</label>
                      <input
                        ref={(el) => { scanRefs.current[l.key] = el; }}
                        className="mono" placeholder="Scan or type, then Enter" value={l.scan}
                        onChange={(e) => patch(l.key, { scan: e.target.value, checked: null, lineError: null })}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); check(l); } }}
                        onBlur={() => { if (l.scan.trim() && !l.checked && !l.checking && !l.lineError) check(l); }}
                      />
                    </div>
                    <div className="field">
                      <label>Quantity used</label>
                      <input type="number" min="0" step="any" value={l.quantity} disabled={tray} onChange={(e) => patch(l.key, { quantity: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Unit</label>
                      <select value={l.unit} disabled={tray} onChange={(e) => patch(l.key, { unit: e.target.value as ShiftRecordUnit })}>
                        {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, gap: 10 }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                      <input type="checkbox" checked={l.fully} disabled={tray} onChange={(e) => patch(l.key, { fully: e.target.checked })} />
                      Pallet fully used <span className="hint-text">(untick if some is left — it stays in stock, off its shelf)</span>
                    </label>
                    {lines.length > 1 && <button className="btn-tertiary" onClick={() => setLines((ls) => ls.filter((o) => o.key !== l.key))}>Remove</button>}
                  </div>
                  {l.checking && <div className="hint-text">Checking…</div>}
                  {l.checked && <div className="hint-text">{l.checked.display_id} · {l.checked.sku_code || "—"}{l.checked.shipment_number ? ` · ${l.checked.shipment_number}` : ""}{tray ? " · tray pallets are used whole" : ""}</div>}
                  {l.lineError && <div className="error-banner" style={{ marginTop: 6 }}>{l.lineError}</div>}
                </div>
              );
            })}
            <button className="btn btn-ghost" onClick={() => setLines((ls) => [...ls, newLine()])}>+ Add material</button>
          </div>

          <div className="detail-card">
            <h3>Produced &amp; Scrap</h3>
            <div className="form-grid">
              <div className="field">
                <label>FG Trays Produced</label>
                <input type="number" min="0" step="1" value={trays} onChange={(e) => setTrays(e.target.value)} />
              </div>
              <div className="field">
                <label>Total Pcs per Pallet {defaultPer ? <span className="hint-text">(SKU: {defaultPer})</span> : null}</label>
                <input type="number" min="1" step="1" placeholder={defaultPer ? String(defaultPer) : "—"} value={perOverride} onChange={(e) => setPerOverride(e.target.value)} />
              </div>
              <div className="field">
                <label>Scrap Trays</label>
                <input type="number" min="0" step="1" value={scrap} onChange={(e) => setScrap(e.target.value)} />
              </div>
              <div className="field">
                <label>FG Pallets</label>
                <div className="readonly-val mono">{palletPlan.length ? palletPlan.length : "—"}</div>
              </div>
            </div>
            {palletPlan.length > 0 && (
              <div className="hint-text" style={{ marginTop: 8 }}>
                {trayLine?.checked?.sku_code || "FG"}: {palletPlan.map((n, i) => `Pallet ${i + 1}: ${n} trays`).join(" · ")} — the last pallet carries any remainder.
              </div>
            )}
            {traysN > 0 && !trayLine && <div className="hint-text" style={{ marginTop: 8 }}>Scan the tray pallet that was consumed above — the FG tray SKU comes from it.</div>}
            <div className="field" style={{ marginTop: 10 }}>
              <label>Notes</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? "Saving…" : "Save Shift Record"}</button>
        </div>
      </div>
    </>
  );
}
