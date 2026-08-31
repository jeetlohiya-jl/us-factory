"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { QcDetail, QcListItem, QcManualCategory, QcMeta, SkuCode } from "@/lib/types";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import CategoryPicker from "@/components/inward-qc/CategoryPicker";
import Wizard from "@/components/inward-qc/Wizard";
import RecordDetail from "@/components/inward-qc/RecordDetail";

const CATEGORY_LABELS: Record<string, string> = {
  fgtray: "FG NonPadded Tray", pad: "Soaker Pad", polybag: "Polybag", cfb: "CFB", glue: "Glue",
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { draft: "Draft", pending: "Pending", accepted: "Approve", onhold: "Hold" };
  return <span className={`badge ${status}`}>{map[status] || status}</span>;
}

export default function InwardQcPage() {
  const me = useMe();
  const [meta, setMeta] = useState<QcMeta | null>(null);
  const [skuCodes, setSkuCodes] = useState<SkuCode[]>([]);
  const [items, setItems] = useState<QcListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fDate, setFDate] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fStatus, setFStatus] = useState("");

  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [wizardState, setWizardState] = useState<{ id: string; detail: QcDetail } | null>(null);
  const [detailState, setDetailState] = useState<QcDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QcListItem | null>(null);
  const [deleteBlockedMsg, setDeleteBlockedMsg] = useState<string | null>(null);

  const perms = me?.permissions.inward_qc;
  const activeFilterCount = (fDate ? 1 : 0) + (fCategory ? 1 : 0) + (fStatus ? 1 : 0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.listQc({ search, status: fStatus, category: fCategory, date: fDate });
      setItems(res.items);
      setMatchedCount(res.matched_count);
      setTotalCount(res.total_count);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, fStatus, fCategory, fDate]);

  useEffect(() => {
    api.qcMeta().then(setMeta).catch(() => setMeta(null));
    api.skuCodes().then(setSkuCodes).catch(() => setSkuCodes([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  async function handleCategoryChosen(category: QcManualCategory) {
    try {
      const detail = await api.createQcDraft(category);
      setShowCategoryPicker(false);
      setWizardState({ id: detail.id, detail });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to create record");
    }
  }

  async function openDetail(id: string) {
    try {
      const detail = await api.getQc(id);
      setDetailState(detail);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  async function openEdit(id: string) {
    try {
      const detail = await api.getQc(id);
      setDetailState(null);
      setWizardState({ id: detail.id, detail });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  function handleRowClick(item: QcListItem) {
    // "The user does NOT click + New Record to create this Tray QC. The user
    // simply opens the existing Pending Tray QC" — a still-Pending Tray QC
    // opens straight into the observation form; anything else opens the
    // read-only Record Details view (with Edit available from there / More menu).
    if (item.category === "fgtray" && item.status === "pending") {
      openEdit(item.id);
    } else {
      openDetail(item.id);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteQc(deleteTarget.id);
      setDeleteTarget(null);
      refresh();
    } catch (e) {
      setDeleteBlockedMsg(e instanceof ApiError ? e.message : (e instanceof Error ? e.message : "Failed to delete record"));
    }
  }

  if (!meta) {
    return <div className="loading-line">Loading…</div>;
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Inward QC</h1>
          <div className="desc">Every Inward QC record created to date, across FG NonPadded Tray, Soaker Pad, Polybag and CFB.</div>
        </div>
        <button
          className="btn btn-primary"
          disabled={!perms || !perms.can_create}
          title={perms && !perms.can_create ? "Only users with Create permission can add new records." : ""}
          onClick={() => setShowCategoryPicker(true)}
        >
          + New Record
        </button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search shipment no…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-pop-wrap">
            <button className={`filter-btn ${activeFilterCount ? "has-active" : ""}`} onClick={() => setFiltersOpen((v) => !v)}>
              Filters {activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
            </button>
            <div className={`filter-panel ${filtersOpen ? "open" : ""}`}>
              <div className="f-row"><label>Date</label><input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} /></div>
              <div className="f-row"><label>Category</label>
                <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
                  <option value="">All</option>
                  <option value="fgtray">FG NonPadded Tray</option>
                  <option value="pad">Soaker Pad</option>
                  <option value="polybag">Polybag</option>
                  <option value="cfb">CFB</option>
                  <option value="glue">Glue</option>
                </select>
              </div>
              <div className="f-row"><label>Status</label>
                <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                  <option value="">All</option>
                  <option value="draft">Draft</option>
                  <option value="accepted">Approve</option>
                  <option value="onhold">Hold</option>
                </select>
              </div>
              <div className="f-actions">
                <button className="btn-tertiary" onClick={() => { setFDate(""); setFCategory(""); setFStatus(""); }}>Clear all</button>
              </div>
            </div>
          </div>
        </div>
        <div className="showing-count">
          {loading ? "Loading…" : `Showing ${matchedCount} of ${totalCount} records`}
        </div>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead>
            <tr><th>Shipment Number</th><th>Category</th><th>COA</th><th>Status</th><th>Date</th><th></th></tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={6}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} className={r.status === "pending" ? "row-pending" : ""} style={{ cursor: "pointer" }} onClick={() => handleRowClick(r)}>
                  <td className="mono">{r.shipment_number}</td>
                  <td>{CATEGORY_LABELS[r.category]}</td>
                  <td>{r.coa_filename || "—"}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu
                      canEdit={!!perms?.can_edit}
                      canDelete={!!perms?.can_delete}
                      onEdit={() => openEdit(r.id)}
                      onDelete={() => setDeleteTarget(r)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showCategoryPicker && (
        <CategoryPicker onNext={handleCategoryChosen} onCancel={() => setShowCategoryPicker(false)} />
      )}

      {wizardState && perms && (
        <Wizard
          qcId={wizardState.id}
          initialDetail={wizardState.detail}
          meta={meta}
          skuCodes={skuCodes}
          permissions={perms}
          onClose={() => { setWizardState(null); refresh(); }}
          onSaved={refresh}
        />
      )}

      {detailState && (
        <RecordDetail
          detail={detailState}
          canEdit={!!perms?.can_edit}
          onClose={() => setDetailState(null)}
          onEdit={() => { const id = detailState.id; setDetailState(null); openEdit(id); }}
        />
      )}

      {deleteTarget && !deleteBlockedMsg && (
        <ConfirmDialog
          title="Delete this record?"
          message={`This will permanently delete the Inward QC record for shipment "${deleteTarget.shipment_number}". This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {deleteBlockedMsg && (
        <ConfirmDialog
          title="Can't delete this record"
          message=""
          blockedNote={deleteBlockedMsg}
          onCancel={() => { setDeleteBlockedMsg(null); setDeleteTarget(null); }}
        />
      )}
    </>
  );
}
