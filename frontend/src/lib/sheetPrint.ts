"use client";
import type { QrLabel } from "./qrLabels";

/**
 * Print QR labels on a laser/inkjet label SHEET (Factory only): Premium Label
 * Supply PLS-289MW -- 2" x 2" labels, 4 across x 5 down = 20 per US Letter
 * sheet -- on the Epson. Opens the browser's print dialog on a page laid out
 * in exact inches (Letter, no margins); pick the Epson, paper "Letter" /
 * type "Labels", scale 100% (not "fit to page").
 */
export type SheetSettings = {
  start: number;      // first slot to use (1-20), so a part-used sheet can be finished
  offsetX: number;    // inches, nudge the whole grid right (+) / left (-)
  offsetY: number;    // inches, nudge down (+) / up (-)
  outlines: boolean;  // alignment test: print only the label outlines
};

// Measured from Premium Label Supply's own PLS289 2x2 PDF template: labels start
// 0.25in from the left and top edges, sit edge to edge across (2.00in pitch),
// and have a 0.125in gap between rows (2.125in pitch). Do not change these
// without re-measuring the sheet.
export const SHEET = { cols: 4, rows: 5, label: 2, left: 0.25, top: 0.25, gapX: 0, gapY: 0.125, pageW: 8.5, pageH: 11 };
export const SHEET_PER_PAGE = SHEET.cols * SHEET.rows;
export const DEFAULT_SHEET_SETTINGS: SheetSettings = { start: 1, offsetX: 0, offsetY: 0, outlines: false };

const KEY = "factory.labelSheet.settings.v2";   // v2: earlier nudges were compensating for the wrong layout, so start from zero
export function loadSheetSettings(): SheetSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SHEET_SETTINGS, ...JSON.parse(raw), start: 1, outlines: false };
  } catch { /* storage unavailable -- defaults */ }
  return { ...DEFAULT_SHEET_SETTINGS };
}
export function saveSheetSettings(s: SheetSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify({ offsetX: s.offsetX, offsetY: s.offsetY })); } catch { /* ignore */ }
}

/** Sheets needed for n labels starting at slot `start`. */
export function sheetCount(n: number, start: number): number {
  const first = Math.max(1, Math.min(SHEET_PER_PAGE, Math.floor(start) || 1));
  return Math.max(1, Math.ceil((n + first - 1) / SHEET_PER_PAGE));
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export async function printLabelSheet(labels: QrLabel[], s: SheetSettings): Promise<void> {
  const QRCode = await import("qrcode");
  const first = Math.max(1, Math.min(SHEET_PER_PAGE, Math.floor(s.start) || 1));
  const images = s.outlines ? [] : await Promise.all(
    labels.map((l) => QRCode.toDataURL(l.payload, { margin: 0, width: 600, errorCorrectionLevel: "M" })));

  const pages: string[] = [];
  const total = s.outlines ? SHEET_PER_PAGE : labels.length;
  let slot = first - 1;                       // 0-based slot on the current sheet
  let cells: string[] = [];
  const flush = () => { pages.push(`<section class="page">${cells.join("")}</section>`); cells = []; };
  for (let i = 0; i < (s.outlines ? 1 : total); i++) {
    if (s.outlines) {
      for (let k = 0; k < SHEET_PER_PAGE; k++) cells.push(cell(k, `<div class="n">${k + 1}</div>`, s));
      flush();
      break;
    }
    if (slot >= SHEET_PER_PAGE) { flush(); slot = 0; }
    const t = labels[i].text;
    const fs = Math.max(0.1, Math.min(0.2, 1.85 / Math.max(1, t.length) * 1.6));   // shrink long ids to fit
    cells.push(cell(slot, `<img src="${images[i]}"><div class="t" style="font-size:${fs.toFixed(3)}in">${esc(t)}</div>`, s));
    slot++;
  }
  if (cells.length) flush();

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
    @page { size: ${SHEET.pageW}in ${SHEET.pageH}in; margin: 0 }
    html, body { margin: 0; padding: 0; background: #fff }
    .page { position: relative; width: ${SHEET.pageW}in; height: ${SHEET.pageH}in; overflow: hidden; page-break-after: always; break-after: page }
    .page:last-child { page-break-after: auto; break-after: auto }
    .cell { position: absolute; width: ${SHEET.label}in; height: ${SHEET.label}in; box-sizing: border-box; text-align: center; font-family: Helvetica, Arial, sans-serif; color: #000; overflow: hidden }
    .cell.o { border: 0.01in solid #000 }
    .cell img { position: absolute; left: 0.25in; top: 0.12in; width: 1.5in; height: 1.5in; image-rendering: pixelated }
    .cell .t { position: absolute; left: 0.05in; right: 0.05in; top: 1.66in; font-weight: 700; white-space: nowrap }
    .cell .n { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 0.3in; color: #888 }
  </style></head><body>${pages.join("")}</body></html>`;

  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open(); doc.write(html); doc.close();
  await new Promise<void>((res) => {
    const imgs = Array.from(doc.images);
    if (imgs.every((im) => im.complete)) return res();
    let left = imgs.filter((im) => !im.complete).length;
    imgs.forEach((im) => { if (!im.complete) im.onload = im.onerror = () => { if (--left <= 0) res(); }; });
  });
  frame.contentWindow!.focus();
  frame.contentWindow!.onafterprint = () => setTimeout(() => frame.remove(), 500);
  frame.contentWindow!.print();
  setTimeout(() => frame.remove(), 120000);    // safety net if afterprint never fires
}

function cell(slot: number, inner: string, s: SheetSettings): string {
  const col = slot % SHEET.cols, row = Math.floor(slot / SHEET.cols);
  const x = SHEET.left + s.offsetX + col * (SHEET.label + SHEET.gapX);
  const y = SHEET.top + s.offsetY + row * (SHEET.label + SHEET.gapY);
  return `<div class="cell${s.outlines ? " o" : ""}" style="left:${x.toFixed(3)}in;top:${y.toFixed(3)}in">${inner}</div>`;
}
