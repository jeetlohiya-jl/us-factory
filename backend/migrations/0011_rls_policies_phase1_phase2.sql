-- Hybrid architecture Phase 1 + Phase 2: real RLS policies + GRANTs for the
-- tables the frontend now reads/writes directly via Supabase, instead of
-- through FastAPI CRUD. See HYBRID_ARCHITECTURE_AUDIT.md for the full
-- reasoning and the phase plan this implements.
--
-- Phase 0 (migration 0009) enabled RLS everywhere with zero policies and
-- zero GRANTs to anon/authenticated -- so today, even with RLS on, the
-- Supabase browser client (which authenticates as `authenticated`, not the
-- table owner) can see and change nothing. This migration is what actually
-- opens specific, permission-checked doors for specific tables. The FastAPI
-- service connection is unaffected either way: it connects as the table
-- owner, which bypasses RLS regardless of policies (verified in Phase 0).
--
-- Design notes:
-- 1) `app_can(module, action)` mirrors the exact default-permission
--    behaviour every *_get_perms()/require() dependency in FastAPI already
--    has: a missing module_permissions row means view-only (can_view=true,
--    everything else false) -- see app/api/deps.py's get_permissions() and
--    every module's own copy of that pattern.
-- 2) Reference/master data (SKUs, SKU versions, Vendors, Machines,
--    Locations, the Inward Vehicle Inspection checklist item list, and
--    Inward QC's static sampling-plan/attribute/fgtray-criteria tables) is
--    made SELECT-able by any provisioned, active app user rather than
--    gated per-module. This matches -- not changes -- current behaviour:
--    FastAPI's own joins (e.g. a QC record's embedded sku_code/vendor)
--    already ignore the requesting user's inward_vehicle_inspection
--    permission today, because those reads happen via the service
--    connection's own SQLAlchemy relationship, never through a second
--    /vendors or /skus permission check. Gating these tables' SELECT by a
--    specific module's permission would be a *new*, stricter behaviour the
--    app doesn't have today, not a preservation of it.
-- 3) Only the write path (INSERT/UPDATE/DELETE) for the Phase 1
--    admin-managed tables (SKUs, SKU versions, Vendors, Machines) is gated
--    by the same module + action FastAPI already gates it by today:
--    `inward_vehicle_inspection`/edit for SKUs+Vendors (see the shared
--    `require_permission` in app/api/deps.py, hard-coded to that module),
--    `material_consumption`/edit for Machines (app/api/machines.py).
--    Checklist items and Locations have no write policy: neither ever had
--    a create/update/delete route in this app (checklist items are
--    seed-only reference data; locations are fixed warehouse slots seeded
--    once by migration, never created through the API -- confirmed no
--    `models.Location(...)` construction exists anywhere in app code).
-- 4) Phase 2 business-data tables get SELECT-only policies, gated by each
--    table's OWN module's view permission -- writes to these tables
--    continue exclusively through FastAPI's transactional endpoints, which
--    still connect as the table owner and are unaffected by any of this.

-- =========================================================================
-- 0) Permission-check helper
-- =========================================================================

create or replace function app_can(_module text, _action text) returns boolean
  language sql stable security definer
  set search_path = public
as $$
  select coalesce(
    (
      select case _action
        when 'view' then can_view
        when 'create' then can_create
        when 'edit' then can_edit
        when 'delete' then can_delete
        when 'approve' then can_approve
        when 'fill_section' then can_fill_section
        else false
      end
      from module_permissions
      where user_id = app_user_id() and module = _module
    ),
    -- No explicit row => view-only default, exactly matching
    -- ModulePermission(can_view=True) in every FastAPI *_get_perms().
    _action = 'view'
  );
$$;

-- =========================================================================
-- 1) Phase 1 — reference/master data: SKUs, Vendors, Machines, Locations,
--    checklist items. Full CRUD from the browser, RLS-enforced.
-- =========================================================================

-- SKUs (sku_codes, sku_versions) -----------------------------------------

grant select, insert, update, delete on sku_codes to authenticated;
grant select, insert, update, delete on sku_versions to authenticated;

drop policy if exists sku_codes_select on sku_codes;
create policy sku_codes_select on sku_codes for select
  using (app_user_id() is not null);

drop policy if exists sku_codes_write on sku_codes;
create policy sku_codes_write on sku_codes for all
  using (app_can('inward_vehicle_inspection', 'edit'))
  with check (app_can('inward_vehicle_inspection', 'edit'));

drop policy if exists sku_versions_select on sku_versions;
create policy sku_versions_select on sku_versions for select
  using (app_user_id() is not null);

