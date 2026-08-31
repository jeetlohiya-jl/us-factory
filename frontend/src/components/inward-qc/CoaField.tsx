"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { QcDetail } from "@/lib/types";

export default function CoaField({ qcId, filename, url, disabled, onChange }: {
  qcId: string; filename: string | null; url: string | null; disabled?: boolean; onChange: (detail: QcDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseSummary, setParseSummary] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    setParseSummary(null);
    try {
      const detail = await api.uploadQcCoa(qcId, file);
      const suggestions = detail.coa_suggestions || [];
      const matched = suggestions.filter((s) => s.status === "matched" && s.extracted_value);

      if (matched.length > 0) {
        // Only fill fields the operator hasn't already typed something
        // into -- a parsed suggestion must never silently overwrite a
        // value someone already entered by hand.
        const byId = new Map(matched.map((s) => [s.attribute_definition_id, s.extracted_value]));
        detail.attribute_values = detail.attribute_values.map((v) =>
          (v.value == null || v.value === "") && byId.has(v.attribute_definition_id)
            ? { ...v, value: byId.get(v.attribute_definition_id)! }
            : v
        );
        setParseSummary(
          `Filled ${matched.length} of ${suggestions.length} Observation field${suggestions.length === 1 ? "" : "s"} from this COA — please verify each value below.`
        );
      } else if (suggestions.length > 0) {
        setParseSummary("Couldn't confidently match any Observation fields on this COA — enter values manually below.");
      }
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
      setParseSummary(null);
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
        !disabled && <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      )}
      {filename && !disabled && (
        <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
      )}
      {busy && <div className="hint-text">Parsing COA and matching Observation fields…</div>}
      {parseSummary && <div className="hint-text" style={{ color: "var(--green-deep)", fontWeight: 600 }}>{parseSummary}</div>}
      {error && <div className="hint-text" style={{ color: "var(--red)" }}>{error}</div>}
    </div>
  );
}
