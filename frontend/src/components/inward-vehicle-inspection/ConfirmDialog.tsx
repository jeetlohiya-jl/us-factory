"use client";

export default function ConfirmDialog({
  title, message, blockedNote, confirmLabel = "Confirm", danger, onConfirm, onCancel,
}: {
  title: string;
  message: string;
  blockedNote?: string | null;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {blockedNote && <div className="blocked-note">{blockedNote}</div>}
        <p>{message}</p>
        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={onCancel}>{blockedNote ? "Close" : "Cancel"}</button>
          {!blockedNote && onConfirm && (
            <button className={danger ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm}>{confirmLabel}</button>
          )}
        </div>
      </div>
    </div>
  );
}
