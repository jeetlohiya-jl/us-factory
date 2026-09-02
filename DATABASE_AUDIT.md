# Database Audit — Factory OS

Read-only audit of every migration (`0001`–`0009`), `app/db/models.py`,
every domain service, every API route's delete/create logic, and the
frontend's actual field sources (to check what's genuinely a dropdown vs.
free text) — plus targeted queries against the real dev database to
confirm every finding against actual data before recommending a fix.
Nothing has been changed yet; this is the "before" picture.

## 1. Current PK/FK structure

Every one of the 30 tables uses a stable `uuid primary key default
gen_random_uuid()` — internal IDs are already consistently used for every
relationship, and every business/display identifier (`pallets.display_id`,
`qr_generation_records.batch_display_id`, `production_runs.run_number`,
`locations.display_id`, `machines.code`, `sku_codes.code`) is already a
separate column from the primary key, which is exactly the shape asked
for. The FK graph correctly threads the full traceability chain end to
end: Vehicle Inspection → (line items/images/checklist) → Inward QC →
(attribute values/fgtray answers/line item snapshots) → QR Generation →
Pallets → Storage Records / Material Consumption (→ machine entries →
pallets) → Production Run → IPQC. No missing link was found in that
chain — every stage's FastAPI code already resolves the *previous*
stage's row and threads its ID forward rather than re-deriving it.

So the audit below is about *tightening* an already-sound structure, not
rebuilding it — the specific gaps found are narrow and evidence-backed
against real data, not speculative.

## 2. Missing/incorrect relationships and integrity bugs found

**A stale delete-safety check that no longer checks the right column.**
`app/api/machines.py`'s `delete_machine` still queries
`MaterialConsumption.machine_id` — the *legacy* per-record machine column
that the multi-machine redesign (migration `0008`) stopped writing to.
Every machine used by a record created since that redesign lives on
`MaterialConsumptionMachineEntry.machine_id` instead, which this check
never looks at. Today, deleting a machine that's actively in use by a
current-shape record would either succeed when it shouldn't, or hit the
database's own foreign-key constraint and surface as a raw, unhandled 500
error instead of the friendly 409 message every other delete route gives
— there's also no `try/except IntegrityError` here as a fallback, unlike
`skus.py`/`vendors.py`. **This is a real bug, introduced by the earlier
multi-machine migration, not a hypothetical risk.**

**Inward QC's delete route has no dependent-record check at all.**
`app/api/inward_qc.py`'s `delete_qc` deletes unconditionally. But
`QrGenerationRecord.source_inward_qc_id`, `Pallet.source_inward_qc_id`,
and `StorageRecord.source_inward_qc_id` all reference `inward_qc_records`
with no `ON DELETE` clause (Postgres default: block the delete). So
deleting a QC record that's already been used to generate RM QR
pallets — a completely normal, common case — currently raises an
unhandled `IntegrityError` (raw 500) instead of the same kind of clean
"this record has already been used and can't be deleted" message that
`inward_vehicle_inspections.py` (`find_dependent_qc`) and `rm_qr.py`
(checks `rec.pallets`) both already give correctly. This is the one
delete route in the whole app missing that pattern.

## 3. Duplicated/denormalized data

