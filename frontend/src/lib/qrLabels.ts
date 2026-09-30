"use client";
/**
 * QR labels as a real PDF: one page per label, each page EXACTLY 2in x 2in
 * (the die-cut labels of a 2x2 label printer). Browser printing can't be
 * trusted for this -- tablet browsers (iPad Safari, many Android browsers)
 * ignore the page size a page asks for and fall back to Letter/A4. A PDF
 * made here has its size baked in, so it prints and saves the same on any
 * device, and can be sent to a label printer app or shared.
 *
 * Runs entirely in the browser (jsPDF + qrcode, loaded only when used) --
 * no request to any server.
 */
export type QrLabel = { payload: string; text: string };

const PAGE = 144;          // 2in in PDF points (72 pt = 1 in)
const QR = 102;            // ~1.42in QR code (same size as the browser-printed label)
const TOP = 13;            // keeps the white "quiet zone" a scanner needs above the code

export async function downloadQrLabelsPdf(labels: QrLabel[], filename: string): Promise<void> {
  if (labels.length === 0) return;
  const [{ jsPDF }, QRCode] = await Promise.all([import("jspdf"), import("qrcode")]);
  const doc = new jsPDF({ unit: "pt", format: [PAGE, PAGE], orientation: "portrait", compress: true });
  for (let i = 0; i < labels.length; i++) {
    if (i > 0) doc.addPage([PAGE, PAGE], "portrait");
    const { payload, text } = labels[i];
    // High-resolution image so the printed code stays crisp at 203-300 dpi.
    const png = await QRCode.toDataURL(payload, { margin: 0, width: 600, errorCorrectionLevel: "M" });
    doc.addImage(png, "PNG", (PAGE - QR) / 2, TOP, QR, QR);
    doc.setFont("helvetica", "bold");
    let size = 11;
    doc.setFontSize(size);
    while (doc.getTextWidth(text) > PAGE - 12 && size > 6) doc.setFontSize(--size);  // long IDs shrink to fit
    doc.text(text, PAGE / 2, TOP + QR + 16, { align: "center" });
  }
  doc.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}

// ---------------------------------------------------------------------------
// Label IMAGES, for label-printer apps that print a picture (e.g. MakeID
// Label Pro's "Print by Photo" on the MakeID D50). Each image is square,
// 48 x 48 mm at 300 dpi = 567 x 567 px -- the D50's exact print width, so
// nothing falls outside what it can print on either its 53 mm or 35 mm roll.
// ---------------------------------------------------------------------------
const IMG = 567;                  // 48 mm at 300 dpi
const IMG_QR = 410;               // ~34.7 mm code, white quiet zone kept around it
const IMG_TOP = 38;

async function labelPngFile(label: QrLabel, name: string): Promise<File> {
  const QRCode = await import("qrcode");
  const canvas = document.createElement("canvas");
  canvas.width = IMG; canvas.height = IMG;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, IMG, IMG);
  const qr = document.createElement("canvas");
  await QRCode.toCanvas(qr, label.payload, { margin: 0, width: IMG_QR, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
  ctx.imageSmoothingEnabled = false;          // keep every module sharp-edged
  ctx.drawImage(qr, (IMG - IMG_QR) / 2, IMG_TOP, IMG_QR, IMG_QR);
  ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  let size = 46;
  do { ctx.font = `700 ${size}px Helvetica, Arial, sans-serif`; size -= 2; } while (ctx.measureText(label.text).width > IMG - 40 && size > 20);
  ctx.fillText(label.text, IMG / 2, IMG_TOP + IMG_QR + 62);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not create the label image"))), "image/png"));
  return new File([blob], name, { type: "image/png" });
}

export async function qrLabelImages(labels: QrLabel[]): Promise<File[]> {
  const safe = (t: string) => t.replace(/[^A-Za-z0-9._-]+/g, "_");
  return Promise.all(labels.map((l) => labelPngFile(l, `${safe(l.text)}.png`)));
}

/** Can this device hand image files to another app (Android / iPad share sheet)? */
export function canShareImages(): boolean {
  try {
    const probe = new File([new Blob()], "x.png", { type: "image/png" });
    return typeof navigator !== "undefined" && !!navigator.canShare && navigator.canShare({ files: [probe] });
  } catch { return false; }
}

/** Open the device's Share menu with the label images (pick MakeID Label Pro).
 * Returns "shared", "cancelled", or "needs-tap" when the browser wants a fresh
 * tap (it only allows sharing right after one) -- the caller then offers a
 * second button that calls shareFiles(files) directly. */
export async function shareFiles(files: File[], title: string): Promise<"shared" | "cancelled" | "needs-tap"> {
  try {
    await navigator.share({ files, title });
    return "shared";
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "AbortError") return "cancelled";
    if (name === "NotAllowedError") return "needs-tap";
    throw e;
  }
}

/** Save the label images as files (Downloads / Gallery). */
export function downloadFiles(files: File[]): void {
  files.forEach((f, i) => {
    setTimeout(() => {
      const url = URL.createObjectURL(f);
      const a = document.createElement("a");
      a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, i * 250);   // spaced out so the browser doesn't drop any
  });
}
