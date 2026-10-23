"use client";
import { useState } from "react";
import type { QrLabel } from "@/lib/qrLabels";
import {
  DEFAULT_SHEET_SETTINGS, SHEET_PER_PAGE, loadSheetSettings, printLabelSheet, saveSheetSettings, sheetCount, type SheetSettings,
} from "@/lib/sheetPrint";

/**
 * Factory only: "Print on label sheet" -- 20 QR labels per US Letter page
 * (PLS-289MW, 2" x 2", 4 x 5) on the Epson. Shown wherever the D50 / image
 * buttons are (QR panel, Locations).
 */
export default function LabelSheetPrint({ labels, disabled }: { labels: () => QrLabel[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<SheetSettings>(DEFAULT_SHEET_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const n = labels().length;
  const sheets = sheetCount(n, s.start);
  const num = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);

  async function go(outlines: boolean) {
    setErr(null); setBusy(true);
    try {
      const next = { ...s, outlines };
      saveSheetSettings(next);
      await printLabelSheet(labels(), next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not prepare the sheet");
    } finally { setBusy(false); }
  }

  return (
    <>
      <button className="btn btn-primary" disabled={disabled || n === 0} onClick={() => { setS(loadSheetSettings()); setOpen(true); }}>
        Print on label sheet ({n})
      </button>
      {open && (
        <div className="modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }} onClick={() => !busy && setOpen(false)}>
          <div className="card" style={{ width: 440, maxWidth: "94vw", padding: 22 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Print on label sheet</h3>
            <div className="hint-text" style={{ marginTop: 0 }}>
              2&quot; × 2&quot; labels (PLS-289MW), {SHEET_PER_PAGE} per Letter sheet. {n} label{n === 1 ? "" : "s"} → {sheets} sheet{sheets === 1 ? "" : "s"}.
            </div>
            <div className="form-grid" style={{ marginTop: 12 }}>
              <div className="field">
                <label>Start at label slot (1–{SHEET_PER_PAGE})</label>
                <input type="number" min={1} max={SHEET_PER_PAGE} value={s.start} onChange={(e) => setS({ ...s, start: Math.min(SHEET_PER_PAGE, Math.max(1, Math.floor(num(e.target.value)) || 1)) })} />
                <div className="hint-text" style={{ margin: "4px 0 0" }}>Slots count left→right, top→bottom. Use this to finish a part-used sheet.</div>
              </div>
              <div className="field">
                <label>Nudge right (in)</label>
                <input type="number" step={0.01} value={s.offsetX} onChange={(e) => setS({ ...s, offsetX: num(e.target.value) })} />
              </div>
              <div className="field">
                <label>Nudge down (in)</label>
                <input type="number" step={0.01} value={s.offsetY} onChange={(e) => setS({ ...s, offsetY: num(e.target.value) })} />
              </div>
            </div>
            <div className="hint-text">
              In the print window choose the Epson, paper Letter (type: Labels), <b>Scale 100%</b> / not &quot;fit to page&quot;, margins none. If the print sits off the labels, run an alignment test on plain paper, hold it against a label sheet and adjust the nudges (saved for next time).
            </div>
            {err && <div className="error-banner">{err}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>Close</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => go(true)}>Alignment test</button>
              <button className="btn btn-primary" disabled={busy || n === 0} onClick={() => go(false)}>{busy ? "Preparing…" : "Print"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
