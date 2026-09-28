"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { PackingListData, PackingListLineItem } from "@/lib/types";

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(v: number | null): string {
  if (v === null) return "—";
  return v.toLocaleString();
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="detail-kv-label">{label}</div>
      <div className="detail-kv-value">{value ?? "—"}</div>
    </div>
  );
}

/**
 * Goods Outward -- "Print Packing List" (2026-09-25). Opened from
 * GoodsOutwardDetailPanel's own "Print Packing List" action. Loads
 * whatever's already known (SKU packaging specs from the SKU Names admin
 * screen, the selected Customer's own address) via api.getPackingListData,
 * lets the operator fill in the rest -- PO No./PO Date/PI No./Ship To, and
 * each line item's UOM/Total Combo (the actual quantity going out on THIS
 * shipment, not a fixed SKU constant) -- then on "Save & Print" persists
 * those fields (api.savePackingList) and downloads the exact-format PDF
 * (api.downloadPackingListPdf), which recomputes Trays/Combo and Total
 * Quantity (Trays) server-side rather than trusting this preview's own
 * client-side arithmetic.
 *
 * 2026-09-28 -- HS Code, Case Size, Trays/Sleeve and Sleeves/Combo are also
 * editable right here now, not just on the SKU Names admin screen: they
 * still pre-fill from the SKU Version when already entered there, but a
 * gap can now be filled in (or fixed) from this panel directly. Saving
 * writes them back onto the SKU Version itself (see
 * packing_list_service.save_packing_list_fields), so it's still "once per
 * SKU Version" reference data reused on every later shipment, just no
 * longer requiring a separate trip to that screen to enter it the first
 * time.
 */
