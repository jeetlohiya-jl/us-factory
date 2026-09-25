"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { cachedList, invalidateListCache, listCacheKey } from "@/lib/listCache";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { RqcListItem, RqcDetail, QrGenerationDetail } from "@/lib/types";
import FactoryRqcWizard from "@/components/rqc/FactoryRqcWizard";
import FactoryRqcDetailPanel from "@/components/rqc/FactoryRqcDetailPanel";
import FactoryCoaEntryPanel from "@/components/rqc/FactoryCoaEntryPanel";
import QrGenerationPanel from "@/components/qr-generation/QrGenerationPanel";
import Pagination from "@/components/Pagination";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import { MODULE_NAMES, T, statusLabel } from "@/lib/terms";

const MODULE = "rqc";

/**
 * Factory OS Module 4 -- RQC + FG QR Generation, combined into ONE page (per
 * the explicit "not two separate pages" requirement), backed by the exact
 * same rqc_records / qr_generation_records tables and FastAPI routes as US
 * Factory's own separate /rqc and /fg-qr-generation pages -- only the
 * QMP05-specific defect list, Sampling Plan reference, and Factory COA
 * labels are new (see FactoryRqcWizard/FactoryRqcDetailPanel/
 * FactoryCoaEntryPanel). RQC records here are created manually only ("+ New
 * Record") -- never auto-created from Material Consumption -- and a single
 * Shipment Number can have many activity records over time, each separately
 * traceable by its own Date/Machine/Shift/Approved Pallets.
 */
export default function FactoryRqcFgQrPage() {
  return (
    <Suspense fallback={null}>
      <FactoryRqcFgQrPageContent />
    </Suspense>
  );
}

function FactoryRqcFgQrPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const perms = me?.permissions.rqc;
  const fgQrPerms = me?.permissions.fg_qr_generation;

  const [items, setItems] = useState<RqcListItem[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [showWizard, setShowWizard] = useState(false);
  const [detailRecord, setDetailRecord] = useState<RqcDetail | null>(null);
  const [detailMachine, setDetailMachine] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<"view" | "edit">("view");
  const [fgQr, setFgQr] = useState<QrGenerationDetail | null>(null);
  const [showFgQrPanel, setShowFgQrPanel] = useState(false);
  const [coaShipment, setCoaShipment] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RqcListItem | null>(null);
  const [deleteBlockedMsg, setDeleteBlockedMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = listCacheKey(MODULE, { search, page, factory: true });
      const res = await cachedList(key, () => api.listRqc({ search, page }));
      setItems(res.items);
      setMatchedCount(res.matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useImmediateThenDebounced(refresh, [refresh]);
  useEffect(() => setPage(1), [search]);

  const refreshAfterMutation = useCallback(() => {
    invalidateListCache(MODULE);
    refresh();
  }, [refresh]);

  async function openRecord(row: RqcListItem, mode: "view" | "edit" = "view") {
    setError(null);
    try {
      const [rec, batch] = await Promise.all([
        api.getRqc(row.id),
        api.getFgQrForRqcRecord(row.id),
      ]);
      setDetailRecord(rec);
      setDetailMachine(row.machine);
      setDetailMode(mode);
      setFgQr(batch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteRqc(deleteTarget.id);
      setDeleteTarget(null);
      if (detailRecord?.id === deleteTarget.id) {
        setDetailRecord(null);
        setFgQr(null);
        setDetailMachine(null);
        setDetailMode("view");
      }
      refreshAfterMutation();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setDeleteBlockedMsg(e.message);
      } else {
        setDeleteBlockedMsg(e instanceof Error ? e.message : "Failed to delete record");
      }
    }
  }

  // Deep-link support, same convention as every other Factory/US Factory
  // list page (e.g. Production linking back to a Material Consumption
  // record) -- ?open=<rqc_record_id>.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (openId) {
      (async () => {
        try {
          const [rec, batch] = await Promise.all([api.getRqc(openId), api.getFgQrForRqcRecord(openId)]);
          setDetailRecord(rec);
          setDetailMachine(null);
          setFgQr(batch);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to load record");
        }
      })();
      router.replace("/rqc-fg-qr");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function handleGenerateFgQr() {
    if (!fgQr) return;
    const updated = await api.generateFgQr(fgQr.id);
    setFgQr(updated);
    invalidateListCache("fg-qr");
  }

  async function handleWizardSaved(id: string) {
    setShowWizard(false);
    refreshAfterMutation();
    // Immediately reopen the just-saved record so the operator sees its
    // final state (and, if it was Approved, the freshly auto-created FG QR
    // batch) without a second click. Machine code is resolved against the
    // Machines master list rather than production_run_machines, since a
    // standalone (unlinked) RQC record still has a real machine_id but no
    // linked Production Run to look it up through.
    try {
      const [rec, allMachines, batch] = await Promise.all([
        api.getRqc(id), api.machines(), api.getFgQrForRqcRecord(id),
      ]);
      setDetailRecord(rec);
      setDetailMachine(allMachines.find((m) => m.id === rec.machine_id)?.code ?? null);
      setFgQr(batch);
    } catch {
      // Non-fatal -- the list has already refreshed; the record can still
      // be opened from there.
    }
  }

  const filterCount = 0;

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>{MODULE_NAMES.rqc_fg_qr} Generation</h1>
          <div className="desc">Final Quality Control (QMP05) and FG QR Generation for the Factory product -- Production → RQC → Approved Pallets → FG QR.</div>
        </div>
        <button className="btn btn-primary" disabled={!perms?.can_create} onClick={() => setShowWizard(true)}>+ New Record</button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search shipment number, SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${items.length} of ${matchedCount} records`}</div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card card-flush">
        <table className="data compact">
          <thead>
            <tr>
              <th>{T.shipmentNumber}</th><th>{T.sku}</th><th>Date</th><th>Machine</th><th>Shift</th>
              <th>Pallets Tested</th><th>Approved Pallets</th><th>Table/Person</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={10}>{loading ? "Loading…" : "No RQC records yet."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => openRecord(r)}>
                  <td className="mono">{r.shipment_number || "—"}</td>
                  <td className="mono">{r.sku_code || "—"}</td>
                  <td>{r.activity_date || "—"}</td>
                  <td className="mono">{r.machine || "—"}</td>
                  <td>{r.activity_shift || "—"}</td>
                  <td>{r.pallets_tested ?? "—"}</td>
                  <td>{r.fg_pallets_generated ?? "—"}</td>
                  <td>{r.table_person_number || "—"}</td>
                  <td><span className={`badge ${r.status === "approved" ? "approved" : r.status === "hold" ? "hold" : r.status === "pending" ? "pending" : "draft"}`}>{statusLabel(r.status)}</span></td>
                  <td onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
                    {r.shipment_number && (
                      <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => setCoaShipment(r.shipment_number)}>COA</a>
                    )}
                    <MoreMenu
                      canEdit={!!perms?.can_fill_section}
                      canDelete={!!perms?.can_delete}
                      onEdit={() => openRecord(r, "edit")}
                      onDelete={() => setDeleteTarget(r)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination page={page} pageSize={50} matchedCount={matchedCount} onPageChange={setPage} loading={loading} />
      </div>

      {showWizard && (
        <FactoryRqcWizard onClose={() => setShowWizard(false)} onSaved={handleWizardSaved} />
      )}

      {detailRecord && !showFgQrPanel && (
        <FactoryRqcDetailPanel
          record={detailRecord}
          machineCode={detailMachine}
          hasFgQr={!!fgQr}
          mode={detailMode}
          canEdit={!!perms?.can_fill_section}
          canDelete={!!perms?.can_delete}
          onEdit={() => setDetailMode("edit")}
          onDelete={() => {
            const item = items.find((i) => i.id === detailRecord.id);
            setDeleteTarget(item ?? { id: detailRecord.id, shipment_number: detailRecord.shipment_number } as RqcListItem);
          }}
          onSaved={refreshAfterMutation}
          onClose={() => { setDetailRecord(null); setFgQr(null); setDetailMachine(null); setDetailMode("view"); }}
          onViewFgQr={() => setShowFgQrPanel(true)}
          onOpenCoa={() => detailRecord.shipment_number && setCoaShipment(detailRecord.shipment_number)}
        />
      )}

      {showFgQrPanel && fgQr && (
        <QrGenerationPanel
          title="FG QR Generation"
          detail={fgQr}
          canGenerate={!!fgQrPerms?.can_edit}
          onGenerate={handleGenerateFgQr}
          onClose={() => setShowFgQrPanel(false)}
        />
      )}

      {coaShipment && (
        <FactoryCoaEntryPanel
          shipmentNumber={coaShipment}
          canEdit={!!perms?.can_fill_section}
          onClose={() => setCoaShipment(null)}
          onSaved={() => {}}
        />
      )}

      {deleteTarget && !deleteBlockedMsg && (
        <ConfirmDialog
          title="Delete this record?"
          message={`This will permanently delete the RQC record "${deleteTarget.shipment_number || deleteTarget.id.slice(0, 8)}". This cannot be undone.`}
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
