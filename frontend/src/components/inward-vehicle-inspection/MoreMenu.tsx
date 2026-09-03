"use client";
import { useEffect, useRef, useState } from "react";

/**
 * The "..." row-actions menu. Rendered with position:fixed (computed from
 * the trigger button's own on-screen position) rather than being absolutely
 * positioned inside the table row — table containers (.card-flush) clip
 * overflow for the horizontal-scroll behavior on wide tables, which was
 * silently clipping an absolutely-positioned dropdown to invisible even
 * though it was opening correctly. position:fixed escapes that clipping.
 *
 * onEdit/canEdit are optional — omit them (e.g. from a list that only
 * supports deleting a record, not editing it) to render a Delete-only menu.
 * onDelete/canDelete are likewise optional — omit them (e.g. Production/
 * IPQC, whose records are auto-created and never deletable) to render an
 * Edit-only menu instead.
 */
export default function MoreMenu({
  onEdit, onDelete, canEdit, canDelete,
}: { onEdit?: () => void; onDelete?: () => void; canEdit?: boolean; canDelete?: boolean }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onScrollOrResize() { setOpen(false); }
    document.addEventListener("click", onDocClick);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, []);

  function toggleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((v) => !v);
  }

  return (
    <div className="more-menu-wrap">
      <button ref={btnRef} className="more-menu-btn" title="More actions" onClick={toggleOpen}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open && coords && (
        <div
          ref={menuRef}
          className="more-menu"
          style={{ position: "fixed", top: coords.top, right: coords.right }}
          onClick={(e) => e.stopPropagation()}
        >
          {onEdit && (
            <button disabled={!canEdit} onClick={() => { setOpen(false); onEdit(); }}>Edit</button>
          )}
          {onDelete && (
            <button className="danger" disabled={!canDelete} onClick={() => { setOpen(false); onDelete(); }}>Delete</button>
          )}
        </div>
      )}
    </div>
  );
}