export default function PackingListPanel({
  shipmentId, shipmentNumber, onClose,
}: {
  shipmentId: string;
  shipmentNumber: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<PackingListData | null>(null);

  const [poNumber, setPoNumber] = useState("");
  const [poDate, setPoDate] = useState("");
  const [piNumber, setPiNumber] = useState("");
  const [shipTo, setShipTo] = useState("");
  // 2026-09-28 -- hs_code/case_size/trays_per_sleeve/sleeves_per_combo
  // joined in here too: pre-filled from the SKU Version when it's already
  // been entered on the SKU Names admin screen, but now editable right here
  // as well so a gap doesn't force a separate trip to that screen. Saving
  // writes them back onto the SKU Version itself (see
  // packing_list_service.save_packing_list_fields) -- still "once per SKU
  // Version" reference data, just fillable from either place now.
  const [lineEdits, setLineEdits] = useState<Record<string, {
    uom: string; total_combo: string;
    hs_code: string; case_size: string; trays_per_sleeve: string; sleeves_per_combo: string;
  }>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await api.getPackingListData(shipmentId);
        if (cancelled) return;
        setData(d);
        setPoNumber(d.po_number || "");
        setPoDate(d.po_date || "");
        setPiNumber(d.pi_number || "");
        setShipTo(d.ship_to_address || d.customer_address || "");
        setLineEdits(
          Object.fromEntries(
            d.line_items.map((li) => [li.id, {
              uom: li.uom || "Combo", total_combo: li.total_combo != null ? String(li.total_combo) : "",
              hs_code: li.hs_code || "", case_size: li.case_size || "",
              trays_per_sleeve: li.trays_per_sleeve || "", sleeves_per_combo: li.sleeves_per_combo || "",
            }])
          )
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load packing list data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shipmentId]);

  function traysPerCombo(li: PackingListLineItem): number | null {
    const a = num(lineEdits[li.id]?.trays_per_sleeve ?? li.trays_per_sleeve);
    const b = num(lineEdits[li.id]?.sleeves_per_combo ?? li.sleeves_per_combo);
    return a !== null && b !== null ? a * b : null;
  }

  function totalQuantity(li: PackingListLineItem): number | null {
    const combo = num(lineEdits[li.id]?.total_combo);
    const tpc = traysPerCombo(li);
    return combo !== null && tpc !== null ? combo * tpc : null;
  }

  const totals = (data?.line_items || []).reduce(
    (acc, li) => {
      const combo = num(lineEdits[li.id]?.total_combo);
      const qty = totalQuantity(li);
      return { combo: acc.combo + (combo || 0), qty: acc.qty + (qty || 0) };
    },
    { combo: 0, qty: 0 }
  );

  async function handleSaveAndPrint() {
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      await api.savePackingList(shipmentId, {
        po_number: poNumber.trim() || null,
        po_date: poDate || null,
        pi_number: piNumber.trim() || null,
        ship_to_address: shipTo.trim() || null,
        line_items: data.line_items.map((li) => ({
          id: li.id,
          uom: (lineEdits[li.id]?.uom || "").trim() || null,
          total_combo: num(lineEdits[li.id]?.total_combo),
          hs_code: (lineEdits[li.id]?.hs_code || "").trim() || null,
          case_size: (lineEdits[li.id]?.case_size || "").trim() || null,
          trays_per_sleeve: (lineEdits[li.id]?.trays_per_sleeve || "").trim() || null,
          sleeves_per_combo: (lineEdits[li.id]?.sleeves_per_combo || "").trim() || null,
        })),
      });
      await api.downloadPackingListPdf(shipmentId, shipmentNumber);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to generate Packing List");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>Print Packing List</h2>
            <div className="sub mono">{shipmentNumber}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {loading ? (
            <div className="hint-text">Loading…</div>
          ) : !data ? (
            <div className="error-banner">{error || "Could not load this shipment."}</div>
          ) : (
            <>
              <div className="detail-card">
                <h3>Shipment Details</h3>
                <div className="form-grid">
                  <div className="field">
                    <label>Consignee</label>
                    <div className="readonly-val">{data.customer}</div>
                  </div>
                  <div className="field">
                    <label>Address</label>
                    <div className="readonly-val">{data.customer_address || "— set on the Customers admin screen —"}</div>
                  </div>
                  <div className="field" style={{ gridColumn: "1 / -1" }}>
                    <label>Ship To</label>
                    <textarea rows={3} value={shipTo} onChange={(e) => setShipTo(e.target.value)} placeholder="Ship-to address" />
                  </div>
                  <div className="field">
                    <label>PO No.</label>
                    <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="e.g. 134480" />
                  </div>
                  <div className="field">
                    <label>PO Date</label>
                    <input type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>PI No.</label>
                    <input value={piNumber} onChange={(e) => setPiNumber(e.target.value)} placeholder="e.g. CIPI-260106039" />
                  </div>
                </div>
              </div>

              {/* One card per line item, fields stacked vertically -- a
                  10-column table (SKU/Description/HS Code/Case Size/UOM/
                  Total Combo/Trays-per-Sleeve/Sleeves-per-Combo/Trays-per-
                  Combo/Total Qty) doesn't fit this panel's width and was
                  breaking the layout (fields clipped/overlapping). Same
                  per-item detail-card pattern already used elsewhere in
                  this app for a row with many fields (e.g. Production's
                  per-machine cards). */}
              <div className="hint-text" style={{ marginBottom: 4 }}>
                SKU No. and Description come from the SKU Names admin screen. HS Code, Case Size, Trays/Sleeve and Sleeves/Combo pre-fill from there too when already entered — editable here if you need to fill a gap or fix one, and doing so updates the SKU Version itself, not just this shipment. UOM and Total Combo are the actual quantity going out on this shipment — enter them below.
              </div>
              {data.line_items.length === 0 ? (
                <div className="detail-card"><div className="hint-text">No line items on this shipment.</div></div>
              ) : (
                data.line_items.map((li) => (
                  <div className="detail-card" key={li.id}>
                    <h3 className="mono">{li.sku_code || "—"}</h3>
                    <div className="hint-text" style={{ marginBottom: 10 }}>{li.description || "—"}</div>
                    <div className="form-grid">
                      <div className="field">
                        <label>HS Code</label>
                        <input
                          value={lineEdits[li.id]?.hs_code ?? ""}
                          onChange={(e) => setLineEdits((prev) => ({ ...prev, [li.id]: { ...prev[li.id], hs_code: e.target.value } }))}
                        />
                      </div>
                      <div className="field">
                        <label>Case Size (inch)</label>
                        <input
                          value={lineEdits[li.id]?.case_size ?? ""}
                          onChange={(e) => setLineEdits((prev) => ({ ...prev, [li.id]: { ...prev[li.id], case_size: e.target.value } }))}
                        />
                      </div>
                      <div className="field">
                        <label>UOM</label>
                        <input
                          value={lineEdits[li.id]?.uom ?? ""}
                          onChange={(e) => setLineEdits((prev) => ({ ...prev, [li.id]: { ...prev[li.id], uom: e.target.value } }))}
                        />
                      </div>
                      <div className="field">
                        <label>Total Combo</label>
                        <input
                          type="number" value={lineEdits[li.id]?.total_combo ?? ""}
                          onChange={(e) => setLineEdits((prev) => ({ ...prev, [li.id]: { ...prev[li.id], total_combo: e.target.value } }))}
                        />
                      </div>
                      <div className="field">
                        <label>Trays/Sleeve</label>
                        <input
                          type="number"
                          value={lineEdits[li.id]?.trays_per_sleeve ?? ""}
                          onChange={(e) => setLineEdits((prev) => ({ ...prev, [li.id]: { ...prev[li.id], trays_per_sleeve: e.target.value } }))}
                        />
                      </div>
                      <div className="field">
                        <label>Sleeves/Combo</label>
                        <input
                          type="number"
                          value={lineEdits[li.id]?.sleeves_per_combo ?? ""}
                          onChange={(e) => setLineEdits((prev) => ({ ...prev, [li.id]: { ...prev[li.id], sleeves_per_combo: e.target.value } }))}
                        />
                      </div>
                      <div className="field">
                        <label>Trays/Combo</label>
                        <div className="readonly-val">{fmt(traysPerCombo(li))}</div>
                      </div>
                      <div className="field">
                        <label>Total Qty (Trays)</label>
                        <div className="readonly-val">{fmt(totalQuantity(li))}</div>
                      </div>
                    </div>
                  </div>
                ))
              )}

              {data.line_items.length > 0 && (
                <div className="detail-card">
                  <h3>Total</h3>
                  <div className="detail-grid">
                    <Kv label="Total Combo" value={fmt(totals.combo)} />
                    <Kv label="Total Qty (Trays)" value={fmt(totals.qty)} />
                  </div>
                </div>
              )}
            </>
          )}
          {error && data && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <div className="sp-foot-right">
            <button className="btn btn-primary" disabled={loading || saving || !data} onClick={handleSaveAndPrint}>
              {saving ? "Generating…" : "Save & Print"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