**Intentional, and already done correctly** (confirmed against the
task's own "keep intentional historical snapshots" guidance): the
`*_snapshot` text columns repeated across `pallets`, `qr_generation_records`,
`inward_qc_records`, `inward_qc_line_item_snapshots`,
`material_consumptions`, `material_consumption_machine_entries`, and
`ipqc_records` are paired with a real FK to the live SKU row *and* a
frozen text copy — exactly the right shape for "what this record showed
at the time" vs. "what the SKU is called today." Not a defect; no change
recommended.

**One real gap in that same pattern**: `production_runs` has
`sku_code_id`/`sku_version_id` but, unlike every sibling table above, no
`sku_code_snapshot`/`sku_version_snapshot` columns — so if a SKU's code or
version label is ever renamed later, an already-approved Production Run's
displayed SKU would silently change retroactively, unlike everywhere else
in the app. Low priority to fix *now* since `ProductionRun` is explicitly
a minimal stub (its own docstring: "the full Production... module...
[is] intentionally not built here") — recommend adding the two snapshot
columns when the real Production module is actually built, not as a
speculative addition today, since inventing them now without the write
path that populates them would just be two more silently-null columns.

**One real "unclear source of truth" worth flagging**: `vendor_name` on
`inward_vehicle_inspections` / `inward_qc_records` is plain text, not a
foreign key to `vendors` — confirmed *not* free-typed (the frontend
wizard already sources it from a real `<select>` populated by
`api.vendors({category})`), so the text always exactly matches an
existing `vendors.name` at write time today. But `country_code`
resolution for RM pallet numbering (`qr_generation_service._resolve_qc_country`)
has to re-match that text back to a `vendors` row by `(category, name)`
at QR-generation time — a vendor renamed in between silently breaks that
match and falls back to "US". This works today only because vendor
renames haven't happened yet in practice. **Recommendation**: add a
nullable `vendor_id` FK column to both tables, populated at write time
(same dropdown selection the UI already makes), keep `vendor_name` exactly
as-is as the permanent display snapshot (never removed), and have country
resolution prefer the FK with the existing name-match as a fallback for
any pre-existing row that predates the column. This is additive and
doesn't change the UI at all — flagging it separately from the "implement
now" list below since it's the one item that reaches into three domain
files rather than being a pure constraint/index/bugfix.

## 4. Missing constraints/indexes

**Missing UNIQUE constraints** (verified against real data — zero
non-blank duplicates exist today in the dev DB, so these are safe to add
as partial indexes right now):
- `inward_vehicle_inspections.shipment_number` — no uniqueness at all
  today. Auto-generated ones are now race-safe (Phase 0's counter fix)
  but were never *guaranteed* unique at the DB level, and the "tray"
  category's manually-typed number has zero collision protection —
  two different trucks could be given the same number by a typo with
  nothing stopping it. Recommend a partial unique index excluding blank
  values (blank is the legitimate not-yet-filled-in draft state — 12 of
  the 12 current rows are blank tray drafts, confirmed zero real
  collisions).
- `inward_qc_records.shipment_number` — same gap, same fix (9 of 9
  current blanks are all `fgtray`, which never gets its own number until
  its source inspection is approved — confirmed legitimate, not a bug).

**Missing indexes on foreign-key columns** (Postgres never indexes the
child side of a FK automatically — `0007_performance_indexes.sql`
already fixed the highest-traffic ones on `pallets`/`storage_records`,
but these child tables were missed):
- `inward_qc_records(sku_code_id)`, `inward_qc_records(sku_version_id)`
- `inward_vehicle_inspection_line_items(sku_code_id, sku_version_id)`
- `inward_vehicle_inspection_checklist_answers(inspection_id)`
- `inward_qc_fgtray_criteria_answers(inward_qc_id)`
- `inward_qc_attribute_values(inward_qc_id)`
- `qr_generation_records(sku_version_id)` (only `sku_code_id` was indexed)
- `production_runs(sku_version_id)`, `ipqc_records(sku_version_id)` (same
  sku_code-only gap)
- `material_consumption_machine_entries(sku_code_id, sku_version_id)`

## 5. Incorrect nullable fields

`material_consumption_pallets.machine_entry_id` is nullable only because
migration `0008` had to add it to an existing table and backfill it in a
second step — every row created by current code always sets it, and the
backfill already ran cleanly against the dev DB (confirmed in the
previous session). Recommend tightening it to `NOT NULL` now, with a
defensive backfill `UPDATE` run immediately before the constraint is
added (so this is safe to run even if `0008` hasn't been applied to a
given database yet, e.g. production, at the time this runs).

No other incorrect-nullability issues found — every other nullable
column corresponds to a real "not always applicable" business case
(e.g. `pallets.current_location_id` is null until a pallet is actually
stored somewhere, which is correct).

## 6. Unsafe CASCADE / DELETE behaviour

Beyond the two bugs in §2, the rest of the schema's delete behavior is
sound and consistent: pallets are never deletable at all (correct — they
must persist for traceability), `SkuCode`/`SkuVersion` deletion correctly
cascades at the ORM level then hits a real DB-level `RESTRICT` if
anything downstream still references it (caught and turned into a clean
409), and `InwardVehicleInspection`/`MaterialConsumption` deletion both
already check for dependents before touching anything. `current_location_id`
and `lifecycle_status` are correctly *not* reset when a pallet is
consumed — the "last known location" staying on a consumed pallet is the
intentional historical trail the task asks to preserve, not a bug.

## 7. Orphan/inconsistent records

None found in the current dev data beyond the two known-benign "blank
shipment_number on a still-in-progress draft" cases already covered in
§4. No dangling FK values, no pallets missing a source QR generation
record, no storage records pointing at a location that doesn't exist.

## 8. Race conditions in generated numbering/IDs

Already fully addressed in Phase 0 (`app/domain/id_counters.py` +
migration `0009`) — every numbering sequence this audit could find
(pallet display_ids, QR batch numbers, both Inward Vehicle Inspection's
and Inward QC's own auto shipment numbers, Production Run numbers) now
goes through the same atomic counter, verified under real concurrent
load. **No gaps found; no further changes needed here.**

## 9. Phase 0 items that need revisiting

**None.** This audit doesn't touch RLS, `auth_user_id`, `app_user_id()`,
or the permission model, and doesn't add any new table that would need
RLS enabled — every change below is a column/constraint/index addition
to existing, already-RLS-enabled tables, or an application-layer bugfix.
Phase 0's numbering fix already covers everything this audit found. No
revisiting needed.

## 10. Recommended schema changes — what's safe to implement now

Everything in §4 and §5 (unique constraints, missing indexes, the
`machine_entry_id` NOT NULL tightening) is purely additive, has been
checked against real data, and changes no application behavior or API
shape. Alongside those, the two bugfixes in §2
(`machines.py`'s stale check, `inward_qc.py`'s missing dependent check)
are application-layer fixes that don't touch the schema at all. All of
this can go in one migration + two small code fixes with no workflow
change and no risk to existing data.

The one item held out for a separate decision is the `vendor_id` FK
normalization from §3 — it's still purely additive and low-risk, but it
touches three domain files (vehicle inspection, Inward QC, QR generation)
rather than being a pure constraint/index fix, so it's called out
separately rather than bundled in silently.

## 11. Implementation status — this pass (2026-09-02)

The user confirmed the full scope above, including the `vendor_id`
normalization. Everything in §10 plus §3 has been implemented, applied to
the real dev database, and verified against real data (not just imports):

- **Migration `0010_database_hardening.sql`** — applied cleanly to a
  disposable clone of the dev DB first, then to the real dev DB
  (`factory_os`); re-run confirmed idempotent (every statement is
  `if not exists` / `coalesce`-guarded).
  - Partial unique indexes on `shipment_number` for both
    `inward_vehicle_inspections` and `inward_qc_records` — confirmed zero
    real (non-blank) duplicates existed before applying.
  - All fourteen missing FK-column indexes from §4 created.
  - `material_consumption_pallets.machine_entry_id` tightened to
    `NOT NULL` — the defensive backfill was a no-op (`UPDATE 0`), matching
    the prior verification that migration 0008's backfill was already
    complete.
  - `vendor_id` columns + indexes added to `inward_vehicle_inspections`
    and `inward_qc_records`; backfill matched exactly the predicted set
    computed from real vendor/vendor_name data beforehand (3 distinct
    vendors matched: MIDA/MIDA2/MIDA3 under `tray` for both Vehicle
    Inspection rows and their propagated `fgtray` QC rows, and PadCoJP
    under `pad`; every `"Test Vendor"` row — for which no matching
    `vendors` row exists in any category — correctly backfilled to
    `NULL`, keeping `vendor_name` as the sole source of truth for those
    rows exactly as designed).
- **`machines.py` delete-safety bugfix** (§2) — verified live: attached a
  scratch machine to a `MaterialConsumptionMachineEntry` and confirmed
  `DELETE` now correctly returns 409 (previously would have silently
  succeeded, since the check looked at a column the multi-machine
  redesign stopped writing to); confirmed an unused machine still deletes
  with 204 once detached.
- **`inward_qc.py` delete-safety fix** (§2) — verified live: confirmed
  `DELETE` on a QC record that already generated an RM QR batch now
  returns 409 naming the batch (`RMQR-0001`), and a QC record with no
  dependent QR batch still deletes cleanly.
- **`vendor_id` write path** (§3) — verified live end-to-end: updating a
  Vehicle Inspection's or Inward QC's `vendor_name` via the API now sets
  `vendor_id` to the matching `vendors` row; a full Tray → fgtray QC
  approval flow confirmed `propagate_to_qc` copies `vendor_id` directly
  onto the auto-created fgtray record; confirmed
  `_resolve_qc_country` now returns the FK-backed vendor's country
  (`PadCoJP` → `JP`) without falling back to the text-match path.
- **Regression check** — re-ran the full Material Consumption multi-machine
  E2E suite (`/tmp/setup_mc_test_data.py` + `/tmp/e2e_mc_test.py`) against
  the migrated dev DB: all checks passed, confirming the
  `machine_entry_id` NOT NULL tightening didn't break Production Run /
  Material Consumption creation.

All test data created during verification (scratch machine, scratch QC
drafts, scratch Vehicle Inspection + its auto-propagated QC, E2E test
pallets/machine-entries/material-consumption record) was deleted from the
dev database afterward; nothing from this verification pass was left
behind.
