-- ============================================================================
-- Query profiling for the Material Consumption and Production list reads,
-- plus the /api/v1/me permission lookup.
--
-- HOW TO RUN: Supabase Dashboard -> SQL Editor -> paste one section at a
-- time (not the whole file at once) and run it, then paste the output back.
-- The SQL Editor connects as the `postgres` superuser, which BYPASSES RLS
-- entirely -- so PART A below shows the raw join/index cost with no RLS
-- involved, and PART B re-runs the same queries impersonating a real
-- `authenticated` user so RLS policy overhead shows up separately. The gap
-- between A and B's timings tells us how much of the 500-700ms is the joins
-- themselves vs. the app_can()/RLS policy evaluation on top of them.
--
-- For PART B you need one real user's Supabase Auth id. Run this first and
-- copy the id it returns:
--   select id, email from auth.users where email = 'jeet.lohiya@gocirkla.com';
-- ============================================================================


-- ============================================================================
-- PART A -- raw query cost, RLS bypassed (runs as postgres by default)
-- ============================================================================

-- A1: Material Consumption list (mirrors the trimmed MC_LIST_SELECT the
-- frontend now sends: material_consumptions -> machine_entries -> machine,
-- and -> pallets -> pallet, ordered by created_at desc limit 50)
explain (analyze, buffers, format text)
select
  mc.id, mc.consumption_date, mc.shift, mc.status,
  e.category, e.sku_code_snapshot, e.sku_version_snapshot, e.start_time, e.end_time, e.sort_order,
  m.code as machine_code,
  p.role, p.sort_order as pallet_sort,
  pl.display_id
from material_consumptions mc
left join material_consumption_machine_entries e on e.material_consumption_id = mc.id
left join machines m on m.id = e.machine_id
left join material_consumption_pallets p on p.machine_entry_id = e.id
left join pallets pl on pl.id = p.pallet_id
order by mc.created_at desc
limit 50;

-- A2: Production list (mirrors PRODUCTION_LIST_SELECT: production_runs plus
-- sku_code, machines, created_by_user, and the material_consumptions ->
-- machine_entries -> pallets -> pallet / sku_version_ref chain used to
-- derive Total Pcs/Pallet and Shipment Number)
explain (analyze, buffers, format text)
select
  pr.id, pr.run_number, pr.shipment_number, pr.shift, pr.production_date, pr.status,
  pr.rejection_damage, pr.rejection_misplaced_glue, pr.rejection_misplaced_pad,
  pr.rejection_glue_on_pad, pr.rejection_pad_placement_direction, pr.rejection_adhesion_issue,
  sc.code as sku_code,
  m.code as machine_code,
  au.full_name as operator,
  mc.id as mc_id, pmpal.role, ppal.shipment_number as pallet_shipment_number,
  sv.prod_total_pcs_per_pallet
from production_runs pr
left join sku_codes sc on sc.id = pr.sku_code_id
left join production_run_machines prm on prm.production_run_id = pr.id
left join machines m on m.id = prm.machine_id
left join app_users au on au.id = pr.created_by
left join material_consumptions mc on mc.production_run_id = pr.id
left join material_consumption_machine_entries pme on pme.material_consumption_id = mc.id
left join material_consumption_pallets pmpal on pmpal.machine_entry_id = pme.id
left join pallets ppal on ppal.id = pmpal.pallet_id
left join sku_versions sv on sv.id = pme.sku_version_id
order by pr.created_at desc
limit 50;

-- A3: The two queries /api/v1/me runs (app_users lookup by email, then
-- module_permissions lookup by user_id) -- replace the email with your own.
explain (analyze, buffers, format text)
select id, email, full_name, auth_user_id from app_users
where email = 'jeet.lohiya@gocirkla.com' and is_active = true;

-- Run this AFTER A3's first query, using the id it returned:
-- explain (analyze, buffers, format text)
-- select module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section
-- from module_permissions
-- where user_id = '<the id from A3 above>';


-- ============================================================================
-- PART B -- same queries, impersonating a real authenticated user so RLS
-- (app_can() policies) actually run. Replace <AUTH_USER_ID> with the id
-- from `select id from auth.users where email = '...'` above.
-- ============================================================================

select set_config('request.jwt.claims', json_build_object('sub', '<AUTH_USER_ID>', 'role', 'authenticated')::text, true);
set local role authenticated;

explain (analyze, buffers, format text)
select
  mc.id, mc.consumption_date, mc.shift, mc.status,
  e.category, e.sku_code_snapshot, e.sku_version_snapshot, e.start_time, e.end_time, e.sort_order,
  m.code as machine_code,
  p.role, p.sort_order as pallet_sort,
  pl.display_id
from material_consumptions mc
left join material_consumption_machine_entries e on e.material_consumption_id = mc.id
left join machines m on m.id = e.machine_id
left join material_consumption_pallets p on p.machine_entry_id = e.id
left join pallets pl on pl.id = p.pallet_id
order by mc.created_at desc
limit 50;

-- (repeat the set_config + set local role line above before this one too --
-- each new SQL Editor "Run" is its own session/transaction, the role
-- doesn't carry over)
explain (analyze, buffers, format text)
select
  pr.id, pr.run_number, pr.shipment_number, pr.shift, pr.production_date, pr.status,
  sc.code as sku_code, m.code as machine_code, au.full_name as operator
from production_runs pr
left join sku_codes sc on sc.id = pr.sku_code_id
left join production_run_machines prm on prm.production_run_id = pr.id
left join machines m on m.id = prm.machine_id
left join app_users au on au.id = pr.created_by
order by pr.created_at desc
limit 50;
