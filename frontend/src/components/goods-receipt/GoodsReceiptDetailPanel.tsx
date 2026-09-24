"use client";
import { Fragment, useState } from "react";
import { api } from "@/lib/api";
import type { GoodsReceiptDetail, GoodsReceiptEntry, QrGenerationDetail } from "@/lib/types";
import { INWARD_CATEGORY_LABELS } from "@/lib/types";
import QrGenerationPanel from "@/components/qr-generation/QrGenerationPanel";
import { GoodsReceiptStatusBadge } from "./GoodsReceiptStatusBadge";

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

function fmt(n: number | null | undefined) {
  return n == null ? "—" : Number(n).toLocaleString();
}

// Goods Receipt counts pallets: the PO Quantity is pallets ordered, and
// inwarding asks one number -- pallets received (one RM QR per pallet).
type InwardForm = { pallets: string };

/**
 * Goods Receipt detail -- the receiving screen. Every container x SKU entry
 * is its own row with its own status; "Inward" opens an inline form on
 * THAT row only (Pallets Received), and
 * confirming it changes only that entry. Once inwarded, the
 * row offers Generate / View QRs, which opens the existing RM QR panel
 * (QrGenerationPanel, unchanged: pallet grid, 2x2in label printing).
 *
 * Every mutation's response is the fresh record (or QR batch), applied
 * directly to local state -- no follow-up fetch, no page reload.
 */
