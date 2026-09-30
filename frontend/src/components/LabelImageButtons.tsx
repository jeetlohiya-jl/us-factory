"use client";
import { useEffect, useState } from "react";
import { canShareImages, downloadFiles, qrLabelImages, shareFiles, type QrLabel } from "@/lib/qrLabels";

/**
 * "Send to printer app" + "Download images" for QR labels. On an Android
 * tablet, "Send to printer app" opens the Share menu with one 48x48 mm
 * label image per pallet/location -- pick MakeID Label Pro, then print them
 * with Print by Photo. Made on the device; no server call.
 */
export default function LabelImageButtons({ labels, disabled }: { labels: () => QrLabel[]; disabled?: boolean }) {
  const [busy, setBusy] = useState<"share" | "download" | null>(null);
  const [pending, setPending] = useState<File[] | null>(null);   // ready, waiting for a fresh tap
  const [note, setNote] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(canShareImages()), []);

  async function send(files?: File[]) {
    setNote(null);
    setBusy("share");
    try {
      const f = files ?? (await qrLabelImages(labels()));
      const r = await shareFiles(f, "QR labels");
      if (r === "needs-tap") { setPending(f); return; }   // the browser wants one more tap
      setPending(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't open the Share menu -- use Download images instead.");
    } finally { setBusy(null); }
  }

  async function download() {
    setNote(null);
    setBusy("download");
    try { downloadFiles(await qrLabelImages(labels())); }
    finally { setBusy(null); }
  }

  const n = labels().length;
  return (
    <>
      {canShare && (pending ? (
        <button className="btn btn-primary" onClick={() => send(pending)}>Tap to share {pending.length} label{pending.length === 1 ? "" : "s"}</button>
      ) : (
        <button className="btn btn-secondary" disabled={disabled || n === 0 || !!busy} onClick={() => send()}>
          {busy === "share" ? "Preparing…" : "Send to printer app"}
        </button>
      ))}
      <button className="btn btn-secondary" disabled={disabled || n === 0 || !!busy} onClick={download}>
        {busy === "download" ? "Preparing…" : `Download image${n === 1 ? "" : "s"}`}
      </button>
      {note && <span className="hint-text" style={{ margin: 0, alignSelf: "center" }}>{note}</span>}
    </>
  );
}
