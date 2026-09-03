"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { IpqcListItem, IpqcDetail } from "@/lib/types";
import IpqcDetailPanel from "@/components/ipqc/IpqcDetailPanel";

const SHIFTS = ["Shift A", "Shift B", "Shift C"];
const STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "hold", label: "Hold" },
];

export default function IpqcPage() {
  return (
    <Suspense fallback={null}>
      <IpqcPageContent />
    </Suspense>
  );
}

function IpqcPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const perms = me?.permissions.ipqc;

  const [records, setRecords] = useState<IpqcListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const [shift, setShift] = useState("");
  const [status, setStatus] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [openRecord, setOpenRecord] = useState<IpqcDetail | null>(null);
  const [panelMode, setPanelMode] = useState<"view" | "edit">("edit");

  // "View" only makes sense once there's something finished to review --
  // Pending/Draft records have nothing filled in yet, so the pencil (fill
  // in) is the only action offered until the record reaches Hold/Approved.
  const canView = (s: string) => s === "hold" || s === "approved";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const recs = await api.listIpqc({ search, date, shift, status });
      setRecords(recs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, date, shift, status]);

  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  async function openDetail(id: string, mode: "view" | "edit") {
    try {
      const rec = await api.getIpqc(id);
      setOpenRecord(rec);
      setPanelMode(mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  // Deep-link support, same convention as every other module's detail panel
  // -- opens in View when the linked record has something finished to show,
  // Edit otherwise (so a link to a still-Pending record lands on the form
  // that actually does something).
  useEffect(() => {
    const openId = searchParams.get("open");
    if (openId) {
      api.getIpqc(openId).then((rec) => {
        setOpenRecord(rec);
        setPanelMode(canView(rec.status) ? "view" : "edit");
      }).catch((e) => setError(e instanceof Error ? e.message : "Failed to load record"));
      router.replace("/ipqc");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const filterCount = (date ? 1 : 0) + (shift ? 1 : 0) + (status ? 1 : 0);

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>IPQC</h1>
          <div className="desc">Every IPQC record created to date, auto-identified against the current production run.</div>
        </div>
        <span className="auto-note">Records are created automatically from Material Consumption.</span>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search SKU code, shift incharge…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className="filter-btn" onClick={() => setShowFilters((v) => !v)}>
              Filters {filterCount > 0 && <span className="filter-count">{filterCount}</span>}
            </button>
            {showFilters && (
              <div className="filter-panel" style={{ display: "block" }}>
                <div className="f-row">
                  <label>Date</label>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div className="f-row">
                  <label>Shift</label>
                  <select value={shift} onChange={(e) => setShift(e.target.value)}>
                    <option value="">All</option>
                    {SHIFTS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="f-row">
                  <label>Status</label>
                  <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">All</option>
                    {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="f-actions">
                  <button className="btn-tertiary" onClick={() => { setDate(""); setShift(""); setStatus(""); }}>Clear all</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${records.length} of ${records.length} records`}</div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead>
            <tr>
              <th>Shipment Number</th><th>SKU Code</th><th>SKU Version</th>
              <th>Shift Incharge</th><th>Status</th><th>Date</th><th></th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr className="empty-row"><td colSpan={7}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              records.map((r) => (
                <tr key={r.id} className={r.status === "pending" ? "row-pending" : ""}>
                  <td className="mono">{r.shipment_number || "—"}</td>
                  <td className="mono">{r.sku_code || "—"}</td>
                  <td>{r.sku_version || "—"}</td>
                  <td>{r.shift_incharge || "—"}</td>
                  <td><span className={`badge ${r.status === "approved" ? "approved" : r.status === "hold" ? "hold" : r.status === "pending" ? "pending" : "draft"}`}>{r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span></td>
                  <td>{r.date || "—"}</td>
                  <td>
                    <span className="icon-actions">
                      {canView(r.status) && (
                        <a className="btn-tertiary" style={{ cursor: "pointer", marginRight: 10 }} onClick={() => openDetail(r.id, "view")}>View →</a>
                      )}
                      {perms?.can_edit && (
                        <button className="icon-btn" title="Fill in" onClick={() => openDetail(r.id, "edit")}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
                          </svg>
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openRecord && (
        <IpqcDetailPanel
          record={openRecord}
          onClose={() => setOpenRecord(null)}
          canEdit={!!perms?.can_edit}
          onSaved={refresh}
          mode={panelMode}
        />
      )}

      {perms && !perms.can_view && (
        <div className="hint-text" style={{ marginTop: 12 }}>You don&apos;t have permission to view IPQC records.</div>
      )}
    </>
  );
}
