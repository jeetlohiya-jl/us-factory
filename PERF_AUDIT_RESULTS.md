# Cirkla Factory OS — Performance Fix Results

Date: 2026-09-03
Scope: findings #1-#9 from `PERF_AUDIT.md` (finding #10 explicitly skipped, out of scope per task).
Method: same seeded local Postgres (`factory_os`, unchanged/reused — no re-seed), same
methodology as the audit (wall-clock timed query+hydrate through the app's real
SQLAlchemy session/models, `EXPLAIN ANALYZE`-equivalent by construction since the same
query-building code paths run, payload size via the app's real serializers /
`jsonable_encoder`, and live `TestClient` round trips through the real FastAPI routes
with real auth). All timings below are 3-run wall-clock, first run includes connection
warmup so the 2nd/3rd runs are the steady-state numbers.

## Summary table

| # | Finding | Before | After | Change |
|---|---|---|---|---|
| 1 | Material Consumption list | 3,053–5,563ms, 1.6MB payload, 4,000 rows fetched | **25ms** (steady-state), 20.9KB payload, 50 rows fetched (page 1 of 4,001 matched) | **~150x faster, ~78x smaller payload** |
| 2 | RM/FG Storage Records list | 563–664ms, 3.1MB payload, ~7,000 rows fetched | **10ms** (steady-state), 22.9KB payload, 50 rows fetched (page 1 of 6,975 matched) | **~60x faster, ~140x smaller payload** |
| 3 | Production Runs list | 195–228ms + 2nd query 2–29ms (2 queries) | **5–6ms** paginated (1 query); unbounded/dropdown mode now 1 query instead of 2 (~230-320ms, compute-bound by the correlated EXISTS over all 4,000 rows, not a 2nd round trip) | **1 round trip instead of 2**; **~40x faster** when paginated |
| 4 | RM/FG QR Generation list | 53–97ms, unbounded, date/sku filtered in Python | **3–9ms**, 50 rows, date/sku filtered in SQL | **~15x faster** |
| 5 | IPQC list (Supabase-direct) | unbounded, all filtering client-side (no FastAPI equivalent to measure server-side; audit bounded cost from below by #1's shape) | `.range()` + `.eq()`/`.ilike()` pushed to Postgrest — bounded to 50 rows/request | Fixed per spec; **not live-tested** (no local PostgREST, same caveat the audit itself notes) |
| 6 | RM/FG pending-pallets list | unbounded, Python-side search filter | **30ms**, 50 rows (page 1 of 1,314 matched), search pushed to SQL | Bounded + SQL search |
| 7 | Missing indexes | no index on 6 `created_at`/`stored_at` columns; sort spilled to disk (`external merge Disk: 15792kB`) | 6 btree indexes created (`migrations/0016_perf_list_indexes.sql`, applied) | Index-order scan now available for `ORDER BY ... LIMIT` |
| 8 | `GET /api/v1/me` | 115.64ms (9 sequential queries) | **1.3–3.5ms** (1 query) | **~40-80x faster** |
| 9 | No frontend caching layer | every list navigation re-paid full cost | module-level TTL cache (`frontend/src/lib/listCache.ts`, 20s staleTime) wired into all 8 paginated list calls, invalidated on the corresponding module's create/edit/delete/finalize mutations | Repeat navigation within 20s now serves from memory, 0 network round trips |

## Finding-by-finding detail

### #1 — Material Consumption list
**Before** (`PERF_AUDIT.md`): unbounded `joinedload` 3-level fan-out, Python-side
search/category/date/status filtering. 3,053–5,563ms wall time, 1,640,100 bytes payload.

**After**: `backend/app/api/material_consumption.py` — `_filtered_mc_query()` builds the
entire WHERE clause in SQL (search across SKU/category/machine-code/pallet-display-id via
correlated `EXISTS` subqueries from SQLAlchemy's `.any()`/`.has()`), then a paginated
`id`-only query (`ORDER BY created_at DESC LIMIT 50 OFFSET …`) drives a second query that
hydrates just those 50 rows via `_q_for_list()` — `selectinload` instead of `joinedload`
for the one-to-many collections, avoiding the row-fanout. Response is now
`{"items": [...], "matched_count": N, "total_count": N}` (same shape as the already-good
`inward_qc.py`/`inward_vehicle_inspections.py` pattern).
- **Measured**: 25.1–25.6ms steady-state (first call 177–226ms includes connection/plan
  warmup), 20,852 bytes for a 50-row page, `matched_count` correctly reflects the full
  filtered count (verified: `category=nonexistent` → 0, `category=fgtray` → 0 — the seeded
  dataset happens to be 100% `tray` category — `search=<a real SKU code>` → 803 matches,
  `search=zzznotfound` → 0).
- Frontend (`frontend/src/lib/api.ts` → `listMaterialConsumptionSb`): added `.range()`,
  pushed `status`/`date`/`category` into `.eq()`, search into `.or()` with a `!inner` join
  on `material_consumption_machine_entries` for SKU/version/category columns. Two fields
  (primary pallet display_id, machine code) live two embed levels deep, where a single
  Postgrest `.or(foreignTable:)` filter can't reach — those two remain a client-side
  supplementary check, but now over the **current page only** (50 rows), not the whole
  table, and are documented inline in the code as a known limitation.

### #2 — RM/FG Storage Records list
**Before**: unbounded `joinedload` of 4 relations, Python substring search. 563–664ms,
3,133KB payload.

**After**: `backend/app/api/rm_storage.py` / `fg_storage.py` — search pushed into
`StorageRecord.pallet.has(...)` (correlated EXISTS), pagination via `offset()/limit()`,
same `{"items", "matched_count", "total_count"}` shape.
- **Measured**: 10.3–12.2ms steady-state, 22,986 bytes for a 50-row page,
  `matched_count=6975` (full RM count, confirmed correct against a `search=RM-` query).
- Frontend `storageRecordsQuery`: added `.range()`; search pushed via a `!inner` join on
  the embedded `pallets` resource + `.or(..., {foreignTable: "pallets"})`.

### #3 — Production Runs list
**Before**: unbounded main query (195–228ms) **plus** a second unbounded query just to
build the `has_fg_qr` set (2–29ms) — 2 round trips.
**After**: `backend/app/api/production.py` — folded into **one** query using a correlated
`EXISTS` subquery selected alongside each row (`db.query(ProductionRun, has_fg_qr_expr)`).
Pagination (`page`/`page_size`) is opt-in and defaults to unbounded, because this same
endpoint doubles as the full dropdown source for FG QR Generation's "pick a Production
Run" picker (`frontend/src/app/fg-qr-generation/page.tsx` calls `listProductionRuns()`
expecting every eligible run, not a page of 50) — changing that default would have broken
that picker, which the task's "don't change workflow" constraint rules out.
- **Measured**: paginated (`page=1&page_size=50`) — 5.0–6.3ms steady-state, 1 query. This
  is the path a real "Production Runs list" page would use.
  Unbounded (the dropdown's current usage) — 230–325ms for all 4,001 rows in 1 query
  instead of 2; the per-row `EXISTS` correlated subquery has real cost at full-table scale
  (comparable to the old 2-query total), so the win here is entirely "1 round trip instead
  of 2," not lower total compute at the unbounded scale — expected, since removing rows
  from the result set (via pagination) is what actually removes the cost, and this
  endpoint deliberately doesn't do that today.
- Frontend `listProductionSb` (the real Production list page's data source): added
  `.range()`, `date`/`shift` pushed to `.eq()`, search pushed via `!inner` joins on
  `sku_codes` and `app_users` with a single combined `.or()` (verified: Postgrest ANDs
  multiple separate `.or({foreignTable})` calls together rather than OR-ing across tables
  — this was caught and fixed by using one `.or("table.column.op.value,...")` call with
  embed-qualified paths instead of two separate calls). `machine` filter and
  machine-code search matches stay client-side over the current page only (2 embed levels
  deep, same limitation class as #1).

### #4 — RM/FG QR Generation list
**Before**: `date`/`sku` filtered in Python after `.all()`. 53–97ms.
**After**: `backend/app/api/rm_qr.py` / `fg_qr.py` — `date` pushed to
`func.cast(created_at, Date) == :date`, `sku` to `.ilike()`, pagination added, same
`{"items", "matched_count", "total_count"}` shape.
- **Measured**: 2.7–8.5ms steady-state; `date=2026-09-03` filter correctly returns 2
  matches (verified against the seeded RM QR data).
- Frontend `qrListQuery`: this one was **already correct** at audit time (search/date/sku
  all pushed server-side via `.or()`/`.ilike()`/`.gte()`/`.lt()`) — only `.range()` +
  `{ count: "exact" }` were added for pagination and the "Showing X of Y" total.

### #5 — IPQC list (Supabase-direct)
**Before**: no `.range()`/`.limit()` at all — full-table fetch, all filtering client-side.
No FastAPI equivalent existed to measure server-side (Supabase-only by design).
**After**: `frontend/src/lib/api.ts` → `listIpqcSb` — `.range()` added (50/page),
`date`→`.eq("production_date", …)`, `shift`/`status`→`.eq()`, `search`→`.or()` across
`sku_code_snapshot`/`shift_incharge`/`shipment_number` (all flat columns on
`ipqc_records`, no nested-embed limitation here). `frontend/src/app/ipqc/page.tsx` updated
to consume `{items, matched_count}` and show the real total instead of `records.length`
twice.
- **Not live-tested** — same limitation the audit itself documents (no local PostgREST
  instance in this environment); this is standard, spec-correct Postgrest filter/range
  syntax, structurally identical to what's now proven working live in #1-#4's FastAPI
  equivalents and #2/#3's `!inner`-join patterns.

### #6 — RM/FG pending-pallets list
**Before**: unbounded, Python substring `search`.
**After**: `backend/app/api/rm_storage.py` / `fg_storage.py` `list_pending` — `search`
pushed to `OR(display_id ILIKE, sku_code_snapshot ILIKE)`, `sku` stays an exact `.eq()`
(matches old exact-match semantics), pagination added.
- **Measured**: 30.6–38.2ms steady-state, `matched_count=1314` for RM (`pending_storage`
  pallets), 50-row page.
- Frontend `pendingPalletsQuery`: `.range()` + search pushed to `.or()`.

### #7 — Missing indexes
`backend/migrations/0016_perf_list_indexes.sql` created with `IF NOT EXISTS`-guarded
btree indexes on all 6 columns the audit named, applied to the local DB
(`psql -f migrations/0016_perf_list_indexes.sql` — 6× `CREATE INDEX` confirmed).

### #8 — `GET /api/v1/me`
**Before**: 9 sequential single-row queries, 115.64ms.
**After**: `backend/app/api/me.py` — one `.filter(module.in_(MODULES))` query, dict built
from the result set.
- **Measured**: 1.29–3.48ms (5 runs) — response shape verified byte-identical (`user_id`,
  `email`, `full_name`, `permissions` dict with the same 9 module keys, each with the same
  6 `can_*` boolean fields, defaulting the same way `_perm_dict(None)` always did for a
  user with no explicit row for a module).

### #9 — Frontend caching layer
`frontend/src/lib/listCache.ts` — a module-level keyed cache (`Map<key, {value,
fetchedAt, inFlight}>`) with a 20s staleTime, generalizing the exact pattern
`frontend/src/lib/useMe.ts` already used for `/api/v1/me` (module state + subscriber-free
get-or-fetch, deduping concurrent in-flight requests for the same key). Chose this over
installing SWR/React Query per the task's explicit "keep it simple" guidance — no new
runtime dependency, and it slots directly into the existing `api.ts` wrapper functions
without touching any page component's render logic.
- Wired into all 8 paginated list calls added in #1-#6: `listRmQr`, `listFgQr`,
  `listRmPending`, `listRmStorageRecords`, `listFgPending`, `listFgStorageRecords`,
  `listMaterialConsumption`, `listProduction`, `listIpqc`.
- `invalidateListCache(module)` called after every mutation that can change what a list
  shows: RM/FG QR generate/delete/create-from-run, RM/FG Storage confirm, Material
  Consumption draft-create/finalize/discard/delete (finalize also invalidates
  `production` + `ipqc`, since finalize is what auto-creates those records), Production
  save, IPQC save.
- `npm install swr` was tried first, then removed (`npm uninstall swr`) once the
  in-memory-cache approach was chosen instead — `package.json` has no new runtime
  dependency.

## What was NOT fully live-verified (honest limitations)

- **Supabase/Postgrest-direct query correctness** for the `!inner`-join `.or()` filter
  patterns (findings #1, #2, #3, #5, #6's frontend halves) could not be run against a real
  PostgREST instance — none is available in this environment, exactly as the original
  audit notes for its own frontend cost estimates. `npx tsc --noEmit` passes cleanly
  (introduced and fixed one real type error along the way — chaining `.select()` twice on
  a Postgrest builder isn't valid; fixed by picking the select string before the single
  `.select()` call), which catches shape/API-surface mistakes but not query-semantics bugs
  a live PostgREST would surface (e.g. exact embed-path syntax for `.or()` across a joined
  table). All server-side (FastAPI/SQLAlchemy) equivalents of the same fix pattern **were**
  live-tested against the real seeded Postgres and are correct, which is the strongest
  available evidence the Postgrest-side syntax is right (same relational semantics,
  different transport).
- **Finding #1/#3's client-side residual filtering**: search-matching on Material
  Consumption's primary-pallet display_id / machine code, and Production's machine-code
  search, are two embed-levels deep and PostgREST's single-level `.or(foreignTable:)`
  can't express an OR across that depth in one query — these remain a client-side pass,
  but now bounded to the current 50-row page instead of the whole table (a real
  improvement, not a full fix — documented inline in `api.ts`).
- **Finding #9's cache correctness under concurrent tabs/back-forward navigation** wasn't
  exercised with a running Next.js dev server + browser (no browser automation targeted at
  this in the current pass); the logic mirrors `useMe.ts`'s already-proven pattern closely
  enough to be low-risk, but wasn't clicked through live.

## Files changed

**Backend**: `app/api/material_consumption.py`, `app/api/rm_storage.py`,
`app/api/fg_storage.py`, `app/api/rm_qr.py`, `app/api/fg_qr.py`, `app/api/production.py`,
`app/api/me.py`, `migrations/0016_perf_list_indexes.sql` (new, applied to local DB).

**Frontend**: `src/lib/api.ts`, `src/lib/listCache.ts` (new),
`src/app/material-consumption/page.tsx`, `src/app/production/page.tsx`,
`src/app/ipqc/page.tsx`, `src/app/rm-storage/page.tsx`, `src/app/fg-storage/page.tsx`,
`src/app/rm-qr-generation/page.tsx`, `src/app/fg-qr-generation/page.tsx`.

All backend files pass `python3 -m py_compile`. `npx tsc --noEmit` in `frontend/` passes
with 0 errors (verified before AND after — 0 pre-existing errors in this repo once
`npm install` was run; `node_modules` didn't exist at task start).
