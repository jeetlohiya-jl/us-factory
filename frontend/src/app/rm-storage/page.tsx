"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { Pallet, StorageRecordDetail } from "@/lib/types";
import StorageScanPanel from "@/components/storage/StorageScanPanel";
import StorageRecordDetailPanel from "@/components/storage/StorageRecordDetailPanel";

export default function RmStoragePage() {
  const me = useMe();
  const [pending, setPending] = useState<Pallet[]>([]);
  const [records, setRecords] = useState<StorageRecordDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [recordsSearch, setRecordsSearch] = useState("");

  const [showScan, setShowScan] = useState(false);
  const [openRecord, setOpenRecord] = useState<StorageRecordDetail | null>(null);

  const perms = me?.permissions.rm_storage;

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [pendingRes, recordsRes] = await Promise.all([
        api.listRmPending({ search }),
        api.listRmStorageRecords(recordsSearch),
      ]);
      setPending(pendingRes);
      setRecords(recordsRes);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, recordsSearch]);

  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  async function openStorageRecord(id: string) {
    try {
      const rec = await api.getRmStorageRecord(id);
      setOpenRecord(rec);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load storage record");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>RM Storage</h1>
          <div className="desc">Pallets still Pending Storage — scan and confirm to put them away. Stored pallets drop off this list automatically.</div>
        </div>
        <button className="btn btn-primary" disabled={!perms?.can_create} onClick={() => setShowScan(true)}>+ New Record</button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search pallet, SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${pending.length} pending pallet${pending.length === 1 ? "" : "s"}`}</div>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Pallet Number</th><th>SKU Name</th><th>Status</th></tr></thead>
          <tbody>
            {pending.length === 0 ? (
              <tr className="empty-row"><td colSpan={3}>{loading ? "Loading…" : "No pallets currently pending storage."}</td></tr>
            ) : (
              pending.map((p) => (
                <tr key={p.id} className="row-pending">
                  <td className="mono">{p.display_id}</td>
                  <td className="mono">{p.sku_code}</td>
                  <td><span className="badge pending">pending</span></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="page-head2" style={{ marginTop: 34 }}>
        <div>
          <h2 style={{ fontFamily: "var(--serif)" }}>Storage Records</h2>
          <div className="desc">Pallets already stored — open a record to see everything recorded for it.</div>
        </div>
      </div>
      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search pallet, SKU…" value={recordsSearch} onChange={(e) => setRecordsSearch(e.target.value)} />
          </div>
        </div>
        <div className="showing-count">{`Showing ${records.length} storage record${records.length === 1 ? "" : "s"}`}</div>
      </div>
      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Pallet Number</th><th>SKU Name</th><th>Location</th><th>Stored At</th><th></th></tr></thead>
          <tbody>
            {records.length === 0 ? (
              <tr className="empty-row"><td colSpan={5}>No pallets stored yet.</td></tr>
            ) : (
              records.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => openStorageRecord(r.id)}>
                  <td className="mono">{r.pallet_display_id}</td>
                  <td className="mono">{r.sku_code}</td>
                  <td className="mono">{r.location_display_id}</td>
                  <td>{new Date(r.stored_at).toLocaleString()}</td>
                  <td><a className="btn-tertiary">View →</a></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showScan && (
        <StorageScanPanel
          title="New RM Storage Record"
          hintSub="Scan the Pallet, then scan the Location."
          onScanPallet={api.scanRmPallet}
          onScanLocation={api.scanRmLocation}
          onConfirm={async (p, l) => { await api.confirmRmStorage(p, l); refresh(); }}
          onClose={() => { setShowScan(false); refresh(); }}
        />
      )}

      {openRecord && (
        <StorageRecordDetailPanel record={openRecord} onClose={() => setOpenRecord(null)} />
      )}
    </>
  );
}
