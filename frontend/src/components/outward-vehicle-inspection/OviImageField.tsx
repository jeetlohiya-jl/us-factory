"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import type { OviImage, OviImageType } from "@/lib/types";
import Lightbox from "@/components/inward-vehicle-inspection/Lightbox";
import CameraCapture from "@/components/inward-vehicle-inspection/CameraCapture";

/**
 * One named loading-photo slot (License Plate, Container Number, First
 * Row, ...) -- same single-image field pattern and same "img-field"/
 * "img-thumb"/"img-add-tile" CSS classes as Inward Vehicle Inspection's
 * ImageField (container/truck/seal/condition/empty_container), reusing
 * that module's own CameraCapture/Lightbox rather than duplicating them.
 * No OCR here -- these are loading-progress photos, not identifier images.
 */
export default function OviImageField({
  recordId, imageType, label, image, disabled, onChange,
}: {
  recordId: string;
  imageType: OviImageType;
  label: string;
  image: OviImage | undefined;
  disabled?: boolean;
  onChange: (images: OviImage[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  const [capturing, setCapturing] = useState(false);

  async function handleFile(file: File) {
    setCapturing(false);
    setBusy(true);
    setError(null);
    try {
      const images = image
        ? await api.replaceOviImage(recordId, image.id, file)
        : await api.uploadOviImage(recordId, imageType, file);
      onChange(images);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!image) return;
    setBusy(true);
    try {
      const images = await api.deleteOviImage(recordId, image.id);
      onChange(images);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="img-field">
      <div className="img-field-label">{label}</div>
      <div className="img-thumb-row">
        {image?.public_url ? (
          <div className="img-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={api.mediaUrl(image.public_url)} alt={label} onClick={() => setLightbox(true)} />
            {!disabled && (
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
      {lightbox && image?.public_url && <Lightbox src={api.mediaUrl(image.public_url)} onClose={() => setLightbox(false)} />}
    </div>
  );
}
