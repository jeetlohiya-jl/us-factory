"use client";
import { useEffect, useRef, useState } from "react";

export default function MoreMenu({
  onEdit, onDelete, canEdit, canDelete,
}: { onEdit: () => void; onDelete: () => void; canEdit: boolean; canDelete: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  return (
    <div className="more-menu-wrap" ref={ref}>
      <button
        className="more-menu-btn"
        title="More actions"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open && (
        <div className="more-menu" onClick={(e) => e.stopPropagation()}>
          <button disabled={!canEdit} onClick={() => { setOpen(false); onEdit(); }}>Edit</button>
          <button className="danger" disabled={!canDelete} onClick={() => { setOpen(false); onDelete(); }}>Delete</button>
        </div>
      )}
    </div>
  );
}
