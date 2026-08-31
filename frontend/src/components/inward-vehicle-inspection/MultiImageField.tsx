"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import type { InspectionDetail, InspectionImage } from "@/lib/types";
import Lightbox from "./Lightbox";

export default function MultiImageField({
  inspectionId, images, disabled, onChange, label = "Damage Pictures",
}: {
  inspectionId: string;
  images: InspectionImage[];
  disabled?: boolean;
  onChange: (detail: InspectionDetail) => void;
  label?: string;
}) {
  const [busyId, setBusyId] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const replaceRefs = useRef<Record<string, HTMLInputElement | null>>({});

  async function handleAdd(file: File) {
    setBusyId("new");
    setError(null);
    try {
      const detail = await api.uploadImage(inspectionId, "damage", file);
      onChange(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusyId(null);
      if (addRef.current) addRef.current.value = "";
    }
  }

  async function handleReplace(imageId: string, file: File) {
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
                <button disabled={busyId === img.id} onClick={() => replaceRefs.current[img.id]?.click()}>Replace</button>
                <button disabled={busyId === img.id} onClick={() => handleDelete(img.id)}>Delete</button>
              </div>
            )}
            <input
              ref={(el) => { replaceRefs.current[img.id] = el; }}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && handleReplace(img.id, e.target.files[0])}
            />
          </div>
        ))}
        {!disabled && (
          <label className="img-add-tile">
            + Add More
            <input
              ref={addRef}
              type="file"
              accept="image/*"
              onChange={(e) => e.target.files?.[0] && handleAdd(e.target.files[0])}
            />
          </label>
        )}
      </div>
      {busyId && <div className="hint-text">Processing…</div>}
      {error && <div className="hint-text" style={{ color: "var(--red)" }}>{error}</div>}
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}
