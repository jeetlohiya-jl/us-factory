"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { IpqcAttachment } from "@/lib/types";
import Lightbox from "@/components/inward-vehicle-inspection/Lightbox";

const ACCEPT = ".jpg,.jpeg,.png,.gif,.webp,.pdf,.docx";

function isImage(a: IpqcAttachment) {
  return (a.content_type || "").startsWith("image/");
}
function sizeLabel(n: number | null) {
  if (n == null) return "";
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Multi-file attachments (images, PDF, DOCX) for an IPQC record or a Burst /
 * Pinhole test. The caller supplies how to upload / delete (so the same list
 * serves all three owners) and receives the new list back through onChange --
 * nothing is refetched. Images open in the shared Lightbox, PDFs open in a
 * new tab, DOCX files download (browsers cannot preview them).
 */
export default function AttachmentList({
  attachments, canEdit, upload, remove, onChange, emptyHint,
}: {
  attachments: IpqcAttachment[];
  canEdit: boolean;
  upload: (file: File) => Promise<IpqcAttachment>;
  remove: (id: string) => Promise<void>;
  onChange: (next: IpqcAttachment[]) => void;
  emptyHint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setErrors([]);
    let list = attachments;
    const failed: string[] = [];
    // One at a time: each success updates the list, each failure is reported by name.
    for (const file of Array.from(files)) {
      try {
        const added = await upload(file);
        list = [...list, added];
        onChange(list);
      } catch (e) {
        failed.push(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
      }
    }
    setErrors(failed);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleDelete(a: IpqcAttachment) {
    setBusy(true);
    setErrors([]);
    try {
      await remove(a.id);
      onChange(attachments.filter((x) => x.id !== a.id));
    } catch (e) {
      setErrors([`${a.filename}: ${e instanceof Error ? e.message : "delete failed"}`]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {attachments.length === 0 ? (
        <div className="hint-text">{emptyHint || "No attachments."}</div>
      ) : (
        <table className="qc-obs-table">
          <thead><tr><th>File</th><th style={{ width: 70 }}>Size</th><th>Added by</th><th style={{ width: 150 }}></th></tr></thead>
          <tbody>
            {attachments.map((a) => {
              const url = a.public_url ? api.mediaUrl(a.public_url) : null;
              return (
                <tr key={a.id}>
                  <td style={{ wordBreak: "break-all" }}>{a.filename}</td>
                  <td>{sizeLabel(a.size_bytes)}</td>
                  <td>{a.uploaded_by_name || "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      {url && isImage(a) && <button type="button" className="btn-tertiary" onClick={() => setPreview(url)}>Preview</button>}
                      {url && !isImage(a) && (
                        <a className="btn-tertiary" href={url} target="_blank" rel="noopener noreferrer" download={a.content_type === "application/pdf" ? undefined : a.filename}>
                          {a.content_type === "application/pdf" ? "Open" : "Download"}
                        </a>
                      )}
                      {canEdit && <button type="button" className="btn-tertiary" style={{ color: "var(--red)" }} disabled={busy} onClick={() => handleDelete(a)}>Remove</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {canEdit && (
        <div style={{ marginTop: 10 }}>
          <input ref={inputRef} type="file" multiple accept={ACCEPT} disabled={busy} onChange={(e) => handleFiles(e.target.files)} />
          <div className="hint-text" style={{ margin: "4px 0 0" }}>Images, PDF or DOCX · up to 15 MB each · select several at once.</div>
        </div>
      )}
      {busy && <div className="hint-text">Working…</div>}
      {errors.map((m) => <div key={m} className="hint-text" style={{ color: "var(--red)" }}>{m}</div>)}
      {preview && <Lightbox src={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
