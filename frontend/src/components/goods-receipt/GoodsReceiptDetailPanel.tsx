"use client";
import { Fragment, useState } from "react";
import { api } from "@/lib/api";
import type { Category, GoodsReceiptDetail, GoodsReceiptEntry, InspectionDetail, Permissions, QrGenerationDetail } from "@/lib/types";
import { INWARD_CATEGORY_LABELS, TRAY_FAMILY_QC_CATEGORIES } from "@/lib/types";
import QrGenerationPanel from "@/components/qr-generation/QrGenerationPanel";
import GrInwardWizard from "./GrInwardWizard";
import GrQuickInwardForm, { type QuickInwardSubmission } from "./GrQuickInwardForm";
import { GoodsReceiptStatusBadge } from "./GoodsReceiptStatusBadge";
import { T, categoryLabel } from "@/lib/terms";

// Display only -- INWARD_CATEGORY_LABELS is typed for just the 7 Inward
// QC categories (tray/lnp_tray/film/pad/polybag/cfb/glue), so it renders
// blank for a category outside that set (e.g. "packaging"/"ppe"/"pallet",
// synced in from Zoho the same way RM is, but never routed through Inward
// Vehicle Inspection / Inward QC). categoryLabel() falls back to the raw
// value for anything unmapped, so nothing here ever silently disappears.
// Used for the header's aggregated "Categories" field, which summarizes
// across every row on the PO -- a bucket label is the right thing there.
const goodsReceiptCategoryLabel = (c: string): string =>
  (INWARD_CATEGORY_LABELS as Record<string, string>)[c] ?? categoryLabel(c);

// 2026-09-30 -- the per-row "Category" column, by contrast, should identify
// THAT row's material. For the 7 real QC categories the bucket label already
// does that (every "polybag" row really is a polybag). For the newer
// catch-all categories (packaging/ppe/pallet and anything else outside the
// QC set) many unrelated SKUs share one bucket -- a PO with PET Strap,
// Corner Protector and Stretch wrap would show "Packaging" on all three
// rows, telling you nothing. Prefer the SKU's own name there instead.
const entryCategoryLabel = (e: Pick<GoodsReceiptEntry, "category" | "sku_name">): string => {
  const c = e.category;
  if (!c) return "";
  const qcLabel = (INWARD_CATEGORY_LABELS as Record<string, string>)[c];
  return qcLabel ?? e.sku_name ?? categoryLabel(c);
};

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

type Stage = "" | "tray" | "lnp_tray";
// A row with no category is a tray synced from Zoho whose stage (RM /
// LNP Tray) is chosen at inward -- synced rows of any other material always
// carry their SKU's category.
// Exported for GrInwardWizard, which needs the same predicates.
export const needsStage = (e: GoodsReceiptEntry) => !e.category;
export const isTray = (e: GoodsReceiptEntry) => needsStage(e) || TRAY_FAMILY_QC_CATEGORIES.includes(e.category as string);

// 2026-09-30 -- Inward Vehicle Inspection is only required for a container
// with a real Container/Shipment Number (from Zoho, or entered by hand). A
// row whose shipment number is one of these auto-generated placeholders
// (created by zoho_upsert_purchase_order when Zoho sends no "Container:")
// skips the inspection entirely -- see GrQuickInwardForm.tsx.
export const isAutoShipment = (e: GoodsReceiptEntry) => (e.shipment_number || "").startsWith("AUTO-");

// 2026-09-30 -- Polybag/Soaker Pad/CFB entries need a COA (PDF, Word doc, or
// image) uploaded before their QR codes can be generated, independent of
// shipment-number type (see goods_receipt_generate_pallets' own guard).
export const needsCoa = (e: GoodsReceiptEntry) => ["pad", "polybag", "cfb"].includes(e.category as string);

