"use client";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useMe } from "@/lib/useMe";
import { useImmediateThenDebounced } from "@/lib/useImmediateThenDebounced";
import type { BurstTest, IpqcTestKind, IpqcTestListItem, PinholeTest } from "@/lib/types";
import Pagination from "@/components/Pagination";
import MoreMenu from "@/components/inward-vehicle-inspection/MoreMenu";
import BurstTestPanel from "./tests/BurstTestPanel";
import PinholeTestPanel from "./tests/PinholeTestPanel";
import NewTestPanel from "./tests/NewTestPanel";
import { TestStatusBadge, formatDateTime } from "./tests/shared";

const LM_CODES = ["LM1", "LM2", "LM3", "LM4", "LM5 FILM", "LM6 SALM", "LM7 SALM"];

/**
 * Falcon IPQC -> Burst Tests / Pinhole Tests: list + side panel, the same shape
 * as Outward Vehicle Inspection. Draft rows open straight into the fill-in
 * form; Passed / Failed rows open read-only with an Edit action.
 */
export default function IpqcTestsTab({ kind, runFilterId, onClearRunFilter }: { kind: IpqcTestKind; runFilterId?: string; onClearRunFilter?: () => void }) {
  const me = useMe();
  const perms = me?.permissions.ipqc;
  const label = kind === "burst" ? "Burst Test" : "Pinhole Test";

  const [items, setItems] = useState<IpqcTestListItem[]>([]);
  const [matched, setMatched] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [machine, setMachine] = useState("");
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);
  const [open, setOpen] = useState<{ record: BurstTest | PinholeTest; mode: "view" | "edit" } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listIpqcTests(kind, { search, status, machine, production_run_id: runFilterId, page });
      setItems(res.items);
      setMatched(res.matched_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tests");
    } finally {
      setLoading(false);
    }
  }, [kind, search, status, machine, runFilterId, page]);

  useImmediateThenDebounced(refresh, [refresh]);

  async function openRow(row: IpqcTestListItem, mode?: "view" | "edit") {
    try {
      const record = kind === "burst" ? await api.getBurstTest(row.id) : await api.getPinholeTest(row.id);
      setOpen({ record, mode: mode ?? (record.status === "draft" && perms?.can_fill_section ? "edit" : "view") });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load test");
    }
  }

  async function handleDelete(row: IpqcTestListItem) {
    if (!window.confirm(`Delete ${label} #${row.test_number} for ${row.run_number}? Its readings and attachments are removed too.`)) return;
    try {
      await api.deleteIpqcTest(kind, row.id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  const common = { onClose: () => setOpen(null), canFill: !!perms?.can_fill_section, onSaved: refresh };

  return (
    <>
      <div className="page-head2" style={{ marginTop: 0 }}>
        <div>
          <div className="desc">
            {kind === "burst"
              ? "Container-wise burst test readings per Production Run and lamination machine."
              : "Pinhole test readings per Production Run and lamination machine."}
          </div>
          <span className="auto-note">Each test is linked to a Production Run — SKU, version, machine and shift come from the run. Start a new test for every container / check.</span>
        </div>
        <button
          className="btn btn-primary"
          disabled={!perms || !perms.can_fill_section}
          title={perms && !perms.can_fill_section ? `You don't have permission to record ${label.toLowerCase()}s.` : ""}
          onClick={() => setShowNew(true)}
        >
          + New {label}
        </button>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            <input type="text" placeholder="Search run, SKU, container…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select value={machine} onChange={(e) => { setMachine(e.target.value); setPage(1); }} aria-label="Machine">
            <option value="">All machines</option>
            {LM_CODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
          </select>
          {runFilterId && <button className="btn-tertiary" onClick={onClearRunFilter}>Showing one Production Run — show all</button>}
        </div>
        <div className="showing-count">{loading ? "Loading…" : `Showing ${items.length} of ${matched} tests`}</div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card card-flush">
        <table className="data">
          <thead>
            <tr>
              <th>Production Run</th><th>Test</th><th>Machine</th><th>SKU / Version</th><th>Shift</th>
              <th>Container</th><th>Readings</th><th>Files</th><th>Status</th><th>Tested At</th><th>Recorded By</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="empty-row"><td colSpan={12}>{loading ? "Loading…" : `No ${label.toLowerCase()}s match your search/filters.`}</td></tr>
            ) : (
              items.map((r) => (
                <tr key={r.id} className={r.status === "draft" ? "row-pending" : ""} style={{ cursor: "pointer" }} onClick={() => openRow(r)}>
                  <td className="mono">{r.run_number || "—"}</td>
                  <td>#{r.test_number}</td>
                  <td className="mono">{r.machine_code}</td>
                  <td className="mono">{[r.sku_code, r.sku_version].filter(Boolean).join(" ") || "—"}</td>
                  <td>{r.shift || "—"}</td>
                  <td className="mono">{r.container_number || "—"}</td>
                  <td>{r.reading_count}</td>
                  <td>{r.attachment_count}</td>
                  <td><TestStatusBadge status={r.status} /></td>
                  <td>{formatDateTime(r.tested_at)}</td>
                  <td>{r.recorded_by_name || "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <MoreMenu
                      canEdit={!!perms?.can_fill_section}
                      onEdit={() => openRow(r, "edit")}
                      canDelete={!!perms?.can_delete}
                      onDelete={() => handleDelete(r)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Pagination page={page} pageSize={50} matchedCount={matched} onPageChange={setPage} loading={loading} />
      </div>

      {perms && !perms.can_view && <div className="hint-text" style={{ marginTop: 12 }}>You don&apos;t have permission to view IPQC records.</div>}

      {showNew && (
        <NewTestPanel
          kind={kind}
          initialRunId={runFilterId}
          onClose={() => setShowNew(false)}
          onCreated={(record) => {
            setShowNew(false);
            refresh();
            setOpen({ record, mode: "edit" });
          }}
        />
      )}

      {open && kind === "burst" && (
        <BurstTestPanel key={open.record.id} {...common} record={open.record as BurstTest} mode={open.mode} onEdit={() => setOpen({ ...open, mode: "edit" })} />
      )}
      {open && kind === "pinhole" && (
        <PinholeTestPanel key={open.record.id} {...common} record={open.record as PinholeTest} mode={open.mode} onEdit={() => setOpen({ ...open, mode: "edit" })} />
      )}
    </>
  );
}
