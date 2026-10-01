"use client";
import { useEffect, useState } from "react";
import { downloadFiles, qrLabelImages, type QrLabel } from "@/lib/qrLabels";
import { FACTORY_PRINT_MAX_LABELS, isAndroid, openFactoryPrint } from "@/lib/factoryPrint";

/**
 * Label buttons for the QR panel and Setup -> Locations:
 *  - "Print on D50" (Android tablet): opens the Factory Print app, which
 *    prints every selected label on the MakeID D50 in one job.
 *  - "Download images": one 48x48 mm label image per pallet/location (for a
 *    one-off label via MakeID Label Pro's Print by Photo, or another device).
 * (The earlier "Send to printer app" share is gone: MakeID Label Pro opens
 * shared files as an Excel import, not as labels to print.)
 */
export default function LabelImageButtons({ labels, disabled, source = "" }: { labels: () => QrLabel[]; disabled?: boolean; source?: string }) {
  const [busy, setBusy] = useState<"download" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [android, setAndroid] = useState(false);
  useEffect(() => { setAndroid(isAndroid()); }, []);

  async function download() {
    setNote(null);
    setBusy("download");
    try { downloadFiles(await qrLabelImages(labels())); }
    finally { setBusy(null); }
  }

  const n = labels().length;
  return (
    <>
      {/* Android tablet: straight to the MakeID D50 via the Factory Print app (all labels, one job). */}
      {android && (
        <button
          className="btn btn-primary" disabled={disabled || n === 0 || n > FACTORY_PRINT_MAX_LABELS}
          title={n > FACTORY_PRINT_MAX_LABELS ? `Select at most ${FACTORY_PRINT_MAX_LABELS} labels per print` : undefined}
          onClick={() => openFactoryPrint(labels(), source)}
        >
          Print on D50 ({n})
        </button>
      )}
      <button className="btn btn-secondary" disabled={disabled || n === 0 || !!busy} onClick={download}>
        {busy === "download" ? "Preparing…" : `Download image${n === 1 ? "" : "s"}`}
      </button>
      {note && <span className="hint-text" style={{ margin: 0, alignSelf: "center" }}>{note}</span>}
    </>
  );
}
