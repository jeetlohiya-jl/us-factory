"use client";
/**
 * QR label IMAGES for label-printer apps that print a picture -- MakeID
 * Label Pro's "Print by Photo" on the MakeID D50 (Android tablet). Made on
 * the device (qrcode, loaded only when used); no server call.
 */
export type QrLabel = { payload: string; text: string };

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
