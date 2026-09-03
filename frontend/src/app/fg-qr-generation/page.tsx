"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { QrGenerationDetail, QrGenerationListItem, ProductionRun } from "@/lib/types";
import QrGenerationPanel from "@/components/qr-generation/QrGenerationPanel";
import ConfirmDialog from "@/components/inward-vehicle-inspection/ConfirmDialog";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";

export default function FgQrGenerationPage() {
  return (
    <Suspense fallback={null}>
      <FgQrGenerationPageContent />
    </Suspense>
  );
}

function FgQrGenerationPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const [items, setItems] = useState<QrGenerationListItem[]>([]);
  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [detail, setDetail] = useState<QrGenerationDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QrGenerationListItem | null>(null);
  const [deleteBlockedMsg, setDeleteBlockedMsg] = useState<string | null>(null);

  const perms = me?.permissions.fg_qr_generation;
  // Prototype semantics: prodPropagateToFgQr fires once a Production
  // record's status becomes 'saved' (prodSaveRecord) -- 'approved' is kept
  // too for backward compatibility with existing dev/test data created
  // before the editable-Production feature existed.
  const eligibleRuns = runs.filter((r) => (r.status === "saved" || r.status === "approved") && !r.has_fg_qr);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [qrRes, runsRes] = await Promise.all([api.listFgQr({ search }), api.listProductionRuns()]);
      setItems(qrRes.items);
      setRuns(runsRes);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  async function openRecord(id: string) {
    try {
      const d = await api.getFgQr(id);
      setDetail(d);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  // Deep-link support: Production's detail panel links to a linked FG QR
  // batch as /fg-qr-generation?open=<id>.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (openId) {
      openRecord(openId);
      router.replace("/fg-qr-generation");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function handleCreateFromRun(runId: string) {
    try {
      const d = await api.createFgQrFromRun(runId);
      setDetail(d);
      refresh();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to create FG QR record");
    }
  }

  async function handleGenerate() {
    if (!detail) return;
    const updated = await api.generateFgQr(detail.id);
    setDetail(updated);
    refresh();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await api.deleteFgQr(deleteTarget.id);
      setDeleteTarget(null);
      refresh();
    } catch (e) {
      setDeleteBlockedMsg(e instanceof Error ? e.message : "Failed to delete record");
    }
  }

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>FG QR Generation</h1>
          <div className="desc">Every FG QR generation record created to date. Records auto-appear here once an approved Production Run feeds them — the same fundamental design as RM QR Generation.</div>
        </div>
        <span className="auto-note">Records are created automatically from an approved Production Run.</span>
      </div>

      {eligibleRuns.length > 0 && perms?.can_create && (
        <div className="card" style={{ marginBottom: 18, padding: "14px 20px" }}>
          <div className="section-label" style={{ marginTop: 0 }}>Approved Production Runs awaiting FG QR Generation</div>
          {eligibleRuns.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--rule)" }}>
              <div className="mono" style={{ fontSize: 13 }}>{r.run_number} · {r.sku_code} / {r.sku_version} · {r.total_fg_pallets} pallets · {r.shipment_number || "—"}</div>
              <button className="btn btn-primary" onClick={() => handleCreateFromRun(r.id)}>Open FG QR Generation →</button>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search shipment no., SKU…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${items.length} record${items.length === 1 ? "" : "s"}`}</div>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead><tr><th>Shipment Number</th><th>SKU Name</th><th>SKU Version</th><th>Quantity</th><th>Status</th><th>Date</th><th></th><th></th></tr></thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={8}>{loading ? "Loading…" : "No records match your search."}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} className={r.status === "pending" ? "row-pending" : ""}>
                  <td className="mono">{r.shipment_number}</td>
                  <td className="mono">{r.sku_code_snapshot}</td>
                  <td>{r.sku_version_snapshot}</td>
                  <td>{r.quantity}</td>
                  <td><span className={`badge ${r.status === "generated" ? "generated" : "pending"}`}>{r.status}</span></td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td>
                    <a className="btn-tertiary" style={{ cursor: "pointer" }} onClick={() => openRecord(r.id)}>
                      {r.status === "generated" ? "View →" : "Generate QR →"}
                    </a>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu canDelete={!!perms?.can_delete} onDelete={() => setDeleteTarget(r)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {detail && (
        <QrGenerationPanel
          title="FG QR Generation"
          detail={detail}
          canGenerate={!!perms?.can_edit}
          onGenerate={handleGenerate}
          onClose={() => setDetail(null)}
        />
      )}

      {deleteTarget && !deleteBlockedMsg && (
        <ConfirmDialog
          title="Delete this FG QR record?"
          message={`This will permanently delete the FG QR Generation record for shipment "${deleteTarget.shipment_number}". This cannot be undone.`}
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
