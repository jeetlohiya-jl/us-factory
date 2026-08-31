"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ImageType, InspectionDetail, InspectionImage } from "@/lib/types";
import Lightbox from "./Lightbox";

const OCR_LABEL: Record<string, string> = {
  success: "OCR matched",
  low_confidence: "Low confidence — please verify",
  failed: "OCR failed — enter manually",
};

export default function ImageField({
  inspectionId, imageType, label, image, disabled, onChange, hint,
}: {
  inspectionId: string;
  imageType: ImageType;
  label: string;
  image: InspectionImage | undefined;
  disabled?: boolean;
  onChange: (detail: InspectionDetail) => void;
  hint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const detail = image
        ? await api.replaceImage(inspectionId, image.id, file)
        : await api.uploadImage(inspectionId, imageType, file);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleDelete() {
    if (!image) return;
    setBusy(true);
    try {
      const detail = await api.deleteImage(inspectionId, image.id);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="img-field">
      <div className="img-field-label">{label}</div>
      {hint && <div className="hint-text" style={{ marginTop: 0, marginBottom: 8 }}>{hint}</div>}
      <div className="img-thumb-row">
        {image?.public_url ? (
          <div className="img-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={api.mediaUrl(image.public_url)} alt={label} onClick={() => setLightbox(true)} />
            {!disabled && (
              <div className="img-thumb-actions">
                <button onClick={() => inputRef.current?.click()} disabled={busy}>Replace</button>
                <button onClick={handleDelete} disabled={busy}>Delete</button>
              </div>
            )}
          </div>
        ) : (
          !disabled && (
            <label className="img-add-tile">
              + Add
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
            </label>
          )
        )}
        {image?.public_url && !disabled && (
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        )}
      </div>
      {busy && <div className="hint-text">Processing…</div>}
      {error && <div className="hint-text" style={{ color: "var(--red)" }}>{error}</div>}
      {image?.ocr_status && (
        <span className={`ocr-badge ${image.ocr_status}`}>
          {OCR_LABEL[image.ocr_status] || image.ocr_status}
          {image.ocr_extracted_value ? `: ${image.ocr_extracted_value}` : ""}
        </span>
      )}
      {lightbox && image?.public_url && <Lightbox src={api.mediaUrl(image.public_url)} onClose={() => setLightbox(false)} />}
    </div>
  );
}
