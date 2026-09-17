"use client";
import { useEffect, useState } from "react";
import type { RqcCoaEntry, RqcCoaObservation } from "@/lib/types";
import { RQC_COA_BASE, RQC_COA_FUNCTIONAL, RQC_COA_PACKING, RQC_COA_PRINTING } from "@/lib/types";
import { api, ApiError } from "@/lib/api";
import { CoaTable, coaListToMap, coaKey } from "@/components/rqc/CoaShared";

/**
 * The per-shipment COA flow (item 7 of the RQC redesign): opened from the
 * RQC list's COA column/action, auto-filled with the shipment number of
 * whichever row it was opened from. Backed entirely by
 * backend/app/api/rqc_coa.py -- find-or-create by Shipment Number (COA is
 * exactly one record per shipment, never more, confirmed by the user), then
 * one atomic save for its 4 observation tables, same CoaTable component and
 * RQC_COA_* constants the old inline-in-RqcDetailPanel version used,
 * completely unchanged.
 */
export default function CoaEntryPanel({
  shipmentNumber, canEdit, onClose, onSaved,
}: {
  shipmentNumber: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [entry, setEntry] = useState<RqcCoaEntry | null>(null);
  const [coa, setCoa] = useState<Record<string, RqcCoaObservation>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.createOrGetRqcCoaEntry(shipmentNumber);
        if (cancelled) return;
        setEntry(res);
        setCoa(coaListToMap(res.coa_observations));
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to open COA entry");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipmentNumber]);

  function setCoaValue(group: string, sr: number, value: string) {
    setCoa((prev) => ({ ...prev, [coaKey(group, sr)]: { coa_group: group, sr, observation: value } }));
  }

  async function handleSave() {
    if (!entry) return;
    setSaving(true);
    setError(null);
    try {
      await api.saveRqcCoaEntry(entry.id, Object.values(coa).filter((o) => !!o.observation));
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Failed to save COA entry");
    } finally {
      setSaving(false);
    }
  }

  const editable = canEdit && !loading;

  return (
    <>
      <div className="panel-overlay open" onClick={onClose} />
      <div className="side-panel open">
        <div className="sp-head">
          <div>
            <h2>Certificate of Analysis</h2>
            <div className="sub mono">{shipmentNumber}</div>
          </div>
          <button className="sp-close" onClick={onClose}>×</button>
        </div>
        <div className="sp-body">
          {error && <div className="error-banner">{error}</div>}
          {loading ? (
            <div className="hint-text">Loading…</div>
          ) : (
            <>
              <CoaTable title="COA — Base Material" group="base" params={RQC_COA_BASE} values={coa} editable={editable} onChange={setCoaValue} />
              <CoaTable title="COA — Functional Parameters" group="functional" params={RQC_COA_FUNCTIONAL} values={coa} editable={editable} onChange={setCoaValue} />
              <CoaTable title="COA — Packing Details" group="packing" params={RQC_COA_PACKING} values={coa} editable={editable} onChange={setCoaValue} />
              <CoaTable title="COA — Printing & Labelling" group="printing" params={RQC_COA_PRINTING} values={coa} editable={editable} onChange={setCoaValue} />
            </>
          )}
        </div>
        <div className="sp-foot">
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          {editable && (
            <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