drop policy if exists sku_versions_write on sku_versions;
create policy sku_versions_write on sku_versions for all
  using (app_can('inward_vehicle_inspection', 'edit'))
  with check (app_can('inward_vehicle_inspection', 'edit'));

-- Vendors -------------------------------------------------------------

grant select, insert, update, delete on vendors to authenticated;

drop policy if exists vendors_select on vendors;
create policy vendors_select on vendors for select
  using (app_user_id() is not null);

drop policy if exists vendors_write on vendors;
create policy vendors_write on vendors for all
  using (app_can('inward_vehicle_inspection', 'edit'))
  with check (app_can('inward_vehicle_inspection', 'edit'));

-- Machines --------------------------------------------------------------

grant select, insert, update, delete on machines to authenticated;

drop policy if exists machines_select on machines;
create policy machines_select on machines for select
  using (app_user_id() is not null);

drop policy if exists machines_write on machines;
create policy machines_write on machines for all
  using (app_can('material_consumption', 'edit'))
  with check (app_can('material_consumption', 'edit'));

-- Locations (read-only from the app; no create/update/delete route exists) --

grant select on locations to authenticated;

drop policy if exists locations_select on locations;
create policy locations_select on locations for select
  using (app_user_id() is not null);

-- Inward Vehicle Inspection checklist items (reference; read-only) --------

grant select on inward_vehicle_inspection_checklist_items to authenticated;

drop policy if exists ivi_checklist_items_select on inward_vehicle_inspection_checklist_items;
create policy ivi_checklist_items_select on inward_vehicle_inspection_checklist_items for select
  using (app_user_id() is not null);

-- =========================================================================
-- 2) Phase 2 — Inward QC's static reference tables (sampling plan tiers,
--    attribute definitions, fgtray criteria): read-only, same as above.
-- =========================================================================

grant select on inward_qc_sampling_plan_tiers to authenticated;
grant select on inward_qc_attribute_definitions to authenticated;
grant select on inward_qc_fgtray_criteria to authenticated;

drop policy if exists qc_sampling_plan_tiers_select on inward_qc_sampling_plan_tiers;
create policy qc_sampling_plan_tiers_select on inward_qc_sampling_plan_tiers for select
  using (app_user_id() is not null);

drop policy if exists qc_attribute_definitions_select on inward_qc_attribute_definitions;
create policy qc_attribute_definitions_select on inward_qc_attribute_definitions for select
  using (app_user_id() is not null);

drop policy if exists qc_fgtray_criteria_select on inward_qc_fgtray_criteria;
create policy qc_fgtray_criteria_select on inward_qc_fgtray_criteria for select
  using (app_user_id() is not null);

-- =========================================================================
-- 3) Phase 2 — Inward Vehicle Inspection: list/detail reads direct from
--    Supabase. Writes (submit, checklist, images, etc.) stay in FastAPI.
-- =========================================================================

grant select on inward_vehicle_inspections to authenticated;
grant select on inward_vehicle_inspection_line_items to authenticated;
grant select on inward_vehicle_inspection_images to authenticated;
grant select on inward_vehicle_inspection_checklist_answers to authenticated;

drop policy if exists ivi_select on inward_vehicle_inspections;
create policy ivi_select on inward_vehicle_inspections for select
  using (app_can('inward_vehicle_inspection', 'view'));

drop policy if exists ivi_line_items_select on inward_vehicle_inspection_line_items;
create policy ivi_line_items_select on inward_vehicle_inspection_line_items for select
  using (app_can('inward_vehicle_inspection', 'view'));

drop policy if exists ivi_images_select on inward_vehicle_inspection_images;
create policy ivi_images_select on inward_vehicle_inspection_images for select
  using (app_can('inward_vehicle_inspection', 'view'));

drop policy if exists ivi_checklist_answers_select on inward_vehicle_inspection_checklist_answers;
create policy ivi_checklist_answers_select on inward_vehicle_inspection_checklist_answers for select
  using (app_can('inward_vehicle_inspection', 'view'));

-- =========================================================================
-- 4) Phase 2 — Inward QC: list/detail reads direct from Supabase.
-- =========================================================================

grant select on inward_qc_records to authenticated;
grant select on inward_qc_attribute_values to authenticated;
grant select on inward_qc_fgtray_criteria_answers to authenticated;
grant select on inward_qc_line_item_snapshots to authenticated;

drop policy if exists qc_records_select on inward_qc_records;
create policy qc_records_select on inward_qc_records for select
  using (app_can('inward_qc', 'view'));

drop policy if exists qc_attribute_values_select on inward_qc_attribute_values;
create policy qc_attribute_values_select on inward_qc_attribute_values for select
  using (app_can('inward_qc', 'view'));

