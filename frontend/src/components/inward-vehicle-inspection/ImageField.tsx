"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ImageType, InspectionDetail, InspectionImage } from "@/lib/types";
import Lightbox from "./Lightbox";
import CameraCapture from "./CameraCapture";

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
  const [capturing, setCapturing] = useState(false);
  // Shown the instant a photo is captured/chosen, before the upload (now a
  // slower request since it waits on the cloud OCR call server-side) comes
  // back -- without this, the thumbnail area goes blank between "Processing…"
  // starting and the real image URL arriving, which reads as "the preview
  // stopped working" even though the upload itself is fine.
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const localPreviewUrl = useRef<string | null>(null);

  useEffect(() => {
    return () => { if (localPreviewUrl.current) URL.revokeObjectURL(localPreviewUrl.current); };
  }, []);

  async function handleFile(file: File) {
    setCapturing(false);
    setBusy(true);
    setError(null);
    if (localPreviewUrl.current) URL.revokeObjectURL(localPreviewUrl.current);
    const url = URL.createObjectURL(file);
    localPreviewUrl.current = url;
    setLocalPreview(url);
    try {
      const detail = image
        ? await api.replaceImage(inspectionId, image.id, file)
        : await api.uploadImage(inspectionId, imageType, file);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (localPreviewUrl.current) { URL.revokeObjectURL(localPreviewUrl.current); localPreviewUrl.current = null; }
      setLocalPreview(null);
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
        {localPreview || image?.public_url ? (
          <div className="img-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={localPreview || api.mediaUrl(image!.public_url!)} alt={label} onClick={() => !localPreview && setLightbox(true)} />
            {!disabled && !localPreview && (
              <div className="img-thumb-actions">
                <button onClick={() => setCapturing(true)} disabled={busy}>Replace</button>
                <button onClick={handleDelete} disabled={busy}>Delete</button>
              </div>
            )}
          </div>
        ) : (
          !disabled && (
            <button type="button" className="img-add-tile" onClick={() => setCapturing(true)}>
              + Add
            </button>
          )
        )}
      </div>
      {capturing && <CameraCapture onCapture={handleFile} onCancel={() => setCapturing(false)} />}
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
