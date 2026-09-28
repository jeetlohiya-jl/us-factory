"use client";
import { Fragment, useState } from "react";
import { api } from "@/lib/api";
import type { Category, GoodsReceiptDetail, GoodsReceiptEntry, InspectionDetail, Permissions, QrGenerationDetail } from "@/lib/types";
import { INWARD_CATEGORY_LABELS, TRAY_FAMILY_QC_CATEGORIES } from "@/lib/types";
import QrGenerationPanel from "@/components/qr-generation/QrGenerationPanel";
import GrInwardWizard from "./GrInwardWizard";
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
// Exported for GrInwardWizard, which needs the same predicates.
export const needsStage = (e: GoodsReceiptEntry) => !e.category;
export const isTray = (e: GoodsReceiptEntry) => needsStage(e) || TRAY_FAMILY_QC_CATEGORIES.includes(e.category as string);

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
  detail, canEdit, canReceive, permissions, onClose, onEdit, onChanged,
}: {
  detail: GoodsReceiptDetail;
  canEdit: boolean;
  canReceive: boolean;
  // The goods_receipt module's full Permissions object (already remapped
  // from Factory's own row by lib/currentProduct.ts, same as canEdit/
  // canReceive above) -- GrInwardWizard needs the full shape, not just
  // these two derived booleans, because it reuses Wizard.tsx's exact
  // can_edit/can_fill_section-driven read-only logic.
  permissions: Permissions;
  onClose: () => void;
  onEdit: () => void;
  onChanged: (next: GoodsReceiptDetail) => void;
}) {
  const [record, setRecord] = useState(detail);
  // The inline quick-form below is now only for "Inward remaining" -- a
  // later top-up delivery on a container that's already completed its
  // Inward Inspection. The first inward opens the wizard instead (below).
  const [inwardingId, setInwardingId] = useState<string | null>(null);
  const [form, setForm] = useState<InwardForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ entry: GoodsReceiptEntry; detail: QrGenerationDetail } | null>(null);
  // The "first inward" flow now goes through the Inward Inspection wizard
  // (2026-09-28) instead of completing the inward directly.
  const [inwardWizard, setInwardWizard] = useState<{ entry: GoodsReceiptEntry; inspectionId: string; detail: InspectionDetail; isNew: boolean } | null>(null);

  const inwarded = record.entries.filter((e) => e.status === "inwarded");
  const isDraft = record.status === "draft";

  function apply(next: GoodsReceiptDetail) {
    setRecord(next);
    onChanged(next);
  }

  const leftToReceive = (e: GoodsReceiptEntry) => Math.max(0, e.po_quantity - (e.received_quantity ?? 0));

  function startInwardRemaining(e: GoodsReceiptEntry) {
    setError(null);
    setInwardingId(e.id);
    const left = leftToReceive(e);
    setForm({ quantity: isTray(e) ? "" : String(left), pallets: isTray(e) ? String(left) : "", stage: "" });
  }

  async function confirmInward(e: GoodsReceiptEntry) {
    if (!form) return;
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
      if (qty > leftToReceive(e)) {
        setError(`${e.shipment_number}: only ${fmt(leftToReceive(e))} ${e.unit} left to receive on this PO.`);
        setBusy(null);
        return;
      }
      const next = await api.inwardRemainingGoodsReceiptEntry(e.id, { received_quantity: qty, pallet_count: pallets });
      apply(next);
      setInwardingId(null);
      setForm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to inward container");
    } finally {
      setBusy(null);
    }
  }

  // Opens (creating or resuming) the Inward Inspection wizard for this
  // entry's first inward. `create_draft` is idempotent (backend migration
  // 0066): if an inspection is already linked to this entry, resume it
  // instead of creating a second one.
  async function openInwardWizard(e: GoodsReceiptEntry) {
    setError(null);
    setBusy(e.id);
    try {
      const insp = e.inward_inspection
        ? await api.getInspection(e.inward_inspection.id)
        : await api.createDraft((needsStage(e) ? "tray" : (e.category as Category)), e.id);
      setInwardWizard({ entry: e, inspectionId: insp.id, detail: insp, isNew: !e.inward_inspection });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open Inward Inspection");
    } finally {
      setBusy(null);
    }
  }

  // Refetches the full record after the wizard closes without an approval
  // (Save Draft, a Hold submit, or a Cancel that left an existing draft in
  // place) so the row's inward_inspection status picks up immediately.
  async function refreshRecord() {
    try {
      apply(await api.getGoodsReceipt(record.id));
    } catch { /* best-effort -- the row just won't refresh until the next open */ }
  }

  // Called by the wizard the moment its Inward Inspection is Approved.
  // Performs the actual Goods Receipt inward (never before this point --
  // "Do not generate RM QRs for entries that have not successfully
  // completed the inward process"), then auto-opens RM QR Generation for
  // that same entry, exactly like the pre-existing "Generate QRs" button.
  async function handleInspectionApproved(e: GoodsReceiptEntry, inspection: InspectionDetail) {
    setBusy(e.id);
    setError(null);
    try {
      const pallets = Number(inspection.total_quantity) || 0;
      const stage = needsStage(e) ? (inspection.category as InwardForm["stage"]) : undefined;
      const next = await api.inwardGoodsReceiptEntry(record.id, e.id, {
        received_quantity: isTray(e) ? pallets : e.po_quantity,
        unit: isTray(e) ? "Pallets" : e.unit,
        pallet_count: pallets,
        ...(stage ? { category: stage } : {}),
      });
      apply(next);
      const updatedEntry = next.entries.find((x) => x.id === e.id);
      if (updatedEntry) await openOrGenerateQr(updatedEntry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inspection approved, but the inward could not be completed");
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
                          {e.status === "pending" && canReceive && !isDraft && !record.zoho_cancelled && !!e.shipment_number && (
                            <button className="btn btn-secondary" disabled={busy === e.id} onClick={() => openInwardWizard(e)}>
                              {busy === e.id ? "Opening…"
                                : !e.inward_inspection ? "Inward"
                                : e.inward_inspection.status === "draft" ? "Resume Inspection"
                                : "View Inspection"}
                            </button>
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
                              <div className="field">
                                <label>Still to receive</label>
                                <div className="readonly-val">{fmt(leftToReceive(e))} {e.unit} of {fmt(e.po_quantity)} {e.unit}</div>
                              </div>
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
                                {busy === e.id ? "Inwarding…" : `Confirm Remaining · ${e.shipment_number}`}
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

      {inwardWizard && (
        <GrInwardWizard
          key={inwardWizard.inspectionId}
          entry={inwardWizard.entry}
          poNumber={record.po_number}
          vendorName={record.vendor_name}
          inspectionId={inwardWizard.inspectionId}
          initialDetail={inwardWizard.detail}
          permissions={permissions}
          isNew={inwardWizard.isNew}
          onApproved={(inspection) => { handleInspectionApproved(inwardWizard.entry, inspection); }}
          onSaved={refreshRecord}
          onClose={() => setInwardWizard(null)}
        />
      )}
    </>
  );
}
