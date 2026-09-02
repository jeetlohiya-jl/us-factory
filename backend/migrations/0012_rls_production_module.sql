-- Production module (list/detail via direct Supabase reads, per the hybrid
-- architecture). Production Runs are never created through a manual "New
-- Record" flow -- they are exclusively auto-created by Material
-- Consumption's finalize() (see find_or_create_production_run in
-- material_consumption_service.py), which already ran, before this
-- migration, as FastAPI's service-role connection (bypasses RLS
-- regardless). This migration only opens the read side for the browser
-- client, now that `production` is a real permission-gated module (see
-- MODULES in app/api/me.py) instead of an unauthenticated stub.
--
-- ipqc_records and material_consumptions/*_machine_entries/*_pallets
-- (needed for the per-machine drill-down on a Production record's detail
-- view) already have SELECT policies from migration 0011 -- nothing to
-- add there.

-- =========================================================================
-- production_runs: was a blanket "any authenticated user" policy (written
-- before Production had its own module/permission). Now that it does,
-- tighten it to match every other Phase 2 business-data table: gated by
-- the record's own module's view permission. This does not affect
-- app/api/production.py's list_production_runs (used by FG QR Generation's
-- "create from run" picker) -- that endpoint runs through FastAPI's
-- service-role connection, which bypasses RLS entirely either way.
-- =========================================================================

drop policy if exists production_runs_select on production_runs;
create policy production_runs_select on production_runs for select
  using (app_can('production', 'view'));

-- =========================================================================
-- production_run_machines: join table (one row per machine on a run) --
-- had RLS enabled since Phase 0 but no policy and no grant yet, so it was
-- fully invisible to the browser client. Same gate as production_runs
-- itself, since a run's machine list is part of viewing that run.
-- =========================================================================

grant select on production_run_machines to authenticated;

drop policy if exists production_run_machines_select on production_run_machines;
create policy production_run_machines_select on production_run_machines for select
  using (app_can('production', 'view'));
