# Factory OS — Change Summary (2026-09-03)

## 0. Round 2: fixed a real permissions bug + standardized row navigation across every module

Prompted by your screenshots. Two separate fixes:

**Root-cause bug — Pending IPQC (and Production) opening read-only instead of the fill-in form.**
No migration had ever seeded `module_permissions` rows for the `production` or `ipqc`
modules (every other module gets seeded when it's introduced — these two were missed).
With no row, every user — including the admin — silently fell back to view-only, which is
exactly the symptom in your screenshot. Fixed with a new migration
(`backend/migrations/0017_production_ipqc_permissions.sql`) that seeds those rows, and
switched `save_production_run` / `save_ipqc_record` to gate on `can_fill_section` instead
of `can_edit` — matching how Inward QC / Inward Vehicle Inspection already gate their
staff-facing "fill in this record" action, instead of being the one inconsistent pair of
modules. The migration uses `ON CONFLICT ... DO UPDATE` (not `DO NOTHING`) so it also
repairs any stray rows that may already exist for these modules in your Supabase
instance, rather than silently skipping them.

**UI consistency — one navigation pattern everywhere.** Per your note ("no view button",
Image 2's Edit/Delete pattern, and the goal of one consistent system), every module list
page now matches Inward QC's existing convention: tapping anywhere on a row opens that
record's detail (the fill-in form while it's actionable, a read-only view once it's
finalized/resolved), and a "⋯" menu (the same `MoreMenu` component Inward QC already
uses) is the one place Edit and Delete live. No more separate "View →" links, no pencil
icons, no per-page variation.
- **Production, IPQC**: row → detail (edit while Pending/Draft, view once Saved/
  Approved); `MoreMenu` now offers Edit (routes into the same panel's edit mode); the
  detail panel itself also grew a footer Edit button so both entry points agree.
- **Material Consumption**: row → detail; `MoreMenu` now offers Delete with the same
  confirm/blocked-delete dialog Inward QC uses (previously a plain `window.confirm()`).
- **RM/FG QR Generation**: the row itself is now clickable (previously only the "View →
  / Generate QR →" text link was); that link is gone, `MoreMenu` (Delete) unchanged.
- **RM/FG Storage**: removed the redundant "View →" column — the row was already
  clickable; there's no delete action on storage records, so no `MoreMenu` was added
  there.

Scoping note: I left the SKUs / Vendors / Machines admin config pages as they are —
they're inline-editable tables (edit a cell directly, no separate "record detail" to
navigate to), a different interaction model from records like Production or IPQC, so the
row-tap-opens-detail pattern doesn't apply there. Flag it if you'd like those brought in
line too.

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

## Migrations to apply

Two new migrations, run after the existing 0001–0015 in order:
- `backend/migrations/0016_perf_list_indexes.sql` — new indexes, guarded with
  `IF NOT EXISTS`, safe to re-run.
- `backend/migrations/0017_production_ipqc_permissions.sql` — permission seed/repair for
  Production & IPQC, safe to re-run (upserts, never downgrades an existing grant).

## Verification performed

- End-to-end smoke test (draft → shift/machine set → scan pallet → confirmed Production
  Run + IPQC auto-created while still draft → Production saved under the new
  `can_fill_section` gate → confirmed end_time stamped + FG QR batch auto-created with
  the right quantity → Material Consumption finalized) run against a live FastAPI app +
  local Postgres, re-run after the migration 0017 fix to confirm the permission change
  doesn't regress the item 1/2 flow.
- Confirmed migration 0017 actually corrects a pre-existing stray permissions row (not
  just the empty-table case) by deliberately reproducing that condition locally and
  re-running the migration.
- `python3 -m py_compile` clean on every touched backend file.
- `npx tsc --noEmit` clean (0 errors) on the frontend.
- Performance findings re-measured against the same seeded dataset used for the audit
  (see `PERF_AUDIT_RESULTS.md` for the full before/after).
