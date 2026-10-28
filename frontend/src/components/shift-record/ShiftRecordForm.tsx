"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import CameraQrScanner from "@/components/storage/CameraQrScanner";
import type { Machine, ShiftRecordScanPreview, ShiftRecordUnit, SkuCode } from "@/lib/types";

const SHIFTS = ["Shift A", "Shift B", "Shift C"];
const TRAY_CATEGORIES = ["tray", "lnp_tray", "fgtray"];
// What to ask per material: the units that make sense for the SKU's category (first = default).
const UNITS_BY_CATEGORY: Record<string, ShiftRecordUnit[]> = {
  tray: ["Trays", "Pallets"], lnp_tray: ["Trays", "Pallets"],
  pad: ["Pcs", "Boxes", "Pallets"],
  glue: ["Boxes", "Kgs", "Pallets"],
};
const DEFAULT_UNITS: ShiftRecordUnit[] = ["Pallets", "Pcs", "Units"];
const unitsFor = (category: string | null | undefined) => UNITS_BY_CATEGORY[category || ""] || DEFAULT_UNITS;
const UNIT_LABEL: Record<string, string> = { Trays: "No. of trays", Pcs: "No. of pcs", Boxes: "No. of boxes", Kgs: "Kgs", Pallets: "No. of pallets", Units: "Units" };
/** What one whole pallet holds in `unit`, when Goods Receipt recorded it. */
function capacity(pv: ShiftRecordScanPreview | null, unit: ShiftRecordUnit): number | null {
  if (!pv) return null;
  const v = unit === "Pallets" ? 1 : unit === "Trays" ? pv.trays_per_pallet : unit === "Pcs" ? pv.pcs_per_pallet : unit === "Boxes" ? pv.boxes_per_pallet
    : unit === "Kgs" ? (pv.boxes_per_pallet && pv.kg_per_box ? pv.boxes_per_pallet * pv.kg_per_box : null) : null;
  return v && v > 0 ? v : null;
}
/** The unit and quantity a freshly scanned pallet starts with: the whole pallet. */
function wholePallet(pv: ShiftRecordScanPreview, category: string | null): { unit: ShiftRecordUnit; quantity: string } {
  for (const u of unitsFor(category)) {
    const c = capacity(pv, u);
    if (c) return { unit: u, quantity: String(c) };
  }
  return { unit: "Pallets", quantity: "1" };
}

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
  const [date, setDate] = useState(today());
  const [shift, setShift] = useState("");
  const [machineId, setMachineId] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [trays, setTrays] = useState("");
  const [perOverride, setPerOverride] = useState("");
  const [defaultPer, setDefaultPer] = useState<number | null>(null);
  const [scrapReason, setScrapReason] = useState("");
  const [carryIn, setCarryIn] = useState(0);
  const [scrap, setScrap] = useState("");
  const [hold, setHold] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [cameraFor, setCameraFor] = useState<number | null>(null);

  useEffect(() => {
    api.machines().then(setMachines).catch(() => {});
  }, []);


  // The FG SKU is whichever tray was scanned; its Total Pcs per Pallet is Production's own number.
  const trayLine = lines.find((l) => l.checked && TRAY_CATEGORIES.includes(l.checked.category || ""));
  const fgVersionId = trayLine?.checked?.sku_version_id || null;
  const traySkuId = trayLine?.checked?.sku_code_id || "";
  useEffect(() => {
    setDefaultPer(null);
    if (fgVersionId) api.getShiftRecordPcsPerPallet(fgVersionId).then(setDefaultPer).catch(() => {});
    else if (traySkuId) api.getSkuPcsPerPallet(traySkuId).then(setDefaultPer).catch(() => {});
  }, [fgVersionId, traySkuId]);
  useEffect(() => {
    setCarryIn(0);
    if (traySkuId) api.getShiftRecordCarryIn(traySkuId).then(setCarryIn).catch(() => {});
  }, [traySkuId]);

  const traysN = Number(trays) || 0;
  const per = Number(perOverride) > 0 ? Math.trunc(Number(perOverride)) : defaultPer;
  // Trays used on this record (all tray pallets, possibly several of the same SKU): produced + scrap - hold must equal it.
  const traysUsed = lines.reduce((sum, l) => {
    if (!l.checked || !TRAY_CATEGORIES.includes(l.checked.category || "")) return sum;
    const q = Number(l.quantity) || 0;
    if (l.unit === "Trays") return sum + q;
    if (l.unit === "Pallets") return sum + q * (l.checked?.trays_per_pallet || 0);
    return sum;
  }, 0);
  const scrapN = Number(scrap) || 0;
  const holdN = Number(hold) || 0;
  const accounted = traysN + scrapN - holdN;
  const balanced = traysUsed > 0 && accounted === traysUsed;

  // As Production: full pallets only (trays / Total Pcs per Pallet); the rest are loose trays.
  const pool = traysN + (traysN > 0 ? carryIn : 0);
  const fgPallets = traysN > 0 && per && per > 0 ? Math.floor(pool / per) : 0;
  const looseTrays = traysN > 0 && per && per > 0 ? pool - fgPallets * per : 0;

  function patch(key: number, p: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  async function check(l: Line, scanText?: string) {
    const scan = (scanText ?? l.scan).trim();
    if (!scan) return;
    patch(l.key, { checking: true, lineError: null });
    try {
      const pv = await api.previewShiftRecordScan(scan, null);
      setCameraFor(null);
      const dup = lines.find((o) => o.key !== l.key && o.checked?.pallet_id === pv.pallet_id);
      if (dup) throw new Error(`Pallet ${pv.display_id} is already on this record.`);
      // Picking the pallet first? Fill the SKU in from what was scanned.
      // Start from the whole pallet (e.g. 2112 trays, 5000 pcs); the person lowers it if only some was used.
      patch(l.key, { checking: false, checked: pv, skuId: pv.sku_code_id || "", scan: pv.display_id, fully: true, ...wholePallet(pv, pv.category) });
    } catch (e) {
      setCameraFor(null);
      patch(l.key, { checking: false, checked: null, scan, lineError: e instanceof Error ? e.message : "Could not check this pallet." });
    }
  }

  async function handleSave() {
    setError(null);
    if (!date) return setError("Select the Date.");
    if (!shift) return setError("Select a Shift.");
    if (!machineId) return setError("Select a Machine.");
    const used = lines.filter((l) => l.scan.trim() || l.checked);
    if (used.length === 0) return setError("Add at least one material used.");
    for (const [i, l] of used.entries()) {
      if (!l.checked) return setError(`Material ${i + 1}: scan the RM pallet QR (it is compulsory).`);
      if (!(Number(l.quantity) > 0)) return setError(`Material ${i + 1}: enter the quantity used.`);
    }
    if (traysUsed > 0 && accounted !== traysUsed) return setError(`Trays produced (${traysN}) + scrap (${scrapN}) - hold (${holdN}) = ${accounted}, but ${traysUsed} trays were used. They must be equal.`);
    if (traysN > 0 && !(per && per > 0)) return setError("Trays per Pallet is not set for this tray SKU — enter it so the pallets can be worked out.");
    setSaving(true);
    try {
      const res = await api.saveShiftRecord({
        record_date: date, shift, machine_id: machineId, client_time: new Date().toLocaleString(), notes: notes.trim() || undefined,
        trays_produced: traysN, scrap_trays: Number(scrap) || 0, hold_trays: holdN, scrap_reason: scrapReason.trim() || undefined, total_pcs_per_pallet: Number(perOverride) > 0 ? Math.trunc(Number(perOverride)) : null,
        materials: used.map((l) => ({
          sku_code_id: l.checked?.sku_code_id || null, scan: l.scan.trim(), quantity: Number(l.quantity), unit: l.unit, fully_consumed: l.fully,
        })),
      });
      onSaved(res.id);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Failed to save the Shift Record");
    } finally {
      setSaving(false);
    }
  }

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
              Trays, pads, glue, polybags… scan the RM pallet QR (compulsory; the SKU comes from it), then enter how much was used. Add a line for each material.
            </div>
            {lines.map((l, i) => {
              const category = l.checked?.category || null;
              const units = unitsFor(category);
              const cap = capacity(l.checked, l.unit);
              const q = Number(l.quantity) || 0;
              return (
                <div key={l.key} style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  <div className="form-grid">
                    <div className="field" style={{ gridColumn: "1 / -1" }}>
                      <label>RM Pallet QR {i + 1} <span style={{ color: "var(--red)" }}>*</span> {l.checked && <span style={{ color: "var(--green, #15803d)" }}>✓</span>}</label>
                      {cameraFor === l.key ? (
                        <CameraQrScanner onDetected={(text) => check(l, text)} onCancel={() => setCameraFor(null)} />
                      ) : (
                        <div style={{ display: "flex", gap: 6 }}>
                          <input
                            ref={(el) => { scanRefs.current[l.key] = el; }}
                            className="mono" placeholder="Scan or type, then Enter" value={l.scan} style={{ flex: 1 }}
                            onChange={(e) => patch(l.key, { scan: e.target.value, checked: null, lineError: null })}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); check(l); } }}
                            onBlur={() => { if (l.scan.trim() && !l.checked && !l.checking && !l.lineError) check(l); }}
                          />
                          <button type="button" className="btn btn-secondary" onClick={() => setCameraFor(l.key)}>📷 Scan</button>
                        </div>
                      )}
                    </div>
                    <div className="field">
                      <label>Pallets</label>
                      <div className="readonly-val">1 <span className="hint-text">(this QR)</span></div>
                    </div>
                    <div className="field">
                      <label>{UNIT_LABEL[l.unit] || l.unit} used</label>
                      <input type="number" min="0" step="any" value={l.quantity} onChange={(e) => patch(l.key, { quantity: e.target.value })} />
                    </div>
                    <div className="field">
                      <label>Counted in</label>
                      <select value={l.unit} onChange={(e) => {
                        const unit = e.target.value as ShiftRecordUnit;
                        const c = capacity(l.checked, unit);
                        patch(l.key, { unit, quantity: c ? String(c) : unit === "Pallets" ? "1" : "" });
                      }}>
                        {units.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, gap: 10 }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={cap ? q >= cap : l.fully}
                        disabled={l.unit === "Pallets" && !!cap}
                        onChange={(e) => {
                          if (cap) patch(l.key, { fully: e.target.checked, quantity: e.target.checked ? String(cap) : "" });
                          else patch(l.key, { fully: e.target.checked });
                        }}
                      />
                      Pallet fully used
                    </label>
                    {lines.length > 1 && <button className="btn-tertiary" onClick={() => setLines((ls) => ls.filter((o) => o.key !== l.key))}>Remove</button>}
                  </div>
                  <div className="hint-text" style={{ marginTop: 4 }}>
                    <b>Pallet fully used</b> — tick it when nothing is left on this pallet: it is marked consumed and cannot be used again.
                    Untick it when some is left: the pallet stays in stock (it only leaves its shelf) and only the quantity you enter comes off Inventory.
                    {cap ? ` A full pallet holds ${cap.toLocaleString()} ${l.unit.toLowerCase()}; entering that much ticks it for you.` : ""}
                  </div>
                  {l.checking && <div className="hint-text">Checking…</div>}
                  {l.checked && <div className="hint-text">{l.checked.display_id} · {l.checked.sku_code || "—"}{l.checked.shipment_number ? ` · ${l.checked.shipment_number}` : ""}</div>}
                  {l.lineError && <div className="error-banner" style={{ marginTop: 6 }}>{l.lineError}</div>}
                </div>
              );
            })}
            <button className="btn btn-ghost" onClick={() => setLines((ls) => [...ls, newLine()])}>+ Add material</button>
          </div>

          <div className="detail-card">
            <h3>Trays Produced (Finished)</h3>
            <div className="hint-text" style={{ marginBottom: 10 }}>
              Enter the finished trays produced. FG Pallets is worked out from it (trays / Trays per Pallet, full pallets only); the rest are loose trays.
              {" The FG pallets and QRs are made at the end, from the record, by Generate FG QRs; loose trays left over from earlier shifts of the same SKU are added in then."}
              {traysN > 0 && !trayLine && " Pick the tray SKU in Materials Used above — the FG tray SKU comes from it."}
            </div>
            <div className="form-grid">
              <div className="field">
                <label>Trays Produced (Finished)</label>
                <input type="number" min="0" step="1" value={trays} onChange={(e) => setTrays(e.target.value)} />
              </div>
              <div className="field">
                <label>Trays per Pallet {defaultPer ? <span className="hint-text">(SKU: {defaultPer})</span> : null}</label>
                <input type="number" min="1" step="1" placeholder={defaultPer ? String(defaultPer) : "—"} value={perOverride} onChange={(e) => setPerOverride(e.target.value)} />
              </div>
              <div className="field">
                <label>FG Pallets <span className="hint-text">(auto)</span></label>
                <div className="readonly-val mono"><b>{traysN > 0 && per ? fgPallets : "—"}</b></div>
              </div>
              <div className="field">
                <label>Loose Trays <span className="hint-text">(not a full pallet)</span></label>
                <div className="readonly-val mono">{traysN > 0 && per ? looseTrays : "—"}</div>
              </div>
            </div>
            {carryIn > 0 && traysN > 0 && (
              <div className="hint-text" style={{ marginTop: 8 }}>
                Includes {carryIn.toLocaleString()} loose trays carried from earlier shifts: {traysN.toLocaleString()} + {carryIn.toLocaleString()} = {pool.toLocaleString()} trays to make pallets from.
              </div>
            )}
          </div>

          <div className="detail-card">
            <h3>Scrap</h3>
            {traysUsed > 0 && (
              <div className="hint-text" style={{ marginBottom: 10, color: balanced ? "var(--green, #15803d)" : "var(--red, #b91c1c)" }}>
                Trays used {traysUsed.toLocaleString()} = produced {traysN.toLocaleString()} + scrap {scrapN.toLocaleString()} − hold {holdN.toLocaleString()} ({accounted.toLocaleString()})
                {balanced ? " ✓" : ` — ${accounted > traysUsed ? "over" : "short"} by ${Math.abs(traysUsed - accounted).toLocaleString()}`}
              </div>
            )}
            <div className="form-grid">
              <div className="field">
                <label>Scrap Trays</label>
                <input type="number" min="0" step="1" value={scrap} onChange={(e) => setScrap(e.target.value)} />
              </div>
              <div className="field">
                <label>Reason</label>
                <input value={scrapReason} onChange={(e) => setScrapReason(e.target.value)} placeholder="Optional" />
              </div>
            </div>
          </div>

          <div className="detail-card">
            <h3>Hold</h3>
            <div className="hint-text" style={{ marginBottom: 10 }}>
              Trays set aside on hold. Trays used = finished + scrap − hold. Hold trays do not become FG pallets.
            </div>
            <div className="form-grid">
              <div className="field">
                <label>Hold Trays</label>
                <input type="number" min="0" step="1" value={hold} onChange={(e) => setHold(e.target.value)} />
              </div>
              <div className="field">
                <label>Notes</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
              </div>
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
