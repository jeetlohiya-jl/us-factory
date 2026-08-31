"use client";
import type { Pallet } from "@/lib/types";
import { api } from "@/lib/api";
import { PALLET_STAGE_LABELS, PALLET_STAGE_BADGE_CLASS } from "@/lib/types";

/**
 * Real QR-backed pallet tile — same footprint/id-under-code layout as the
 * prototype's qrPalletTileHtml(), but the placeholder `.qr-mock` checker
 * pattern is replaced with the actual generated QR PNG (the pallet's
 * immutable display_id, backed by the DB record it resolves to).
 */
export default function PalletTile({ pallet, showStatus }: { pallet: Pallet; showStatus?: boolean }) {
  return (
    <div className="qr-tile">
      {pallet.qr_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={api.mediaUrl(pallet.qr_url)} alt={`QR for ${pallet.display_id}`} />
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