/**
 * Goods Receipt detail -- the receiving screen. Every container x SKU entry
 * is its own row with its own status; "Inward" opens the Inward Inspection
 * wizard for THAT row only, and approving it changes only that entry. Once
 * inwarded, the row offers Generate / View QRs, which opens the existing RM
 * QR panel (QrGenerationPanel, unchanged: pallet grid, 2x2in label
 * printing). A container that arrived short can take a later "Inward
 * remaining" delivery, which (2026-09-28) opens the SAME wizard again --
 * its own checklist/photos, its own Inward Inspection record -- rather
 * than the bare quantity/pallets form this used to be.
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ entry: GoodsReceiptEntry; detail: QrGenerationDetail } | null>(null);
  // The "first inward" flow now goes through the Inward Inspection wizard
  // (2026-09-28) instead of completing the inward directly.
  const [inwardWizard, setInwardWizard] = useState<{ entry: GoodsReceiptEntry; inspectionId: string; detail: InspectionDetail; isNew: boolean } | null>(null);
  // 2026-09-30 -- an auto-shipment entry (no real Container/Shipment Number)
  // never gets an Inward Vehicle Inspection record at all: this is the
  // lightweight alternative (pallets + QR quantity + COA if needed), opened
  // instead of the wizard above. See isAutoShipment/GrQuickInwardForm.tsx.
  const [quickInward, setQuickInward] = useState<GoodsReceiptEntry | null>(null);

  const inwarded = record.entries.filter((e) => e.status === "inwarded");
  const isDraft = record.status === "draft";

  function apply(next: GoodsReceiptDetail) {
    setRecord(next);
    onChanged(next);
  }

  const leftToReceive = (e: GoodsReceiptEntry) => Math.max(0, e.po_quantity - (e.received_quantity ?? 0));

  // The inspection currently worth resuming for this entry -- i.e. one
  // that hasn't reached "approved" yet. Migration 0068 lets an entry
  // accumulate one APPROVED inspection per delivery over its lifetime (see
  // api.ts's currentInwardInspection), so `e.inward_inspection` alone isn't
  // enough to decide "resume vs. start fresh": once the most recent
  // delivery's inspection is approved, the next "Inward"/"Inward remaining"
  // click must open a brand new one rather than reopening that finished
  // record.
  const activeInspection = (e: GoodsReceiptEntry) =>
    e.inward_inspection && e.inward_inspection.status !== "approved" ? e.inward_inspection : null;

  // Opens (creating or resuming) the Inward Inspection wizard for this
  // entry's next delivery -- its first inward while `e.status` is still
  // "pending", or a later "Inward remaining" top-up once it's already
  // "inwarded" but arrived short. `create_draft` is idempotent (backend
  // migrations 0066/0068): a draft/hold already in progress for this entry
  // is resumed instead of creating a second one; a delivery whose
  // inspection is already approved always gets a fresh one.
  async function openInwardWizard(e: GoodsReceiptEntry) {
    // No real Container/Shipment Number -- skip Inward Vehicle Inspection
    // entirely and use the lightweight quick-inward form instead.
    if (isAutoShipment(e)) {
      setQuickInward(e);
      return;
    }
    setError(null);
    setBusy(e.id);
    try {
      const resumable = activeInspection(e);
      const insp = resumable
        ? await api.getInspection(resumable.id)
        : await api.createDraft((needsStage(e) ? "tray" : (e.category as Category)), e.id);
      setInwardWizard({ entry: e, inspectionId: insp.id, detail: insp, isNew: !resumable });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open Inward Inspection");
    } finally {
      setBusy(null);
    }
  }

  // Called by GrQuickInwardForm on Submit -- performs the inward (or
  // "Inward remaining" top-up) directly, with no Inward Vehicle Inspection
  // record involved, then auto-opens QR generation exactly like the IVI
  // path's handleInspectionApproved does. Only Soaker Pad ("pallets" kind)
  // still assumes a full-PO-quantity receipt counted in pallets, matching
  // the full wizard's own non-tray assumption -- everything else
  // ("quantity" kind) uses exactly what was typed in as the actual
  // received quantity/unit, since it isn't palletized and may not match
  // the PO quantity or unit exactly (e.g. glue received by weight).
  async function handleQuickInward(e: GoodsReceiptEntry, submission: QuickInwardSubmission) {
    setBusy(e.id);
    setError(null);
    try {
      let next: GoodsReceiptDetail;
      if (e.status === "inwarded") {
        next = await api.inwardRemainingGoodsReceiptEntry(e.id, submission.kind === "pallets"
          ? { received_quantity: leftToReceive(e), pallet_count: submission.pallets, qr_quantity: submission.qrQuantity }
          : { received_quantity: submission.receivedQuantity, unit: submission.unit, qr_quantity: submission.qrQuantity });
      } else {
        next = await api.inwardGoodsReceiptEntry(record.id, e.id, submission.kind === "pallets"
          ? { received_quantity: e.po_quantity, unit: e.unit, pallet_count: submission.pallets, qr_quantity: submission.qrQuantity }
          : { received_quantity: submission.receivedQuantity, unit: submission.unit, qr_quantity: submission.qrQuantity });
      }
      apply(next);
      setQuickInward(null);
      const updatedEntry = next.entries.find((x) => x.id === e.id);
      if (updatedEntry) await openOrGenerateQr(updatedEntry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to inward this container");
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
  // Performs the actual Goods Receipt inward -- or, when this entry is
  // already inwarded, an "Inward remaining" top-up -- never before this
  // point ("Do not generate RM QRs for entries that have not successfully
  // completed the inward process"), then auto-opens RM QR Generation for
  // that same entry, exactly like the pre-existing "Generate QRs" button.
  async function handleInspectionApproved(e: GoodsReceiptEntry, inspection: InspectionDetail) {
    setBusy(e.id);
    setError(null);
    try {
      const pallets = Number(inspection.total_quantity) || 0;
      let next: GoodsReceiptDetail;
      if (e.status === "inwarded") {
        // A later delivery on a container that's already been inwarded
        // once. The wizard only collects a pallet count (no separate
        // quantity-in-unit field, matching first inward's own assumption
        // below that a non-tray material always arrives complete) -- for a
        // tray, the pallet count IS the quantity; for anything else, treat
        // this delivery as completing whatever's still left to receive.
        // The RPC re-validates this server-side against the entry's actual
        // remaining quantity regardless.
        next = await api.inwardRemainingGoodsReceiptEntry(e.id, {
          ...(isTray(e) ? {} : { received_quantity: leftToReceive(e) }),
          pallet_count: pallets,
        });
      } else {
        const stage = needsStage(e) ? (inspection.category as Stage) : undefined;
        next = await api.inwardGoodsReceiptEntry(record.id, e.id, {
          received_quantity: isTray(e) ? pallets : e.po_quantity,
          unit: isTray(e) ? "Pallets" : e.unit,
          pallet_count: pallets,
          ...(stage ? { category: stage } : {}),
        });
      }
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
  //
  // Bug fixed 2026-09-28 (found from a screen recording: after Submit ->
  // auto-inward -> auto-QR-generate, the Containers table kept showing the
  // container as "Pending" with no QR button until a hard page refresh):
  // this used to merge the new qr_batch onto `record` read directly from
  // this function's own closure. When called right after
  // handleInspectionApproved's `apply(next)` -- i.e. from the SAME render's
  // closure, before React had re-rendered this component with the fresh
  // `record` -- that closure's `record` was still the PRE-inward snapshot
  // (status "pending", no received_quantity/pallet_count yet). Spreading
  // `...record` here silently reverted the just-applied inward back to
  // "pending" everywhere except the one qr_batch field this function itself
  // set, which is exactly the stale display that only a full refetch
  // (bypassing the stale closure entirely) corrected. Using the functional
  // form of setRecord guarantees this always merges onto the latest state,
  // never a stale one, regardless of when this promise resolves.
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
      setRecord((prev) => {
        const next = {
          ...prev,
          entries: prev.entries.map((x) =>
            x.id === e.id ? { ...x, qr_batch: { id: d.id, batch_display_id: d.batch_display_id, status: d.status, quantity: d.quantity } } : x
          ),
        };
        onChanged(next);
        return next;
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
              <Kv label="Categories" value={Array.from(new Set(record.entries.map((e) => e.category).filter(Boolean))).map((c) => goodsReceiptCategoryLabel(c!)).join(", ") || "—"} />
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
                        <td>{e.category ? entryCategoryLabel(e) : <span className="hint-text" style={{ margin: 0 }}>Choose at inward</span>}</td>
                        <td>{fmt(e.po_quantity)} {e.unit}</td>
                        <td>
                          {/* A tray's received quantity IS its pallet count; other
                              materials show their quantity plus the pallets it came on --
                              only when pallet_count is actually known (Soaker Pad and
                              full-wizard materials); an auto-shipment entry received by
                              Quantity + Unit instead (2026-09-30) has none to show. */}
                          {e.received_quantity == null ? "—"
                            : isTray(e) || e.pallet_count == null ? `${fmt(e.received_quantity)} ${e.unit}`
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
                                : !activeInspection(e) ? "Inward"
                                : activeInspection(e)!.status === "draft" ? "Resume Inspection"
                                : "View Inspection"}
                            </button>
                          )}
                          {/* Shouldn't normally be reachable -- both Inward flows require the
                              COA before Submit for this category -- but QR generation itself
                              also refuses without one (goods_receipt_generate_pallets), so this
                              is a plain explanation rather than a dead button if it ever is. */}
                          {e.status === "inwarded" && e.qr_batch?.status !== "generated" && needsCoa(e) && !e.coa_storage_path && (
                            <span className="hint-text" style={{ margin: 0 }}>COA missing -- QR generation is blocked until one is uploaded.</span>
                          )}
                          {e.status === "inwarded" && (e.qr_batch?.status === "generated" || canReceive) && !(needsCoa(e) && !e.coa_storage_path && e.qr_batch?.status !== "generated") && (
                            <button
                              className={`btn ${e.qr_batch?.status === "generated" ? "btn-secondary" : "btn-primary"}`}
                              disabled={busy === e.id}
                              onClick={() => openOrGenerateQr(e)}
                            >
                              {e.qr_batch?.status === "generated"
                                ? `View QRs · ${e.qr_batch.batch_display_id}`
                                : busy === e.id ? "Generating…"
                                : e.qr_batch ? "Generate remaining QRs"   // batch grew after an "Inward remaining"
                                : `Generate ${e.qr_quantity ?? e.pallet_count} QRs`}
                            </button>
                          )}
                          {e.status === "inwarded" && canReceive && !record.zoho_cancelled && leftToReceive(e) > 0 && (
                            <button className="btn btn-secondary" style={{ marginLeft: 8 }} disabled={busy === e.id} onClick={() => openInwardWizard(e)}>
                              {busy === e.id ? "Opening…"
                                : !activeInspection(e) ? "Inward remaining"
                                : activeInspection(e)!.status === "draft" ? "Resume Inspection"
                                : "View Inspection"}
                            </button>
                          )}
                        </td>
                      </tr>
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

      {quickInward && (
        <GrQuickInwardForm
          entry={quickInward}
          poNumber={record.po_number}
          vendorName={record.vendor_name}
          canEdit={canReceive}
          busy={busy === quickInward.id}
          error={error}
          onClose={() => setQuickInward(null)}
          onSubmit={(submission) => handleQuickInward(quickInward, submission)}
        />
      )}
    </>
  );
}
