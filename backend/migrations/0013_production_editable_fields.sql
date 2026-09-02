-- Production, part 2: makes Production an actionable/editable record
-- instead of a pure trace view, per the HTML prototype's own "New
-- Production Record" panel (PROD_ATTRIBUTES, Rejection Classification,
-- Wastage, FG Pallets).
--
-- Design notes:
-- 1) The prototype's per-machine "Production Details" table (SKU Name,
--    Weight, Pcs/Sleeve, Sleeve/Case, Total No. of Pcs/Pallet, Total No.
--    of Pallets, Target Shots, Pad Type, Pad Color, Case Type) is NOT
--    re-entered per production run -- prodBuildDetailsTable() renders it
--    from SKU_PRODUCTION_DETAILS, a lookup keyed by SKU. That data belongs
--    on the SKU Version, not on the run, so it's entered once (via the
--    existing SKU Names admin screen) and autopopulates every Production
--    record that uses that SKU Version -- matching the task's own "Do NOT
--    ask the user to re-enter data that is already available" and "will
--    be saved in the database" instructions. SKU Version writes already
--    go direct-to-Supabase (Phase 1); these columns ride along on the same
--    existing table/RLS policy, no new write path needed.
-- 2) Rejection Classification and Total FG Pallets Generated ARE
--    genuinely per-run, editable data (matches prodCollectRecord's rc.*
--    and totalFgPallets, and PROD_RECORDS' own rejectionClassification
--    shape) -- these go directly on production_runs. total_fg_pallets
--    already exists as a column (added when ProductionRun was first
--    created as FG QR Generation's minimal stub) and is reused as-is.
-- 3) Wastage is a repeatable list (prodWastageEntries) tied to one machine
--    each -- a real child table, FK'd to machines per the task's "use the
--    existing normalized PK/FK relationships" instruction, not a
--    free-text machine label like the prototype's own in-memory version.

-- =========================================================================
-- 1) SKU Version -- Production Details reference attributes
-- =========================================================================

alter table sku_versions add column if not exists prod_weight text;
alter table sku_versions add column if not exists prod_pcs_per_sleeve text;
alter table sku_versions add column if not exists prod_sleeve_per_case text;
alter table sku_versions add column if not exists prod_total_pcs_per_pallet integer;
alter table sku_versions add column if not exists prod_total_pallets integer;
alter table sku_versions add column if not exists prod_target_shots text;
alter table sku_versions add column if not exists prod_pad_type text;
alter table sku_versions add column if not exists prod_pad_color text;
alter table sku_versions add column if not exists prod_case_type text;

-- =========================================================================
-- 2) Production Runs -- Rejection Classification
-- =========================================================================

alter table production_runs add column if not exists rejection_damage numeric not null default 0;
alter table production_runs add column if not exists rejection_misplaced_glue numeric not null default 0;
alter table production_runs add column if not exists rejection_misplaced_pad numeric not null default 0;
alter table production_runs add column if not exists rejection_glue_on_pad numeric not null default 0;
alter table production_runs add column if not exists rejection_pad_placement_direction numeric not null default 0;
alter table production_runs add column if not exists rejection_adhesion_issue numeric not null default 0;

-- =========================================================================
-- 3) Production Wastage entries -- repeatable, one row per entry, each
--    tied to one of the run's machines.
-- =========================================================================

create table if not exists production_wastage_entries (
  id uuid primary key default gen_random_uuid(),
  production_run_id uuid not null references production_runs(id) on delete cascade,
  machine_id uuid references machines(id),
  trays numeric,
  reason text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_production_wastage_run on production_wastage_entries(production_run_id);

alter table production_wastage_entries enable row level security;

-- =========================================================================
-- 4) RLS -- read-only for the browser client (writes go exclusively
--    through FastAPI's new transactional save endpoint, same split as
--    every other Phase 2 business table).
-- =========================================================================

grant select on production_wastage_entries to authenticated;

drop policy if exists production_wastage_select on production_wastage_entries;
create policy production_wastage_select on production_wastage_entries for select
  using (app_can('production', 'view'));
