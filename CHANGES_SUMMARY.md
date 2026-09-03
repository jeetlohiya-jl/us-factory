# Factory OS — Change Summary (2026-09-03)

## 1. Material Consumption draft data now visible on Production & IPQC; end time set automatically

- The Production Run + IPQC record for a shift are now find-or-created the moment the
  **first primary pallet is scanned** on a Material Consumption record — while it's
  still a draft — instead of only at Finalize. So a draft's data shows up on the
  Production and IPQC pages right away.
  (`backend/app/domain/material_consumption_service.py: add_primary_pallet`)
- The manual "Record End Time" button is gone. Saving the Production Run (Rejection
  Classification / Wastage / FG Pallets Generated) now stamps `end_time` on every
  Material Consumption machine entry that fed it, using the saving device's own clock.
  Material Consumption's "Finalize Record" stays disabled until Production has been
  saved (that's what sets each machine's end time) — with a hint explaining why.
  (`backend/app/domain/material_consumption_service.py: stamp_end_times_for_production_run`,
  `backend/app/api/production.py`, `frontend/src/components/material-consumption/Wizard.tsx`)

## 2. FG Pallets Generated flows into FG QR Generation → FG Storage

- When Production saves a run with **Total FG Pallets Generated > 0**, an FG QR
  Generation batch is now auto-created (find-or-create, refreshed while still pending —
  same pattern as an Accepted Inward QC auto-populating RM QR Generation). Clicking
  "Generate" there propagates pallets into FG Storage's pending list exactly as RM
  already does. (`backend/app/domain/qr_generation_service.py`,
  `backend/app/api/production.py`)
- Fixed a related gap: the FG QR batch's shipment number is now derived from the
  actual consumed pallet (same derivation the frontend already used for display)
  instead of a column that's never populated on Material-Consumption-spawned runs.

## 3. Row-tap behavior on Production & IPQC

- Tapping a row now opens the fill-in form directly while a record is still
  in-progress (Production: Pending; IPQC: Draft/Pending) — the dominant action.
  Once a record is finalized (Production: Saved; IPQC: Hold/Approved), tapping opens
  the read-only view instead; editing a finalized record is only ever reached through
  the explicit pencil/Edit action. (`frontend/src/app/production/page.tsx`,
  `frontend/src/app/ipqc/page.tsx`)

## 4. Performance

Full before/after detail: `PERF_AUDIT.md` (findings) and `PERF_AUDIT_RESULTS.md` (fixes
+ measurements). No UI, layout, or workflow changes — only how data is fetched.

Highlights, measured against a representative seeded dataset (~4,000 records per major
table, ~119k pallets):

| Area | Before | After |
|---|---|---|
| Material Consumption list | 3–5.5s, 1.6MB payload | ~25ms, ~21KB (paginated, 50/page) |
| RM/FG Storage Records list | 560–660ms, 3.1MB payload | ~10ms, ~23KB |
| Production Runs list (paginated) | 195–228ms + a 2nd query | ~5–6ms, 1 query |
| RM/FG QR Generation list | 53–97ms, unbounded | ~3–9ms, paginated |
| `GET /api/v1/me` | 115.6ms (9 queries) | ~1.3–3.5ms (1 query) |
| Repeat navigation to any list | full cost every time | served from a 20s in-memory cache |

Changes: SQL-level pagination + WHERE-clause filtering on every list endpoint that was
previously unbounded and filtering in Python/JS; `selectinload` instead of `joinedload`
where it was causing row-fanout; a folded `EXISTS` subquery instead of a second
full-table query on Production Runs; a single `IN()` query instead of 9 sequential ones
on `/me`; six new indexes on `created_at`/`stored_at` ordering columns
(`backend/migrations/0016_perf_list_indexes.sql`); a lightweight module-level list
cache on the frontend (`frontend/src/lib/listCache.ts`), invalidated on the relevant
mutations.

**Honest gaps**: the Supabase/PostgREST-direct query paths (used for most list *reads*
per the existing hybrid architecture) could not be live-tested — this sandbox has no
route to a running PostgREST instance, same limitation the underlying architecture docs
already flag. The equivalent FastAPI/SQLAlchemy paths use the same relational logic and
were live-tested against real seeded Postgres. Two search fields (Material
Consumption's pallet ID / machine code, Production's machine-code search) are two
embed-levels deep in the Postgrest schema and couldn't be pushed into a single
server-side filter — they now filter over the current 50-row page instead of the whole
table, a real improvement but not a complete fix; noted inline in `lib/api.ts`.

## Migration to apply

`backend/migrations/0016_perf_list_indexes.sql` is new — run it after the existing
0001–0015 migrations (it's guarded with `IF NOT EXISTS`, safe to re-run).

## Verification performed

- End-to-end smoke test (draft → shift/machine set → scan pallet → confirmed Production
  Run + IPQC auto-created while still draft → Production saved → confirmed end_time
  stamped + FG QR batch auto-created with the right quantity → Material Consumption
  finalized) run against a live FastAPI app + local Postgres.
- `python3 -m py_compile` clean on every touched backend file.
- `npx tsc --noEmit` clean (0 errors) on the frontend.
- Performance findings re-measured against the same seeded dataset used for the audit
  (see `PERF_AUDIT_RESULTS.md` for the full before/after).
