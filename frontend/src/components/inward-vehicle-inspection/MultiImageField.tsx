"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import type { ImageType, InspectionDetail, InspectionImage } from "@/lib/types";
import Lightbox from "./Lightbox";
import CameraCapture from "./CameraCapture";

export default function MultiImageField({
  inspectionId, imageType, images, disabled, onChange, label = "Damage Pictures",
}: {
  inspectionId: string;
  // Which image_type new/replacement uploads are tagged with -- defaults
  // to "damage" (this field's original single use) so existing callers
  // don't need to change; Container Photo now passes imageType="container"
  // to reuse this exact add/replace/delete gallery instead of the
  // single-photo ImageField.
  imageType?: ImageType;
  images: InspectionImage[];
  disabled?: boolean;
  onChange: (detail: InspectionDetail) => void;
  label?: string;
}) {
  const [busyId, setBusyId] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // "new" while capturing a photo to add, an image id while capturing a
  // replacement for that image, or null when no camera view is open.
  const [capturing, setCapturing] = useState<string | "new" | null>(null);

  async function handleAdd(file: File) {
    setCapturing(null);
    setBusyId("new");
    setError(null);
    try {
      const detail = await api.uploadImage(inspectionId, imageType || "damage", file);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReplace(imageId: string, file: File) {
    setCapturing(null);
    setBusyId(imageId);
    setError(null);
    try {
      const detail = await api.replaceImage(inspectionId, imageId, file);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replace failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(imageId: string) {
    setBusyId(imageId);
    try {
      const detail = await api.deleteImage(inspectionId, imageId);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="img-field">
      <div className="img-field-label">{label}</div>
      <div className="img-thumb-row">
        {images.map((img) => (
          <div className="img-thumb" key={img.id}>
            {img.public_url && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={api.mediaUrl(img.public_url)} alt={label} onClick={() => setLightboxSrc(api.mediaUrl(img.public_url!))} />
            )}
            {!disabled && (
              <div className="img-thumb-actions">
                <button disabled={busyId === img.id} onClick={() => setCapturing(img.id)}>Replace</button>
                <button disabled={busyId === img.id} onClick={() => handleDelete(img.id)}>Delete</button>
              </div>
            )}
          </div>
        ))}
        {!disabled && (
          <button type="button" className="img-add-tile" onClick={() => setCapturing("new")}>
            + Add More
          </button>
        )}
      </div>
      {capturing && (
        <CameraCapture
          onCapture={(file) => (capturing === "new" ? handleAdd(file) : handleReplace(capturing, file))}
          onCancel={() => setCapturing(null)}
        />
      )}
      {busyId && <div className="hint-text">Processing…</div>}
      {error && <div className="hint-text" style={{ color: "var(--red)" }}>{error}</div>}
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}
