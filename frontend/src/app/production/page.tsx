"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import type { ProductionListItem, ProductionDetail, Machine } from "@/lib/types";
import ProductionDetailPanel from "@/components/production/ProductionDetailPanel";

const SHIFTS = ["Shift A", "Shift B", "Shift C"];

export default function ProductionPage() {
  return (
    <Suspense fallback={null}>
      <ProductionPageContent />
    </Suspense>
  );
}

function ProductionPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();
  const perms = me?.permissions.production;

  const [records, setRecords] = useState<ProductionListItem[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const [shift, setShift] = useState("");
  const [machine, setMachine] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [openRecord, setOpenRecord] = useState<ProductionDetail | null>(null);
  const [panelMode, setPanelMode] = useState<"view" | "edit">("view");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [recs, machineList] = await Promise.all([
        api.listProduction({ search, date, shift, machine }),
        api.machines(),
      ]);
      setRecords(recs);
      setMachines(machineList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    } finally {
      setLoading(false);
    }
  }, [search, date, shift, machine]);

  useEffect(() => {
    const t = setTimeout(refresh, 250);
    return () => clearTimeout(t);
  }, [refresh]);

  async function openDetail(id: string, mode: "view" | "edit") {
    try {
      const rec = await api.getProduction(id);
      setOpenRecord(rec);
      setPanelMode(mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load record");
    }
  }

  // Deep-link support, same convention as every other module's detail panel
  // -- lands on View, since a link followed from elsewhere is for context,
  // not to jump straight into filling in rejections/wastage.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (openId) {
      openDetail(openId, "view");
      router.replace("/production");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const filterCount = (date ? 1 : 0) + (shift ? 1 : 0) + (machine ? 1 : 0);

  return (
    <>
      <div className="page-head2">
        <div>
          <h1>Production</h1>
          <div className="desc">Every production record created to date.</div>
        </div>
        <span className="auto-note">Records are created automatically from Material Consumption.</span>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search machine, SKU, operator…" value={search} onChange={(e) => setSearch(e.target.value)} />
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
                  <label>Machine</label>
                  <select value={machine} onChange={(e) => setMachine(e.target.value)}>
                    <option value="">All</option>
                    {machines.map((m) => <option key={m.id} value={m.code}>{m.code}</option>)}
                  </select>
                </div>
                <div className="f-actions">
                  <button className="btn-tertiary" onClick={() => { setDate(""); setShift(""); setMachine(""); }}>Clear all</button>
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
              <th>Production Run ID</th><th>Shipment Number</th><th>Machines</th><th>Shift</th>
              <th>SKU</th><th>Total PCS/Pallet</th><th>Rejections</th><th>Operator</th><th>Date</th><th></th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 ? (
              <tr className="empty-row"><td colSpan={10}>{loading ? "Loading…" : "No records match your search/filters."}</td></tr>
            ) : (
              records.map((r) => (
                <tr key={r.id} className={r.status === "pending" ? "row-pending" : ""}>
                  <td className="mono">{r.run_number}</td>
                  <td className="mono">{r.shipment_number || "—"}</td>
                  <td>{r.machines || "—"}</td>
                  <td>{r.shift || "—"}</td>
                  <td className="mono">{r.sku_code || "—"}</td>
                  <td>{r.total_pcs_per_pallet ?? "—"}</td>
                  <td>{r.total_rejections || "—"}</td>
                  <td>{r.operator || "—"}</td>
                  <td>{r.date || "—"}</td>
                  <td>
                    <span className="icon-actions">
                      <a className="btn-tertiary" style={{ cursor: "pointer", marginRight: 10 }} onClick={() => openDetail(r.id, "view")}>View →</a>
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
        <ProductionDetailPanel
          record={openRecord}
          onClose={() => setOpenRecord(null)}
          canEdit={!!perms?.can_edit}
          machines={machines}
          onSaved={refresh}
          mode={panelMode}
        />
      )}

      {perms && !perms.can_view && (
        <div className="hint-text" style={{ marginTop: 12 }}>You don&apos;t have permission to view Production records.</div>
      )}
    </>
  );
}
