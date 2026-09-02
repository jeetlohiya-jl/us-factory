# Hybrid Architecture Audit — Factory OS

Read-only audit of the current codebase (backend `app/api`, `app/domain`,
`app/adapters`, `app/db/models.py`, all `migrations/*.sql`, and the
frontend's `lib/api.ts` / `lib/useMe.ts`) done before any code changes,
per the request to classify every endpoint before touching Material
Consumption/Production/IPQC.

## 1. The one finding that gates everything else

**Today, authorization is enforced entirely inside FastAPI's Python code,
never by Postgres.** `deps.py`'s `get_current_user` resolves a Supabase JWT
down to a row in `app_users` (matched by **email**, not by Supabase's own
`auth.uid()`), and every route depends on `require_permission("edit")`
etc., which reads `module_permissions.user_id = app_users.id` and checks a
boolean column. Postgres Row-Level Security is **not enabled on a single
table** — `0001_init.sql`'s comment ("RLS policies are included but
permissive-by-default") turns out not to be true of the current schema;
there are zero `ENABLE ROW LEVEL SECURITY` or `CREATE POLICY` statements
anywhere in `migrations/`.

This has been safe so far only because the browser has never talked to
Postgres directly — every request goes through FastAPI, which connects
with a full-privilege app role and does its own checks in Python. The
moment the Next.js frontend starts calling Supabase directly with the
`anon`/`authenticated` key, **RLS is the only thing standing between a
signed-in user and every row in every table**, and there isn't one yet.

There's a second, smaller gap that blocks RLS specifically: `app_users`
has an `auth_user_id` column meant to hold Supabase's `auth.users.id`
(the value RLS's `auth.uid()` returns), but nothing has ever written to
it — `SupabaseAuthAdapter` matches by email only. An RLS policy needs to
join `auth.uid()` back to `app_users.id`/`module_permissions`, so this
column has to actually be populated before any policy can be written
against it.

**Conclusion:** "move reads to Supabase direct" is not just a frontend
change — it requires (a) linking real Supabase user IDs to `app_users`,
and (b) writing and testing real RLS policies, per table, before that
table is safe to expose. That work is Phase 0 below and has to land
before any page starts reading Supabase directly, even for the simplest
tables.

## 2. Endpoint classification

| Module | Endpoint(s) | Classification | Why |
|---|---|---|---|
| Reference data | `GET /sku-codes`, `GET /checklist-items` | **Supabase direct** | Pure lookup tables, no write path, no per-record logic. |
| SKUs (admin) | `GET/POST/PUT/DELETE /skus`, versions sub-routes | **Supabase direct** | Plain CRUD on `sku_codes`/`sku_versions`, no cross-table transaction. |
| Vendors (admin) | `GET/POST/PUT/DELETE /vendors` | **Supabase direct** | Plain single-table CRUD. |
| Machines (admin) | `GET/POST/PUT/DELETE /machines` | **Supabase direct** | Plain single-table CRUD. |
| Locations | `GET /locations` | **Supabase direct** | Plain read. |
| `/me` | `GET /me` | **Needs review** | Currently a thin join of `app_users` + all `module_permissions` rows. Becomes a Supabase direct read once the `auth_user_id` bridge (Phase 0) exists; until then it must stay server-side, since it's the one place that already does the email→app_users lookup correctly. |
| Inward Vehicle Inspection | `GET` list/detail | **Supabase direct** (after RLS) | Read-only, no recomputation on read. |
| | `POST draft`, `PUT basic`, `PUT checklist`, `DELETE if-blank/delete` | **Needs review** | Individually simple writes, but `draft` assigns shipment numbers via a sequence helper with a known race condition (see §4) — don't multiply the number of write paths hitting that function until it's fixed. |
| | `POST images` (OCR identifier extraction), `PUT/DELETE images` | **FastAPI required** | Runs Tesseract synchronously against the uploaded image. |
| | `POST submit` | **FastAPI required** | Validates line items/checklist/images together and flips status atomically. |
| Inward QC | `GET meta` | **Supabase direct** | Static reference (sampling plan tiers, attribute defs). |
| | `GET` list/detail | **Supabase direct** (after RLS) | Read-only. |
| | `POST draft`, `PUT` (basic/fgtray-answers/attributes) | **FastAPI required** | Every write re-runs `qcRecalcStatus`/sampling-plan business rules faithfully ported from the prototype — this is exactly the "business-rule-heavy" case the task calls out to keep server-side. |
| | `POST coa`, `DELETE coa` | **FastAPI required** | pdfplumber/OCR document parsing. |
| | `POST submit`, `DELETE if-blank/delete` | **FastAPI required** | Multi-table atomic finalize; feeds RM QR Generation downstream. |
| RM/FG QR Generation | `GET` list/detail | **Supabase direct** (after RLS) | Read-only. |
| | `POST generate`, `POST from-production-run` | **FastAPI required** | One QR batch → N pallet rows + a rendered QR PNG per pallet uploaded to storage, using the same sequence-numbering helper flagged in §4. |
| | `DELETE` | **Needs review** | Has to check no pallets/downstream records depend on the batch first — safe as a Postgres RPC function under RLS, or keep in FastAPI; low priority either way. |
| RM/FG Storage | `GET pending/records/detail` | **Supabase direct** (after RLS) | Read-only. |
| | `POST scan-pallet`, `POST scan-location` | **Needs review** | These only *resolve/validate* a scan today — no row is written until `confirm`. Could become a Postgres RPC (`security definer` function) callable directly from the browser once RLS is in place, since it's read + validation, not a real write. Recommend leaving in FastAPI for this pass and revisiting once Phase 0/1 are stable. |
| | `POST confirm` | **FastAPI required** | One atomic transaction: pallet lifecycle update + location assignment + `storage_records` row + `pallet_lifecycle_events` row. |
| Material Consumption | `GET shifts`, `GET` list/detail | **Needs review** | Reads only, but the list endpoint aggregates across `machine_entries` in Python (`serialize_mc_list_item`); moving it means either a Postgres view or replicating that aggregation as a `select` with joins client-side. Worth doing, but after Phase 1. |
| | `POST draft`, machine-entry CRUD, `PUT basic` | **FastAPI required** | State-machine-like draft editing with SKU-locking rules per machine entry. |
| | `scan-pallet`, `scan-secondary`, `end-time`, pallet remove/quantity, `finalize` | **FastAPI required** | Exactly the "must remain transactional" case in the task: pallet lifecycle + `pallet_lifecycle_events` + Production Run/IPQC find-or-create, all inside one commit. |
| Production | `GET` list | **Supabase direct** (after RLS) | Read-only. |
| | `POST` create | **FastAPI required** (stub) | Explicitly a placeholder ("Dev/test-only... a real Production module would own this") — the real Production module isn't built yet; decide its shape when it's actually built, not as part of this migration. |
| IPQC | not yet built | **Design later** | Currently only exists as rows written by `material_consumption_service.finalize()`; no standalone API yet. |

## 3. Frontend pages that can move first (lowest risk)

`skus`, `vendors`, `machines` — these three pages are simple list+CRUD
screens with no OCR, no multi-table transaction, and no scan-driven
state machine. They're the cleanest Phase 1 candidates: small blast
radius if an RLS policy is wrong, and easy to verify by hand (four
CRUD actions each). `locations` and the two reference lookups
(`sku-codes`, `checklist-items`) are read-only and even lower-risk.

Every other module's *list/detail read* can also move once RLS exists,
but its writes stay in FastAPI — so those pages end up on two data
sources (Supabase for the table view, `lib/api.ts` for the wizard/panel
that edits a record), which is exactly the hybrid shape the task asks
for.

## 4. Pre-existing issue this migration makes more urgent

`pallet_service.next_pallet_display_id` / `next_batch_display_id` /
`next_shipment_number` compute "next number" by counting existing rows
in Python, with no `SELECT ... FOR UPDATE` or real Postgres sequence.
This was already flagged as a race condition risk under concurrent
FastAPI requests; it becomes more exploitable once any number-issuing
write path is reachable directly from multiple browser tabs instead of
funneling through one backend process. Recommend fixing this (a real
Postgres sequence per prefix, or an advisory lock) as part of Phase 0,
before opening any additional write paths.

## 5. Required schema/security changes (Phase 0 — must land first)

1. **Backfill identity**: link the two existing `app_users` rows
   (`r.fernandez@cirkla.com`, `staff@cirkla.com`) to their real Supabase
   `auth.users.id` via `auth_user_id`, and make `SupabaseAuthAdapter`
   (or a Postgres trigger on a Supabase Auth webhook) populate it going
   forward for anyone new, instead of requiring a manual SQL step.
2. **Add a stable helper**: a `security definer` SQL function
   (e.g. `app_user_id()`) that resolves `auth.uid()` → `app_users.id`,
   used inside every RLS policy instead of repeating the join.
3. **Enable RLS on every table**, even ones staying FastAPI-write-only —
   right now they're only "safe" because Supabase never granted the
   `anon`/`authenticated` roles anything, which is an accident of how
   the schema was applied, not an intentional boundary.
4. **Per-module policies**: for the Phase 1 tables (SKUs, vendors,
   machines, locations, reference data), real `SELECT`/`INSERT`/
   `UPDATE`/`DELETE` policies keyed off `module_permissions.can_*`. For
   every other table, `SELECT`-only policies (read via Supabase, write
   only via FastAPI's service-role connection, which bypasses RLS
   exactly as it does today).
5. Fix the sequence race condition (§4).

## 6. Risks / dependencies

- **Misconfigured RLS is the main risk** — either locking out legitimate
  users (breaks the app) or under-scoping a policy (a view-only user
  gets write access Postgres doesn't know FastAPI would have denied).
  Each table's policy needs to be verified against both an editor and a
  view-only test user before its page is switched over.
- **This sandbox has no network route to supabase.co**, so RLS policies
  can be written and reviewed here but not exercised against your real
  project from this session — final verification of each policy has to
  happen against the actual Supabase project (via the SQL Editor's
  "Run as user" / test queries, or from the deployed app) before it's
  trusted.
- **New-user onboarding is still a manual SQL step** (nobody gets an
  `app_users` row automatically on first Google sign-in) — today that
  fails as a clean 401; under RLS it can instead silently return zero
  rows, which is a worse debugging experience. Frontend should keep
  showing a clear "no account provisioned" state rather than an empty
  table.
- **JWT staleness**: a permission change takes effect on the next
  request today (FastAPI checks the DB every time); under RLS it's the
  same, but the Supabase JS client may hold a session token for up to
  its expiry — not a blocker, just worth knowing if a permission change
  seems to take a moment to apply in the browser.

## 7. Proposed order

**Phase 0** (prerequisite, no user-visible change): auth_user_id
backfill + trigger, `app_user_id()` helper, RLS enabled everywhere with
service-role-only policies (i.e. nothing changes for the browser yet —
this just makes the current "FastAPI-only" reality explicit and safe).
Fix the numbering race condition.

**Phase 1** (lowest risk, visible change): switch `skus`, `vendors`,
`machines`, `locations` pages to real Supabase-direct CRUD, with real
per-module RLS policies. Verify against both an editor and a view-only
account.

**Phase 2**: switch every module's list/detail *read* to Supabase
direct (IVI, Inward QC, RM/FG QR Generation, RM/FG Storage, Material
Consumption) while every write stays exactly as it is today in FastAPI.

**Phase 3** (optional, revisit later): reconsider `scan-pallet`/
`scan-location` as Postgres RPC functions if there's a measured latency
benefit; otherwise leave them in FastAPI indefinitely — they're cheap
either way.

Material Consumption's own writes (scan/finalize/etc.) are not touched
by this migration at all — they stay in FastAPI under every phase,
per §2.
