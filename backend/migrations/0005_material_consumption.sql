-- Material Consumption: records the actual RM pallets an operator scanned
-- and physically picked from RM Storage for production. NEVER FIFO/
-- auto-assignment -- the operator explicitly scans every pallet consumed.
--
-- Architecture notes (see app/db/models.py for the full rationale):
--
-- * Machine master data did not exist anywhere in the app before this
--   migration (confirmed by search -- Machine was only ever a hardcoded
--   MACHINES array duplicated across the prototype's markup). Added here
--   as its own small admin-managed table, exactly like `vendors` in
--   0004_vendors.sql, rather than continuing to hardcode it.
--
-- * production_runs gains `production_date` -- Material Consumption finds
--   or creates a Production Run keyed by (production_date, shift), NOT
--   machine, so multiple Material Consumption records for different
--   machines on the same date+shift attach to the SAME run. A run's
--   machines are tracked in the new production_run_machines join table
--   (a run can span many machines; a machine can appear on many runs).
--
-- * ipqc_records is a new minimal stub, added strictly to give Material
--   Consumption's Production Run a real downstream link for the requested
--   traceability chain (Material Consumption -> Production Run -> IPQC) --
--   mirroring exactly how production_runs itself was previously added as a
--   minimal stub strictly to feed FG QR Generation. A full IPQC module
--   (inspection blocks, pass/fail criteria, shift-incharge workflow, etc.)
--   was not requested and is intentionally not built here. One IPQC record
--   per Production Run (unique constraint) is the dedup mechanism.
--
-- * material_consumption_pallets holds BOTH the primary RM pallets being
--   consumed (role='primary') and the secondary materials (role='cfb' /
--   'pad' / 'glue' / 'polybag') in one table, structured (not a
--   comma-separated string) so a single unique constraint on pallet_id
--   enforces -- at the database level -- that a pallet can never be
--   attached to more than one active Material Consumption record, in any
--   role, at once. Category/SKU/Version are never manually entered on a
--   Material Consumption record; they are established by the first
--   scanned primary pallet and snapshotted, matching the pallet's own
--   snapshot convention.

create table if not exists machines (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table production_runs add column if not exists production_date text;

create table if not exists production_run_machines (
  id uuid primary key default gen_random_uuid(),
  production_run_id uuid not null references production_runs(id) on delete cascade,
  machine_id uuid not null references machines(id),
  unique(production_run_id, machine_id)
);

create table if not exists ipqc_records (
  id uuid primary key default gen_random_uuid(),
  production_run_id uuid not null unique references production_runs(id) on delete cascade,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  shift text,
  production_date text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists material_consumptions (
  id uuid primary key default gen_random_uuid(),
  consumption_date text not null,
  category text, -- 'tray' | 'fgtray', set by the first primary pallet scan
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  machine_id uuid references machines(id),
  shift text,
  start_time text,
  end_time text,
  status text not null default 'draft' check (status in ('draft', 'saved')),
  production_run_id uuid references production_runs(id),
  created_by uuid references app_users(id),
  updated_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ix_material_consumptions_date on material_consumptions(consumption_date);
create index if not exists ix_material_consumptions_status on material_consumptions(status);

create table if not exists material_consumption_pallets (
  id uuid primary key default gen_random_uuid(),
  material_consumption_id uuid not null references material_consumptions(id) on delete cascade,
  role text not null check (role in ('primary', 'cfb', 'pad', 'glue', 'polybag')),
  pallet_id uuid not null unique references pallets(id),
  quantity numeric not null default 1,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ix_mc_pallets_mc_id on material_consumption_pallets(material_consumption_id);

-- Seed module_permissions for the new module, same two dev users as every
-- other module (see 0001_init.sql / 0003_rm_fg_qr_storage.sql).
insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section) values
  ('00000000-0000-0000-0000-000000000001', 'material_consumption', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'material_consumption', true, true, false, false, false, true)
on conflict (user_id, module) do nothing;

-- Seed a couple of machines so the dropdown isn't empty on a fresh install
-- (matches the prototype's MACH-001.. MACH-004, trimmed to a couple).
insert into machines (code) values ('MACH-001'), ('MACH-002'), ('MACH-003'), ('MACH-004')
on conflict (code) do nothing;
