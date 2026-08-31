"use client";

export default function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">×</button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="Full size preview" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
