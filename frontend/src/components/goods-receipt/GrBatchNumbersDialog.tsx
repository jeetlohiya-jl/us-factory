"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { GoodsReceiptDetail, GoodsReceiptEntry } from "@/lib/types";
import { T } from "@/lib/terms";

/**
 * US Factory -- one Batch Number per received pallet, for RM / LNP Tray
 * entries. A separate dialog (not a step in the Inward Vehicle Inspection
 * wizard): the pallet count is already known from the inward, so it simply
 * shows that many inputs, linked to this entry (and so its PO, SKU and
 * shipment). Saving creates the entry's Pending Inward QC; no QR codes are
 * generated here -- that happens after QC approval.
 *
 * Validation mirrors the database function (goods_receipt_save_batch_numbers):
 * exactly one value per pallet, none blank, none repeated (case-insensitive).
 * Locked once the RM QR codes exist, since each pallet's Batch Number is
 * stamped on its QR then.
 */
export default function GrBatchNumbersDialog({
  entry, poNumber, canEdit, onClose, onSaved,
}: {
  entry: GoodsReceiptEntry;
  poNumber: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (next: GoodsReceiptDetail) => void;
}) {
  const pallets = entry.pallet_count ?? 0;
  const locked = entry.qr_batch?.status === "generated";
  const [values, setValues] = useState<string[]>(() => Array.from({ length: pallets }, () => ""));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [bulk, setBulk] = useState("");

  // Pre-fill from what was saved before (correct / review).
  useEffect(() => {
    let alive = true;
    api.getGoodsReceiptBatchNumbers(entry.id)
      .then((saved) => {
        if (!alive) return;
        setValues(Array.from({ length: pallets }, (_, i) => saved[i] ?? ""));
      })
      .catch(() => { /* start empty */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [entry.id, pallets]);

  // Which rows hold a repeated value (case-insensitive, trimmed).
  const duplicates = useMemo(() => {
    const seen = new Map<string, number[]>();
    values.forEach((v, i) => {
      const k = v.trim().toLowerCase();
      if (!k) return;
      seen.set(k, [...(seen.get(k) || []), i]);
    });
    const dup = new Set<number>();
    seen.forEach((idx) => { if (idx.length > 1) idx.forEach((i) => dup.add(i)); });
    return dup;
  }, [values]);
  const blanks = values.filter((v) => !v.trim()).length;
  const valid = pallets > 0 && blanks === 0 && duplicates.size === 0;

  function setAt(i: number, v: string) {
    setValues((prev) => prev.map((x, j) => (j === i ? v : x)));
  }

  // Paste a whole column (one per line / comma separated) into the grid.
  function applyBulk() {
    const parts = bulk.split(/[\n,;\t]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 0) return;
    setValues((prev) => prev.map((x, i) => parts[i] ?? x));
    setBulk("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveGoodsReceiptBatchNumbers(entry.id, values.map((v) => v.trim()));
      onSaved(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Batch Numbers");
    } finally {
      setSaving(false);
    }
  }

  const disabled = !canEdit || locked || saving;

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>Batch Numbers</h2>
            <div className="sub">{poNumber} / {entry.shipment_number} · {entry.sku_code || "—"} · {pallets} pallet{pallets === 1 ? "" : "s"}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          {locked && (
            <div className="hint-text" style={{ marginBottom: 12 }}>
              QR codes have already been generated for this entry, so its Batch Numbers can no longer be changed.
            </div>
          )}
          {!locked && (
            <div className="hint-text" style={{ marginBottom: 12 }}>
              Enter one Batch Number for each of the {pallets} pallets received. Each must be different.
              Saving this sends the entry to Inward QC as Pending.
            </div>
          )}

          {loading ? <div className="loading-line">Loading…</div> : reviewing ? (
            <div className="detail-card">
              <h3>Review</h3>
              <div style={{ overflowX: "auto" }}>
                <table className="qc-obs-table">
                  <thead><tr><th>{T.palletNumber}</th><th>Batch Number</th></tr></thead>
                  <tbody>
                    {values.map((v, i) => (
                      <tr key={i}><td>Pallet {i + 1}</td><td className="mono">{v.trim()}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <>
              {!disabled && (
                <div className="field" style={{ marginBottom: 14 }}>
                  <label>Paste a list (optional)</label>
                  <textarea rows={2} value={bulk} placeholder="One Batch Number per line, or comma separated — fills the rows below in order"
                    onChange={(e) => setBulk(e.target.value)} />
                  <div style={{ marginTop: 6 }}>
                    <button className="btn btn-secondary" disabled={!bulk.trim()} onClick={applyBulk}>Fill rows</button>
                  </div>
                </div>
              )}
              <div className="form-grid">
                {values.map((v, i) => (
                  <div className="field" key={i}>
                    <label>Pallet {i + 1}</label>
                    <input
                      value={v}
                      disabled={disabled}
                      placeholder="Batch Number"
                      style={duplicates.has(i) ? { borderColor: "var(--red)" } : undefined}
                      onChange={(e) => setAt(i, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              <div className="hint-text" style={{ marginTop: 10, color: valid ? "var(--green-deep)" : duplicates.size ? "var(--red)" : undefined }}>
                {duplicates.size > 0 ? "Some Batch Numbers are repeated — each pallet needs its own."
                  : blanks > 0 ? `${blanks} pallet${blanks === 1 ? "" : "s"} still need a Batch Number.`
                  : "All Batch Numbers entered."}
              </div>
            </>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>{locked ? "Close" : "Cancel"}</button>
          <div className="sp-foot-right">
            {!locked && reviewing && <button className="btn btn-secondary" disabled={saving} onClick={() => setReviewing(false)}>← Edit</button>}
            {!locked && !reviewing && (
              <button className="btn btn-primary" disabled={!valid || !canEdit || loading} onClick={() => setReviewing(true)}>Review</button>
            )}
            {!locked && reviewing && (
              <button className="btn btn-primary" disabled={!valid || saving || !canEdit} onClick={save}>{saving ? "Saving…" : "Save Batch Numbers"}</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
