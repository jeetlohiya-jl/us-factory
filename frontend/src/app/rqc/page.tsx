"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { RqcListItem, RqcDetail } from "@/lib/types";
import RqcDetailPanel from "@/components/rqc/RqcDetailPanel";
import NewRqcPanel from "@/components/rqc/NewRqcPanel";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import Pagination from "@/components/Pagination";

const MODULE = "rqc";

const STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "hold", label: "Hold" },
];

export default function RqcPage() {
  return (
    <Suspense fallback={null}>
      <RqcPageContent />
    </Suspense>
  );
}

function RqcPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const perms = me?.permissions.rqc;

  const [records, setRecords] = useState<RqcListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);

  const [openRecord, setOpenRecord] = useState<RqcDetail | null>(null);
  const [panelMode, setPanelMode] = useState<"view" | "edit">("edit");
  const [showNewPanel, setShowNewPanel] = useState(false);

  // "View" only makes sense once there's something finished to review --
  // Pending/Draft records have nothing filled in yet, so the pencil (fill
  // in) is the only action offered until the record reaches Hold/Approved.
  const canView = (s: string) => s === "hold" || s === "approved";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = listCacheKey(MODULE, { search, status, page });
      const { items, matched_count } = await cachedList(key, () => api.listRqc({ search, status, page }));
      setRecords(items);
      setMatchedCount(matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, status, page]);

  useImmediateThenDebounced(refresh, [refresh]);

  useEffect(() => setPage(1), [search, status]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  async function openDetail(id: string, mode: "view" | "edit") {
    try {
      const rec = await api.getRqc(id);
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
      api.getRqc(openId).then((rec) => {
        setOpenRecord(rec);
        setPanelMode(canView(rec.status) || !perms?.can_fill_section ? "view" : "edit");
      }).catch((e) => setError(e instanceof Error ? e.message : "Failed to load record"));
      router.replace("/rqc");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const filterCount = status ? 1 : 0;

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>RQC</h1>
          <div className="desc">Final Quality Control -- every record created to date. Search, filter, or open a record to view it in full.</div>
        </div>
        <button
          className="btn btn-primary"
          disabled={!perms || !perms.can_create}
          title={perms && !perms.can_create ? "You don't have permission to create RQC records." : ""}
          onClick={() => setShowNewPanel(true)}
        >
          + New Record
        </button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search SKU code, manufacturer, shipment…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className="filter-btn" onClick={() => setShowFilters((v) => !v)}>
              Filters {filterCount > 0 && <span className="filter-count">{filterCount}</span>}
            </button>
            {showFilters && (
              <div className="filter-panel" style={{ display: "block" }}>
                <div className="f-row">
                  <label>Status</label>
                  <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">All</option>
                    {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="f-actions">
                  <button className="btn-tertiary" onClick={() => setStatus("")}>Clear all</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${records.length} of ${matchedCount} records`}</div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead>
            <tr>
              <th>Shipment Number</th><th>SKU Code</th><th>SKU Version</th>
              <th>Manufacturer</th><th>Status</th><th>Date</th><th></th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr className="empty-row"><td colSpan={7}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              records.map((r) => {
                // Same convention as IPQC/Production: while a record is
                // still Draft/Pending (nothing finished to review yet),
                // tapping the row jumps straight into the fill-in form --
                // the dominant action. Once it's Hold/Approved, tapping
                // opens the read-only view instead; editing from there on
                // only happens via the More menu's Edit action.
                const rowMode: "view" | "edit" = canView(r.status) || !perms?.can_fill_section ? "view" : "edit";
                return (
                  <tr
                    key={r.id}
                    className={r.status === "pending" ? "row-pending" : ""}
                    style={{ cursor: "pointer" }}
                    onClick={() => openDetail(r.id, rowMode)}
                  >
                    <td className="mono">{r.shipment_number || "—"}</td>
                    <td className="mono">{r.sku_code || "—"}</td>
                    <td>{r.sku_version || "—"}</td>
                    <td>{r.manufacturer || "—"}</td>
                    <td><span className={`badge ${r.status === "approved" ? "approved" : r.status === "hold" ? "hold" : r.status === "pending" ? "pending" : "draft"}`}>{r.status.charAt(0).toUpperCase() + r.status.slice(1)}</span></td>
                    <td>{r.date ? r.date.slice(0, 10) : "—"}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <MoreMenu
                        canEdit={!!perms?.can_fill_section}
                        onEdit={() => openDetail(r.id, "edit")}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <Pagination page={page} pageSize={50} matchedCount={matchedCount} onPageChange={setPage} loading={loading} />
      </div>

      {openRecord && (
        <RqcDetailPanel
          record={openRecord}
          onClose={() => setOpenRecord(null)}
          canEdit={!!perms?.can_fill_section}
          onSaved={refreshAfterMutation}
          mode={panelMode}
          onEdit={() => setPanelMode("edit")}
        />
      )}

      {showNewPanel && (
        <NewRqcPanel
          onClose={() => setShowNewPanel(false)}
          onCreated={(id) => {
            setShowNewPanel(false);
            refreshAfterMutation();
            openDetail(id, "edit");
          }}
        />
      )}

      {perms && !perms.can_view && (
        <div className="hint-text" style={{ marginTop: 12 }}>You don&apos;t have permission to view RQC records.</div>
      )}
    </>
  );
}
