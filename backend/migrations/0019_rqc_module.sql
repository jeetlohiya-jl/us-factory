-- RQC (Final Quality Control) module — the quality gate between IPQC and
-- FG QR Generation, per the corrected workflow:
--   Material Consumption -> Production -> IPQC -> RQC -> FG QR Generation -> FG Storage
--
-- Design notes (mirrors 0015_ipqc_module.sql's reasoning exactly, since RQC
-- is structurally the same shape as IPQC -- one record per Production Run,
-- auto-created never manually, with a fixed inspection grid):
-- 1) One RQC record per Production Run (unique constraint on
--    production_run_id) -- auto-created (find-or-create, never duplicated)
--    the moment the relevant Material Consumption record is finalized (see
--    rqc_service.find_or_create_rqc, called from
--    material_consumption_service.finalize() immediately after
--    find_or_create_ipqc). Creation does NOT depend on IPQC's own status --
--    RQC exists as Pending from Material Consumption save onward, and only
--    reaches Approved/Hold via its own save route once its own inspection
--    is completed.
-- 2) No new pallet table and no new FG Packing module: RQC does not touch
--    pallets at all. It reuses Production's own `total_fg_pallets` count
--    (already the source of truth for "how many FG pallets this run
--    produced" -- see ProductionRun) rather than inventing a duplicate
--    RQC-side pallet count. Once RQC is Approved, the existing
--    get_or_create_fg_qr_for_production_run() call (moved here from
--    Production's save route, unchanged otherwise) creates the FG QR
--    Generation record, whose own existing "Generate" step is what
--    creates real per-pallet `pallets` rows -- exactly the same mechanism
--    RM QR Generation already uses, just gated on RQC instead of nothing.
-- 3) Manufacturer/SKU Code/SKU Version/Shipment Number are populated at
--    creation from the Production Run (SKU/shipment) the same way IPQC's
--    own upstream fields are locked in at creation -- never re-entered.
--    Manufacturer has no real upstream source in this app (same as the
--    prototype's own RQC form, a plain text field) so it's seeded with a
--    placeholder and left genuinely user-editable.
-- 4) The 15-item defect grid (4 classification groups: Unacceptable/
--    Critical/Major/Minor, each with its own AQL accept/reject numbers)
--    and the 4 COA parameter tables (Base Material/Functional/Packing/
--    Printing & Labelling) are RQC's own fixed reference data, read
--    directly out of the HTML prototype (RQC_DEFECT_GROUPS/RQC_COA_*) --
--    static, not stored per record, exactly like IPQC_DEFECTS. Only the
--    per-record answers (Defects Found + Remarks per defect_sr; one
--    Observation value per COA parameter) are stored, as real child
--    tables (not a JSON blob), matching ipqc_check_blocks/
--    ipqc_block_defects' own normalized-FK convention.
-- 5) RQC gets its own module scope ('rqc') in module_permissions, seeded
--    here for the two dev users exactly like 0017 did for production/ipqc
--    (real users are granted access through the Users admin screen).

create table if not exists rqc_records (
  id uuid primary key default gen_random_uuid(),
  production_run_id uuid not null unique references production_runs(id) on delete cascade,
  ipqc_record_id uuid references ipqc_records(id),
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  shipment_number text,
  manufacturer text,
  overall_result text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_rqc_records_production_run on rqc_records(production_run_id);

create table if not exists rqc_defect_results (
  id uuid primary key default gen_random_uuid(),
  rqc_record_id uuid not null references rqc_records(id) on delete cascade,
  defect_sr integer not null,
  found numeric,
  remarks text,
  unique(rqc_record_id, defect_sr)
);

create index if not exists idx_rqc_defect_results_record on rqc_defect_results(rqc_record_id);

create table if not exists rqc_coa_observations (
  id uuid primary key default gen_random_uuid(),
  rqc_record_id uuid not null references rqc_records(id) on delete cascade,
  coa_group text not null,  -- 'base' | 'functional' | 'packing' | 'printing'
  sr integer not null,
  observation text,
  unique(rqc_record_id, coa_group, sr)
);

create index if not exists idx_rqc_coa_observations_record on rqc_coa_observations(rqc_record_id);

-- Ownership must match every other transactional table (production_runs,
-- ipqc_records, ...): owned by the same role FastAPI's service connection
-- runs as, so its writes bypass RLS exactly like everywhere else. RLS is
-- enabled below purely to open the SELECT side for the browser client's
-- direct-Supabase list/detail reads.
alter table rqc_records enable row level security;
alter table rqc_defect_results enable row level security;
alter table rqc_coa_observations enable row level security;

grant select on rqc_records to authenticated;
grant select on rqc_defect_results to authenticated;
grant select on rqc_coa_observations to authenticated;

drop policy if exists rqc_records_select on rqc_records;
create policy rqc_records_select on rqc_records for select
  using (app_can('rqc', 'view'));

drop policy if exists rqc_defect_results_select on rqc_defect_results;
create policy rqc_defect_results_select on rqc_defect_results for select
  using (app_can('rqc', 'view'));

drop policy if exists rqc_coa_observations_select on rqc_coa_observations;
create policy rqc_coa_observations_select on rqc_coa_observations for select
  using (app_can('rqc', 'view'));

insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
values
  ('00000000-0000-0000-0000-000000000001', 'rqc', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'rqc', true, false, false, false, false, true)
on conflict (user_id, module) do update set
  can_view = greatest(module_permissions.can_view, excluded.can_view),
  can_create = greatest(module_permissions.can_create, excluded.can_create),
  can_edit = greatest(module_permissions.can_edit, excluded.can_edit),
  can_delete = greatest(module_permissions.can_delete, excluded.can_delete),
  can_approve = greatest(module_permissions.can_approve, excluded.can_approve),
  can_fill_section = greatest(module_permissions.can_fill_section, excluded.can_fill_section);