export default function GoodsReceiptDetailPanel({
  detail, canEdit, canReceive, onClose, onEdit, onChanged,
}: {
  detail: GoodsReceiptDetail;
  canEdit: boolean;
  canReceive: boolean;
  onClose: () => void;
  onEdit: () => void;
  onChanged: (next: GoodsReceiptDetail) => void;
}) {
  const [record, setRecord] = useState(detail);
  const [inwardingId, setInwardingId] = useState<string | null>(null);
  const [form, setForm] = useState<InwardForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ entry: GoodsReceiptEntry; detail: QrGenerationDetail } | null>(null);

  const inwarded = record.entries.filter((e) => e.status === "inwarded");
  const palletTotal = inwarded.reduce((n, e) => n + (e.pallet_count || 0), 0);
  const isDraft = record.status === "draft";

  function apply(next: GoodsReceiptDetail) {
    setRecord(next);
    onChanged(next);
  }

  function startInward(e: GoodsReceiptEntry) {
    setError(null);
    setInwardingId(e.id);
    setForm({
      // Default to the ordered quantity -- the common case is a full
      // container -- but it stays editable for a short delivery.
      pallets: String(e.po_quantity),
    });
  }

  async function confirmInward(e: GoodsReceiptEntry) {
    if (!form) return;
    const pallets = Number(form.pallets);
    if (!(pallets >= 1) || !Number.isInteger(pallets)) { setError(`${e.shipment_number}: Pallets Received must be a whole number of at least 1.`); return; }
    setBusy(e.id);
    setError(null);
    try {
      const next = await api.inwardGoodsReceiptEntry(record.id, e.id, {
        received_quantity: pallets, unit: "Pallets", pallet_count: pallets,
      });
      apply(next);
      setInwardingId(null);
      setForm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to inward container");
    } finally {
      setBusy(null);
    }
  }

  // Already generated -> reopen the existing batch (Supabase read).
  // Otherwise -> one click generates (FastAPI: QR PNGs + shared numbering)
  // and opens the panel with every QR already in the response.
  async function openOrGenerateQr(e: GoodsReceiptEntry) {
    setBusy(e.id);
    setError(null);
    try {
      if (e.qr_batch?.status === "generated") {
        setQr({ entry: e, detail: await api.getRmQr(e.qr_batch.id) });
        return;
      }
      const d = await api.generateGoodsReceiptEntryQr(record.id, e.id);
      setQr({ entry: e, detail: d });
      apply({
        ...record,
        entries: record.entries.map((x) =>
          x.id === e.id ? { ...x, qr_batch: { id: d.id, batch_display_id: d.batch_display_id, status: d.status, quantity: d.quantity } } : x
        ),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate pallet QRs");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open" style={{ width: "min(1040px,96vw)" }}>
        <div className="sp-head">
          <div>
            <h2>Goods Receipt · {record.po_number}</h2>
            <div className="sub">{record.vendor_name} · <GoodsReceiptStatusBadge status={record.status} /></div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          <div className="detail-card">
            <h3>General Information</h3>
            <div className="detail-grid">
              <Kv label="PO Number" value={<span className="mono">{record.po_number}</span>} />
              <Kv label="Categories" value={Array.from(new Set(record.entries.map((e) => e.category).filter(Boolean))).map((c) => INWARD_CATEGORY_LABELS[c!]).join(", ") || "—"} />
              <Kv label="Vendor" value={record.vendor_name} />
              <Kv label="Containers Inwarded" value={`${inwarded.length} of ${record.entries.length}`} />
              <Kv label="Pallets Received" value={palletTotal} />
              <Kv label="Created" value={new Date(record.created_at).toLocaleString()} />
            </div>
          </div>

          {isDraft && (
            <div className="hint-text" style={{ marginBottom: 12 }}>
              This Goods Receipt is a draft. Edit it and click Save to start inwarding containers.
            </div>
          )}

          <div className="detail-card">
            <h3>Containers</h3>
            <div style={{ overflowX: "auto" }}>
              <table className="qc-obs-table">
                <thead>
                  <tr>
                    <th>Shipment No.</th><th>SKU</th><th>Category</th><th>Version</th>
                    <th>PO Pallets</th><th>Pallets Received</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {record.entries.length === 0 && (
                    <tr className="empty-row"><td colSpan={8}>No containers on this receipt yet.</td></tr>
                  )}
                  {record.entries.map((e) => (
                    <Fragment key={e.id}>
                      <tr>
                        <td className="mono">{e.shipment_number}</td>
                        <td className="mono">{e.sku_code || "—"}</td>
                        <td>{e.category ? INWARD_CATEGORY_LABELS[e.category] : "—"}</td>
                        <td className="mono">{e.sku_version || "—"}</td>
                        <td>{fmt(e.po_quantity)}</td>
                        <td>
                          {fmt(e.pallet_count)}
                          {e.pallet_count != null && e.pallet_count < e.po_quantity && (
                            <span className="badge partial" style={{ marginLeft: 6 }}>Short</span>
                          )}
                        </td>
                        <td>
                          {e.status === "inwarded"
                            ? <span className="badge approved">Inwarded</span>
                            : <span className="badge pending">Pending</span>}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {e.status === "pending" && canReceive && !isDraft && inwardingId !== e.id && (
                            <button className="btn btn-secondary" onClick={() => startInward(e)}>Inward</button>
                          )}
                          {e.status === "inwarded" && (e.qr_batch?.status === "generated" || canReceive) && (
                            <button
                              className={`btn ${e.qr_batch?.status === "generated" ? "btn-secondary" : "btn-primary"}`}
                              disabled={busy === e.id}
                              onClick={() => openOrGenerateQr(e)}
                            >
                              {e.qr_batch?.status === "generated"
                                ? `View QRs · ${e.qr_batch.batch_display_id}`
                                : busy === e.id ? "Generating…" : `Generate ${e.pallet_count} QRs`}
                            </button>
                          )}
                        </td>
                      </tr>
                      {inwardingId === e.id && form && (
                        <tr>
                          <td colSpan={8} style={{ background: "var(--ink-04, #f6f5f0)" }}>
                            <div className="form-grid" style={{ margin: "8px 0" }}>
                              <div className="field">
                                <label>Pallets Received</label>
                                <input type="number" min={1} step={1} value={form.pallets} autoFocus
                                  onChange={(ev) => setForm({ pallets: ev.target.value })} />
                              </div>
                            </div>
                            <div className="hint-text" style={{ marginBottom: 8 }}>
                              PO: {fmt(e.po_quantity)} pallets. One RM pallet QR per pallet received. Only {e.shipment_number} is marked Inwarded — other containers are unchanged.
                            </div>
                            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                              <button className="btn btn-primary" disabled={busy === e.id} onClick={() => confirmInward(e)}>
                                {busy === e.id ? "Inwarding…" : `Confirm Inward · ${e.shipment_number}`}
                              </button>
                              <button className="btn btn-ghost" disabled={busy === e.id} onClick={() => { setInwardingId(null); setForm(null); }}>Cancel</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <div className="sp-foot-right">
            {canEdit && record.status !== "received" && (
              <button className="btn btn-secondary" onClick={onEdit}>Edit</button>
            )}
          </div>
        </div>
      </div>

      {qr && (
        <QrGenerationPanel
          title={`RM QR · ${record.po_number} / ${qr.entry.shipment_number}`}
          detail={qr.detail}
          canGenerate={canReceive}
          onGenerate={async () => { await openOrGenerateQr(qr.entry); }}
          onClose={() => setQr(null)}
        />
      )}
    </>
  );
}
