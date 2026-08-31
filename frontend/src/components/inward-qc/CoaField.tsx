"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { QcDetail } from "@/lib/types";

export default function CoaField({ qcId, filename, url, disabled, onChange }: {
  qcId: string; filename: string | null; url: string | null; disabled?: boolean; onChange: (detail: QcDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.uploadQcCoa(qcId, file);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      const detail = await api.deleteQcCoa(qcId);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field" style={{ maxWidth: 320 }}>
      <label>COA</label>
      {filename ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <a href={url ? api.mediaUrl(url) : "#"} target="_blank" rel="noreferrer" className="btn-tertiary">{filename}</a>
          {!disabled && (
            <>
              <button className="btn-tertiary" disabled={busy} onClick={() => inputRef.current?.click()}>Replace</button>
              <button className="btn-tertiary" style={{ color: "var(--red)" }} disabled={busy} onClick={handleDelete}>Delete</button>
            </>
          )}
        </div>
      ) : (
        !disabled && <input ref={inputRef} type="file" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      )}
      {filename && !disabled && (
        <input ref={inputRef} type="file" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      )}
      {busy && <div className="hint-text">Processing…</div>}
      {error && <div className="hint-text" style={{ color: "var(--red)" }}>{error}</div>}
    </div>
  );
}
