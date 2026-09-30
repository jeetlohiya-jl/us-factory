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
