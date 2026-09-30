"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * Certificate of Analysis upload for a Goods Receipt entry (2026-09-30,
 * migration 0080) -- required before Generate QRs for Polybag/Soaker
 * Pad/CFB entries (see needsCoa() in GoodsReceiptDetailPanel.tsx). Modeled
 * on inward-qc/CoaField.tsx but without the OCR/parsing step -- this is
 * just an upload, written straight onto the goods_receipt_entries row
 * (goods_receipt_coa.py), independent of the inward RPCs.
 */
export default function GrCoaField({ entryId, filename, disabled, onChange }: {
  entryId: string;
  filename: string | null;
  disabled?: boolean;
  onChange: (next: { coa_storage_path: string | null; coa_filename: string | null }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.uploadGoodsReceiptCoa(entryId, file);
      onChange({ coa_storage_path: res.coa_storage_path, coa_filename: res.coa_filename });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteGoodsReceiptCoa(entryId);
      onChange({ coa_storage_path: null, coa_filename: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field" style={{ maxWidth: 320 }}>
      <label>COA (PDF, Word doc, or image) <span style={{ color: "var(--red)" }}>*</span></label>
      {filename ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="btn-tertiary" style={{ cursor: "default" }}>{filename}</span>
          {!disabled && (
            <>
              <button type="button" className="btn-tertiary" disabled={busy} onClick={() => inputRef.current?.click()}>Replace</button>
              <button type="button" className="btn-tertiary" style={{ color: "var(--red)" }} disabled={busy} onClick={handleDelete}>Delete</button>
            </>
          )}
        </div>
      ) : (
        !disabled && (
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        )
      )}
      {filename && !disabled && (
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
      )}
      {!filename && <div className="hint-text" style={{ margin: "4px 0 0" }}>Required to generate QR codes for this container.</div>}
      {busy && <div className="hint-text">Uploading…</div>}
      {error && <div className="hint-text" style={{ color: "var(--red)" }}>{error}</div>}
    </div>
  );
}
