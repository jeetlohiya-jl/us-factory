-- 0086: Machine type + target shots, and the three SKU-level production
-- attributes / one per-machine-entry value India Factory Production needs.
--
-- SCHEMA ONLY -- adds nullable columns, changes no existing data and no
-- existing behaviour. Safe for both units: Factory (product = 'factory')
-- simply never fills them in, and nothing in Factory's screens reads them.
-- Re-runnable (every statement is "if not exists" / guarded).
--
-- What was missing in the existing schema (inspected before writing this):
--   * machines had only code / is_active / batch_number / product -- no
--     machine type and no target shots (the only existing "target shots" is
--     sku_versions.prod_target_shots, which is per SKU, not per machine).
--   * sku_versions had no Mould Number, Design (Old/New) or Liner Thickness.
--   * material_consumption_machine_entries had no Actual No. of Shots.

-- 1. Machines: type + per-machine target shots ------------------------------
alter table machines add column if not exists machine_type text;
alter table machines add column if not exists target_shots integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'machines_machine_type_check') then
    alter table machines add constraint machines_machine_type_check
      check (machine_type is null or machine_type in ('lamination', 'trimming', 'padding'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'machines_target_shots_check') then
    alter table machines add constraint machines_target_shots_check
      check (target_shots is null or target_shots > 0);
  end if;
end $$;

comment on column machines.machine_type is 'lamination / trimming / padding (nullable: legacy machines have none and behave exactly as before). Drives which Production fields apply to this machine in India Factory.';
comment on column machines.target_shots is 'Target number of shots for this machine (nullable = not specified).';

-- 2. SKU Version reference data (entered once on the SKU Names screen, then
--    auto-populated on every Production record, like prod_weight etc.) ------
alter table sku_versions add column if not exists prod_mould_number text;
alter table sku_versions add column if not exists prod_design text;
alter table sku_versions add column if not exists prod_liner_thickness text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sku_versions_prod_design_check') then
    alter table sku_versions add constraint sku_versions_prod_design_check
      check (prod_design is null or prod_design in ('Old', 'New'));
  end if;
end $$;

comment on column sku_versions.prod_mould_number is 'Mould Number (India Factory Production, lamination machines).';
comment on column sku_versions.prod_design is 'Design: Old / New (India Factory Production, lamination machines).';
comment on column sku_versions.prod_liner_thickness is 'Liner Thickness (India Factory Production, lamination machines).';

-- 3. Actual No. of Shots, entered per machine entry on the Production record
alter table material_consumption_machine_entries add column if not exists actual_shots integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'mcme_actual_shots_check') then
    alter table material_consumption_machine_entries add constraint mcme_actual_shots_check
      check (actual_shots is null or actual_shots >= 0);
  end if;
end $$;

comment on column material_consumption_machine_entries.actual_shots is 'Actual No. of Shots entered on the Production record for this machine (nullable = not entered yet).';
