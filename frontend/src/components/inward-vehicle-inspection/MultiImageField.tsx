"use client";
import { useEffect, useRef, useState } from "react";
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
  // Shown instantly for whichever tile (new-tile, or an existing image
  // being replaced) is mid-upload -- see the matching note in ImageField.tsx;
  // the upload now waits on a slower server-side cloud OCR call, so without
  // a local preview the tile goes blank for a few seconds between capture
  // and the real image URL coming back.
  const [localPreview, setLocalPreview] = useState<{ id: string | "new"; url: string } | null>(null);
  const localPreviewUrl = useRef<string | null>(null);

  useEffect(() => {
    return () => { if (localPreviewUrl.current) URL.revokeObjectURL(localPreviewUrl.current); };
  }, []);

  function setPreview(id: string | "new", file: File) {
    if (localPreviewUrl.current) URL.revokeObjectURL(localPreviewUrl.current);
    const url = URL.createObjectURL(file);
    localPreviewUrl.current = url;
    setLocalPreview({ id, url });
  }

  function clearPreview() {
    if (localPreviewUrl.current) { URL.revokeObjectURL(localPreviewUrl.current); localPreviewUrl.current = null; }
    setLocalPreview(null);
  }

  async function handleAdd(file: File) {
    setCapturing(null);
    setBusyId("new");
    setError(null);
    setPreview("new", file);
    try {
      const detail = await api.uploadImage(inspectionId, imageType || "damage", file);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusyId(null);
      clearPreview();
    }
  }

  async function handleReplace(imageId: string, file: File) {
    setCapturing(null);
    setBusyId(imageId);
    setError(null);
    setPreview(imageId, file);
    try {
      const detail = await api.replaceImage(inspectionId, imageId, file);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replace failed");
    } finally {
      setBusyId(null);
      clearPreview();
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
        {images.map((img) => {
          const preview = localPreview?.id === img.id ? localPreview.url : null;
          return (
            <div className="img-thumb" key={img.id}>
              {(preview || img.public_url) && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={preview || api.mediaUrl(img.public_url!)} alt={label} onClick={() => !preview && setLightboxSrc(api.mediaUrl(img.public_url!))} />
              )}
              {!disabled && !preview && (
                <div className="img-thumb-actions">
                  <button disabled={busyId === img.id} onClick={() => setCapturing(img.id)}>Replace</button>
                  <button disabled={busyId === img.id} onClick={() => handleDelete(img.id)}>Delete</button>
                </div>
              )}
            </div>
          );
        })}
        {localPreview?.id === "new" && (
          <div className="img-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={localPreview.url} alt={label} />
          </div>
        )}
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
