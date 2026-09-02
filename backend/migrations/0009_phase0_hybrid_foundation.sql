-- Phase 0 of the hybrid-architecture migration (see the audit doc,
-- "hybrid-architecture-audit.md", for the full reasoning). This migration
-- makes NO behavioural change to the running app by itself -- FastAPI
-- connects with a role that owns these tables, and table owners bypass
-- Row-Level Security by default (this migration does not use FORCE ROW
-- LEVEL SECURITY, specifically so that stays true). It exists purely to
-- put the real security boundary in place BEFORE any page starts reading
-- Supabase directly, and to fix a pre-existing ID-numbering race
-- condition before more write paths are opened up.
--
-- 1) display_id_counters -- atomic backing store for every "next number"
--    this app issues (pallet display_ids, QR batch numbers, auto shipment
--    numbers, Production Run numbers), replacing count()+1 in Python,
--    which raced under concurrent requests. Backfilled here from the
--    current max already-issued number per sequence, so numbering
--    continues exactly where it left off -- nothing is renumbered.
--
-- 2) auth_user_id linkage -- a unique index so at most one app_users row
--    can ever claim a given Supabase auth user (SupabaseAuthAdapter now
--    writes this column in on first successful login instead of it being
--    permanently null).
--
-- 3) app_user_id() -- a small helper Postgres function that resolves
--    Supabase's auth.uid() to this app's own app_users.id, for future RLS
--    policies to use instead of repeating the join. Not referenced by any
--    policy yet -- Phase 1 is what actually writes policies against it.
--
-- 4) Row-Level Security enabled on every table, with zero policies added
--    yet. Today nothing grants the anon/authenticated roles PostgREST
--    uses any privileges on these tables, so this is currently a no-op in
--    practice -- but it makes that an explicit, intentional boundary
--    instead of an accident of how the schema happened to be applied, and
--    it means a table can never be silently exposed later (e.g. by
--    someone using the Supabase dashboard's table editor, which grants
--    privileges automatically) without a real policy being written first.

-- =========================================================================
-- 1) Atomic ID counters
-- =========================================================================

create table if not exists display_id_counters (
  counter_key text primary key,
  next_value integer not null default 1
);

-- Backfill: seed each counter at (current max issued sequence + 1) so
-- numbering picks up exactly where count()+1 would have, for every
-- sequence that already has at least one row.

-- Pallets: keyed by "<country>-<category suffix>" prefix (before the
-- "-yymm-seq4" suffix), shared across rm+fg pallet_type per the module's
-- documented design.
insert into display_id_counters (counter_key, next_value)
select 'pallet:' || regexp_replace(display_id, '-[0-9]{4}-[0-9]{4}$', ''), count(*) + 1
from pallets
group by regexp_replace(display_id, '-[0-9]{4}-[0-9]{4}$', '')
on conflict (counter_key) do nothing;

-- QR batches: keyed by qr_type (rm | fg).
insert into display_id_counters (counter_key, next_value)
select 'qr_batch:' || qr_type, count(*) + 1
from qr_generation_records
group by qr_type
on conflict (counter_key) do nothing;

-- Inward Vehicle Inspection auto shipment numbers: keyed by category,
-- counted only over rows that actually got an auto-generated number
-- (tray is manual and never counted here, matching the original code).
insert into display_id_counters (counter_key, next_value)
select 'ivi_shipment:' || category, count(*) + 1
from inward_vehicle_inspections
where is_auto_shipment_number = true
group by category
on conflict (counter_key) do nothing;

-- Inward QC manual-category shipment numbers: a SEPARATE sequence from
-- Inward Vehicle Inspection's, even though they share the same prefix
-- format per category -- these are two different tables' own counts in
-- the original code, not one shared sequence.
insert into display_id_counters (counter_key, next_value)
select 'qc_shipment:' || category, count(*) + 1
from inward_qc_records
where is_auto_shipment_number = true
group by category
on conflict (counter_key) do nothing;

-- Production Runs: one single global counter.
insert into display_id_counters (counter_key, next_value)
select 'production_run', count(*) + 1
from production_runs
on conflict (counter_key) do nothing;

-- =========================================================================
-- 2) auth_user_id linkage
-- =========================================================================

create unique index if not exists uq_app_users_auth_user_id
  on app_users(auth_user_id) where auth_user_id is not null;

-- =========================================================================
-- 3) app_user_id() helper for future RLS policies (Phase 1+)
-- =========================================================================

create or replace function app_user_id() returns uuid
  language sql stable security definer
  set search_path = public
as $$
  select id from app_users where auth_user_id = auth.uid() and is_active limit 1;
$$;

-- =========================================================================
-- 4) Enable RLS everywhere, no policies yet (no behaviour change for the
--    FastAPI service connection, which owns these tables and therefore
--    bypasses RLS regardless -- see the header note above).
-- =========================================================================

alter table app_users enable row level security;
alter table module_permissions enable row level security;
alter table display_id_counters enable row level security;
alter table sku_codes enable row level security;
alter table sku_versions enable row level security;
alter table vendors enable row level security;
alter table machines enable row level security;
alter table locations enable row level security;
alter table inward_vehicle_inspections enable row level security;
alter table inward_vehicle_inspection_line_items enable row level security;
alter table inward_vehicle_inspection_images enable row level security;
alter table inward_vehicle_inspection_checklist_items enable row level security;
alter table inward_vehicle_inspection_checklist_answers enable row level security;
alter table inward_qc_records enable row level security;
alter table inward_qc_fgtray_criteria enable row level security;
alter table inward_qc_fgtray_criteria_answers enable row level security;
alter table inward_qc_attribute_definitions enable row level security;
alter table inward_qc_attribute_values enable row level security;
alter table inward_qc_sampling_plan_tiers enable row level security;
alter table inward_qc_line_item_snapshots enable row level security;
alter table production_runs enable row level security;
alter table production_run_machines enable row level security;
alter table ipqc_records enable row level security;
alter table qr_generation_records enable row level security;
alter table pallets enable row level security;
alter table pallet_lifecycle_events enable row level security;
alter table storage_records enable row level security;
alter table material_consumptions enable row level security;
alter table material_consumption_machine_entries enable row level security;
alter table material_consumption_pallets enable row level security;