drop policy if exists qc_fgtray_criteria_answers_select on inward_qc_fgtray_criteria_answers;
create policy qc_fgtray_criteria_answers_select on inward_qc_fgtray_criteria_answers for select
  using (app_can('inward_qc', 'view'));

drop policy if exists qc_line_item_snapshots_select on inward_qc_line_item_snapshots;
create policy qc_line_item_snapshots_select on inward_qc_line_item_snapshots for select
  using (app_can('inward_qc', 'view'));

-- =========================================================================
-- 5) Phase 2 — RM / FG QR Generation: same table (qr_generation_records),
--    split by qr_type ('rm' | 'fg') into the two separate modules FastAPI
--    already treats them as (app/api/rm_qr.py / app/api/fg_qr.py).
-- =========================================================================

grant select on qr_generation_records to authenticated;

drop policy if exists qr_generation_records_select on qr_generation_records;
create policy qr_generation_records_select on qr_generation_records for select
  using (
    (qr_type = 'rm' and app_can('rm_qr_generation', 'view'))
    or (qr_type = 'fg' and app_can('fg_qr_generation', 'view'))
  );

-- Production Runs feed FG QR Generation's "create from run" picker; no
-- permission gate exists on this endpoint today beyond being logged in
-- (see app/api/production.py) -- matched here as any provisioned user.

grant select on production_runs to authenticated;

drop policy if exists production_runs_select on production_runs;
create policy production_runs_select on production_runs for select
  using (app_user_id() is not null);

-- =========================================================================
-- 6) Phase 2 — RM / FG Storage and Material Consumption both read
--    `pallets`, discriminated by pallet_type ('rm' | 'fg'). A pallet is
--    visible to anyone who can view at least one of the modules that
--    legitimately displays it: RM pallets appear in RM QR Generation (as
--    generated pallets under a batch), RM Storage (pending + stored), and
--    Material Consumption (scanned/consumed); FG pallets appear in FG QR
--    Generation and FG Storage.
-- =========================================================================

grant select on pallets to authenticated;

drop policy if exists pallets_select on pallets;
create policy pallets_select on pallets for select
  using (
    (pallet_type = 'rm' and (
      app_can('rm_qr_generation', 'view')
      or app_can('rm_storage', 'view')
      or app_can('material_consumption', 'view')
    ))
    or (pallet_type = 'fg' and (
      app_can('fg_qr_generation', 'view')
      or app_can('fg_storage', 'view')
    ))
  );

-- storage_records: same split, discriminated by storage_type.

grant select on storage_records to authenticated;

drop policy if exists storage_records_select on storage_records;
create policy storage_records_select on storage_records for select
  using (
    (storage_type = 'rm' and app_can('rm_storage', 'view'))
    or (storage_type = 'fg' and app_can('fg_storage', 'view'))
  );

-- =========================================================================
-- 7) Phase 2 — app_users, column-scoped: RM/FG Storage's list and detail
--    both embed "who stored this pallet" (StorageRecordOut.stored_by_name,
--    resolved from stored_by -> app_users.full_name). Only id + full_name
--    are exposed -- never email or auth_user_id -- and only for reading
--    someone else's display name, matching what every storage record
--    already showed through FastAPI's own join.
-- =========================================================================

grant select (id, full_name) on app_users to authenticated;

drop policy if exists app_users_select_display on app_users;
create policy app_users_select_display on app_users for select
  using (app_user_id() is not null);

-- =========================================================================
-- 8) Phase 2 — Material Consumption: list/detail reads direct from
--    Supabase. Draft editing, scanning, and finalize stay in FastAPI.
-- =========================================================================

grant select on material_consumptions to authenticated;
grant select on material_consumption_machine_entries to authenticated;
grant select on material_consumption_pallets to authenticated;

drop policy if exists material_consumptions_select on material_consumptions;
create policy material_consumptions_select on material_consumptions for select
  using (app_can('material_consumption', 'view'));

drop policy if exists mc_machine_entries_select on material_consumption_machine_entries;
create policy mc_machine_entries_select on material_consumption_machine_entries for select
  using (app_can('material_consumption', 'view'));

drop policy if exists mc_pallets_select on material_consumption_pallets;
create policy mc_pallets_select on material_consumption_pallets for select
  using (app_can('material_consumption', 'view'));

-- Material Consumption detail embeds production_run -> ipqc_record purely
-- for the traceability-chain link (ipqc_id on MaterialConsumptionDetailOut);
-- no permission gate exists on IPQC today (it has no module/API of its own
-- yet -- see the IpqcRecord model docstring), so this matches
-- production_runs above: visible to any provisioned user.

grant select on ipqc_records to authenticated;

drop policy if exists ipqc_records_select on ipqc_records;
create policy ipqc_records_select on ipqc_records for select
  using (app_user_id() is not null);
