"use client";
import { Fragment, useState } from "react";
import { api } from "@/lib/api";
import type { GoodsReceiptDetail, GoodsReceiptEntry, QrGenerationDetail } from "@/lib/types";
import { INWARD_CATEGORY_LABELS, TRAY_FAMILY_QC_CATEGORIES } from "@/lib/types";
import QrGenerationPanel from "@/components/qr-generation/QrGenerationPanel";
import { GoodsReceiptStatusBadge } from "./GoodsReceiptStatusBadge";
import { T } from "@/lib/terms";

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

// Trays are counted in pallets: inwarding asks one number, pallets received.
// Every other material is received in its PO line's unit, plus how many
// pallets it arrived on (one RM QR per pallet).
type InwardForm = { quantity: string; pallets: string; stage: "" | "tray" | "lnp_tray" };
// A row with no category is a tray synced from Zoho whose stage (Base Tray /
// LNP Tray) is chosen at inward -- synced rows of any other material always
// carry their SKU's category.
const needsStage = (e: GoodsReceiptEntry) => !e.category;
const isTray = (e: GoodsReceiptEntry) => needsStage(e) || TRAY_FAMILY_QC_CATEGORIES.includes(e.category as string);

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
  // "first" = the container's first inward; "remaining" = a later delivery
  // of a container that arrived short (optional -- it may never come).
  const [inwardMode, setInwardMode] = useState<"first" | "remaining">("first");
  const [form, setForm] = useState<InwardForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ entry: GoodsReceiptEntry; detail: QrGenerationDetail } | null>(null);

  const inwarded = record.entries.filter((e) => e.status === "inwarded");
  const isDraft = record.status === "draft";

  function apply(next: GoodsReceiptDetail) {
    setRecord(next);
    onChanged(next);
  }

  const leftToReceive = (e: GoodsReceiptEntry) => Math.max(0, e.po_quantity - (e.received_quantity ?? 0));

  function startInwardRemaining(e: GoodsReceiptEntry) {
    setError(null);
    setInwardMode("remaining");
    setInwardingId(e.id);
    const left = leftToReceive(e);
    setForm({ quantity: isTray(e) ? "" : String(left), pallets: isTray(e) ? String(left) : "", stage: "" });
  }

  function startInward(e: GoodsReceiptEntry) {
    setError(null);
    setInwardMode("first");
    setInwardingId(e.id);
    setForm({
      // Default to the ordered quantity -- the common case is a full
      // container -- but it stays editable for a short delivery.
      quantity: isTray(e) ? "" : String(e.po_quantity),
      pallets: isTray(e) ? String(e.po_quantity) : "",
      stage: "",
    });
  }

  async function confirmInward(e: GoodsReceiptEntry) {
    if (!form) return;
    if (inwardMode === "first" && needsStage(e) && !form.stage) { setError(`${e.shipment_number}: choose Base Tray or LNP Tray.`); return; }
    const pallets = Number(form.pallets);
    const qty = isTray(e) ? pallets : Number(form.quantity);
    if (!isTray(e) && !(qty > 0)) { setError(`${e.shipment_number}: Quantity Received must be greater than 0.`); return; }
    if (!(pallets >= 1) || !Number.isInteger(pallets)) {
      setError(`${e.shipment_number}: ${isTray(e) ? "Pallets Received" : "Number of Pallets"} must be a whole number of at least 1.`);
      return;
    }
    setBusy(e.id);
    setError(null);
    try {
      if (inwardMode === "remaining" && qty > leftToReceive(e)) {
        setError(`${e.shipment_number}: only ${fmt(leftToReceive(e))} ${e.unit} left to receive on this PO.`);
        setBusy(null);
        return;
      }
      const next = inwardMode === "remaining"
        ? await api.inwardRemainingGoodsReceiptEntry(e.id, { received_quantity: qty, pallet_count: pallets })
        : await api.inwardGoodsReceiptEntry(record.id, e.id, {
            received_quantity: qty, unit: isTray(e) ? "Pallets" : e.unit, pallet_count: pallets,
            ...(needsStage(e) && form.stage ? { category: form.stage } : {}),
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
          {record.zoho_cancelled && (
            <div className="error-banner">This PO was cancelled in Zoho Books. Its containers can no longer be inwarded.</div>
          )}
          {record.zoho_purchaseorder_id && (
            <div className="hint-text" style={{ marginBottom: 12 }}>
              Synced from Zoho Books{record.zoho_synced_at ? ` · last updated ${new Date(record.zoho_synced_at).toLocaleString()}` : ""}.
              {(record.zoho_sync_notes || []).filter((n) => !n.startsWith("Skipped line")).map((n, i) => (
                <div key={i} style={{ color: "var(--amber, #9a6b00)", marginTop: 4 }}>• {n}</div>
              ))}
            </div>
          )}
          {error && <div className="error-banner">{error}</div>}
          <div className="detail-card">
            <h3>General Information</h3>
            <div className="detail-grid">
              <Kv label="PO Number" value={<span className="mono">{record.po_number}</span>} />
              <Kv label="Categories" value={Array.from(new Set(record.entries.map((e) => e.category).filter(Boolean))).map((c) => INWARD_CATEGORY_LABELS[c!]).join(", ") || "—"} />
              <Kv label="Vendor" value={record.vendor_name} />
              <Kv label="Shipment Inwarded" value={`${inwarded.length} of ${record.entries.length}`} />
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
                    <th>{T.shipmentNumber}</th><th>SKU</th><th>Category</th>
                    <th>PO Quantity</th><th>Received</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {record.entries.length === 0 && (
                    <tr className="empty-row"><td colSpan={7}>No containers on this receipt yet.</td></tr>
                  )}
                  {record.entries.map((e) => (
                    <Fragment key={e.id}>
                      <tr>
                        <td className="mono">{e.shipment_number || <span className="badge partial">Missing</span>}</td>
                        <td className="mono">{e.sku_code || "—"}</td>
                        <td>{e.category ? INWARD_CATEGORY_LABELS[e.category] : <span className="hint-text" style={{ margin: 0 }}>Choose at inward</span>}</td>
                        <td>{fmt(e.po_quantity)} {e.unit}</td>
                        <td>
                          {/* A tray's received quantity IS its pallet count; other
                              materials show their quantity plus the pallets it came on. */}
                          {e.received_quantity == null ? "—"
                            : isTray(e) ? `${fmt(e.received_quantity)} ${e.unit}`
                            : `${fmt(e.received_quantity)} ${e.unit} · ${e.pallet_count} pallet${e.pallet_count === 1 ? "" : "s"}`}
                          {e.received_quantity != null && e.received_quantity < e.po_quantity && (
                            <span className="badge partial" style={{ marginLeft: 6 }}>Short</span>
                          )}
                          {(e.inward_events?.length ?? 0) > 1 && (
                            <div className="hint-text" style={{ margin: "2px 0 0" }} title={(e.inward_events || []).map((ev) => `${fmt(ev.received_quantity)} ${ev.unit} on ${new Date(ev.inwarded_at).toLocaleDateString()}`).join(" + ")}>
                              ({(e.inward_events || []).map((ev) => fmt(ev.received_quantity)).join(" + ")})
                            </div>
                          )}
                        </td>
                        <td>
                          {e.status === "inwarded"
                            ? <span className="badge approved">Inwarded</span>
                            : <span className="badge pending">Pending</span>}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {e.status === "pending" && canReceive && !isDraft && !record.zoho_cancelled && !e.shipment_number && (
                            <span className="hint-text" style={{ margin: 0 }}>Add its Shipment Number (Edit) to inward</span>
                          )}
                          {e.status === "pending" && canReceive && !isDraft && !record.zoho_cancelled && !!e.shipment_number && inwardingId !== e.id && (
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
                                : busy === e.id ? "Generating…"
                                : e.qr_batch ? "Generate remaining QRs"   // batch grew after an "Inward remaining"
                                : `Generate ${e.pallet_count} QRs`}
                            </button>
                          )}
                          {e.status === "inwarded" && canReceive && !record.zoho_cancelled && leftToReceive(e) > 0 && inwardingId !== e.id && (
                            <button className="btn btn-secondary" style={{ marginLeft: 8 }} onClick={() => startInwardRemaining(e)}>
                              Inward remaining
                            </button>
                          )}
                        </td>
                      </tr>
                      {inwardingId === e.id && form && (
                        <tr>
                          <td colSpan={8} style={{ background: "var(--ink-04, #f6f5f0)" }}>
                            <div className="form-grid" style={{ margin: "8px 0" }}>
                              {!isTray(e) && (
                                <>
                                  {/* Same unit as the PO line, so ordered vs received
                                      always compare like for like (Short). */}
                                  <div className="field">
                                    <label>Quantity Received ({e.unit})</label>
                                    <input type="number" min={0} step="any" value={form.quantity} autoFocus
                                      onChange={(ev) => setForm({ ...form, quantity: ev.target.value })} />
                                  </div>
                                </>
                              )}
                              {inwardMode === "remaining" && (
                                <div className="field">
                                  <label>Still to receive</label>
                                  <div className="readonly-val">{fmt(leftToReceive(e))} {e.unit} of {fmt(e.po_quantity)} {e.unit}</div>
                                </div>
                              )}
                              {inwardMode === "first" && needsStage(e) && (
                                <div className="field">
                                  <label>Category</label>
                                  <select value={form.stage} autoFocus onChange={(ev) => setForm({ ...form, stage: ev.target.value as InwardForm["stage"] })}>
                                    <option value="">Select</option>
                                    <option value="tray">Base Tray</option>
                                    <option value="lnp_tray">LNP Tray</option>
                                  </select>
                                </div>
                              )}
                              <div className="field">
                                <label>{isTray(e) ? "Pallets Received" : "Number of Pallets"}</label>
                                <input type="number" min={1} step={1} value={form.pallets} autoFocus={isTray(e)}
                                  onChange={(ev) => setForm({ ...form, pallets: ev.target.value })} />
                              </div>
                            </div>
                            <div className="hint-text" style={{ marginBottom: 8 }}>
                              PO: {fmt(e.po_quantity)} {e.unit}. One RM pallet QR per pallet received. Only {e.shipment_number} is marked Inwarded — other containers are unchanged.
                            </div>
                            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                              <button className="btn btn-primary" disabled={busy === e.id} onClick={() => confirmInward(e)}>
                                {busy === e.id ? "Inwarding…" : inwardMode === "remaining" ? `Confirm Remaining · ${e.shipment_number}` : `Confirm Inward · ${e.shipment_number}`}
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
