"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Pallet } from "@/lib/types";
import { api } from "@/lib/api";
import { PALLET_STAGE_LABELS, PALLET_STAGE_BADGE_CLASS } from "@/lib/types";

/** The same JSON every pallet QR encodes (pallet_service.build_pallet_qr) --
 * used when a pallet row has no stored payload. */
function fallbackPayload(p: Pallet): string {
  return JSON.stringify({ t: p.pallet_type === "rm" ? "rm_pallet" : "fg_pallet", id: p.display_id, shipment: p.shipment_number, sku: p.sku_code });
}

/**
 * Real QR-backed pallet tile — same footprint/id-under-code layout as the
 * prototype's qrPalletTileHtml().
 *
 * US Factory pallets carry a server-rendered QR image (qr_url). Factory
 * (Goods Receipt) pallets don't: generating them is a single database
 * insert, and the QR is drawn here in the browser from the pallet's own
 * qr_payload -- identical content, no image upload, which is what made
 * generation slow. The scanners read either kind the same way.
 */
export default function PalletTile({ pallet, showStatus }: { pallet: Pallet; showStatus?: boolean }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (pallet.qr_url) return;
    let cancelled = false;
    QRCode.toDataURL(pallet.qr_payload || fallbackPayload(pallet), { margin: 1, width: 240, errorCorrectionLevel: "M" })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setDataUrl(null); });
    return () => { cancelled = true; };
  }, [pallet]);

  const src = pallet.qr_url ? api.mediaUrl(pallet.qr_url) : dataUrl;

  return (
    <div className="qr-tile">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`QR for ${pallet.display_id}`} />
      ) : (
        <div style={{ width: 120, height: 120, background: "var(--ink-08)" }} />
      )}
      <div className="qr-id">{pallet.display_id}</div>
      {showStatus && (
        <span className={`badge ${PALLET_STAGE_BADGE_CLASS[pallet.lifecycle_status]}`}>
          {PALLET_STAGE_LABELS[pallet.lifecycle_status]}
        </span>
      )}
    </div>
  );
}
