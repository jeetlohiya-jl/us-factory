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
  const [lineEdits, setLineEdits] = useState<Record<string, { uom: string; total_combo: string }>>({});

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
            d.line_items.map((li) => [li.id, { uom: li.uom || "Combo", total_combo: li.total_combo != null ? String(li.total_combo) : "" }])
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
    const a = num(li.trays_per_sleeve);
    const b = num(li.sleeves_per_combo);
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

              <div className="detail-card">
                <h3>Goods Details</h3>
                <div className="hint-text" style={{ marginBottom: 10 }}>
                  SKU No., Description, HS Code, Case Size, Trays/Sleeve and Sleeves/Combo come from the SKU Names admin screen. UOM and Total Combo are the actual quantity going out on this shipment — enter them below.
                </div>
                <table className="qc-obs-table">
                  <thead>
                    <tr>
                      <th>SKU No.</th><th>Description</th><th>HS Code</th><th>Case Size (inch)</th>
                      <th style={{ width: 90 }}>UOM</th><th style={{ width: 100 }}>Total Combo</th>
                      <th style={{ width: 90 }}>Trays/ Sleeve</th><th style={{ width: 90 }}>Sleeves/ Combo</th>
                      <th style={{ width: 90 }}>Trays/ Combo</th><th style={{ width: 120 }}>Total Qty (Trays)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.line_items.length === 0 ? (
                      <tr className="empty-row"><td colSpan={10}>No line items on this shipment.</td></tr>
                    ) : (
                      data.line_items.map((li) => (
                        <tr key={li.id}>
                          <td className="mono">{li.sku_code || "—"}</td>
                          <td>{li.description || "—"}</td>
                          <td>{li.hs_code || "—"}</td>
                          <td>{li.case_size || "—"}</td>
                          <td>
                            <input
                              value={lineEdits[li.id]?.uom ?? ""}
                              onChange={(e) => setLineEdits((prev) => ({ ...prev, [li.id]: { ...prev[li.id], uom: e.target.value } }))}
                            />
                          </td>
                          <td>
                            <input
                              type="number" value={lineEdits[li.id]?.total_combo ?? ""}
                              onChange={(e) => setLineEdits((prev) => ({ ...prev, [li.id]: { ...prev[li.id], total_combo: e.target.value } }))}
                            />
                          </td>
                          <td>{li.trays_per_sleeve || "—"}</td>
                          <td>{li.sleeves_per_combo || "—"}</td>
                          <td>{fmt(traysPerCombo(li))}</td>
                          <td>{fmt(totalQuantity(li))}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  {data.line_items.length > 0 && (
                    <tfoot>
                      <tr style={{ fontWeight: 700 }}>
                        <td colSpan={5}>Total</td>
                        <td>{fmt(totals.combo)}</td>
                        <td colSpan={3} />
                        <td>{fmt(totals.qty)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
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
