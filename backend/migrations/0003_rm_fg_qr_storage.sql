-- RM QR Generation / RM Storage / FG QR Generation / FG Storage — third and
-- fourth pairs of modules. Source of truth for workflow, naming, and record
-- linking is the approved HTML prototype (QR_RECORDS/RM_PENDING_PALLETS/
-- STORAGE_RECORDS/PALLET_LEDGER/FGQR_RECORDS/FG_PENDING_PALLETS/
-- FG_STORAGE_RECORDS, plus the RM_QR_PREFIX map and the shared
-- "US-PLT-<yymm>-<seq>"-style pallet numbering).
--
-- Architecture notes (this migration, not the prototype, is authoritative
-- for how the following are represented in the real DB):
--   * UUIDs are the real primary/foreign keys everywhere. display_id columns
--     are separate, immutable, human-readable identifiers — what appears in
--     the UI, on a printed label, and inside a pallet/location QR code.
--   * RM and FG pallets share one display-ID namespace/prefix (pallet_type
--     distinguishes them) — no separate "FG-" prefix was introduced.
--   * A minimal `production_runs` table is added strictly to give FG QR
--     Generation a real upstream source relationship to auto-populate from,
--     matching the prototype's PROD_RECORDS shape (shipment/batch identity,
--     SKU, version, total FG pallets, status). The full Production/IPQC/
--     Material Allocation modules were not requested and are out of scope.

-- =========================================================================
-- Minimal Production Run source for FG QR Generation
-- =========================================================================
create table if not exists production_runs (
  id uuid primary key default gen_random_uuid(),
  run_number text not null unique,          -- e.g. PR-0001 (prototype's PROD_RECORDS.id)
  shipment_number text,                     -- prototype's rec.shipmentNumber, carried onto FG QR
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  category text not null default 'fgtray',
  total_fg_pallets integer not null default 0,
  shift text,
  status text not null default 'approved',
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

-- =========================================================================
-- Storage locations (RM + FG share one table; zone distinguishes, matching
-- the prototype's FNPGTRAY-/FNPGPAD-/FNPGPOLYBAG-/FNPGCFB-/FNPGGLUE-/FPG-
-- location-code prefixes)
-- =========================================================================
create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  display_id text not null unique,          -- e.g. FNPGTRAY-A03-R12-L02-P01-B
  zone text not null,
  qr_storage_path text,
  qr_public_url text,
  qr_payload text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- =========================================================================
-- QR generation records (RM + FG share one table; qr_type distinguishes).
-- One approved Inward QC -> at most one RM batch. One Production Run -> at
-- most one FG batch. Enforced with partial unique indexes below.
-- =========================================================================
create table if not exists qr_generation_records (
  id uuid primary key default gen_random_uuid(),
  batch_display_id text not null unique,     -- RMQR-0001 / FGQR-0001
  qr_type text not null,                     -- 'rm' | 'fg'
  category text,                             -- rm: tray/pad/polybag/cfb/glue ; fg: production category
  source_inward_qc_id uuid references inward_qc_records(id),
  source_production_run_id uuid references production_runs(id),
  shipment_number text,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  quantity integer not null default 0,
  status text not null default 'pending',    -- 'pending' | 'generated'
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  generated_at timestamptz,
  check (qr_type in ('rm', 'fg'))
);

create unique index if not exists uq_qr_source_inward_qc
  on qr_generation_records(source_inward_qc_id) where source_inward_qc_id is not null;
create unique index if not exists uq_qr_source_production_run
  on qr_generation_records(source_production_run_id) where source_production_run_id is not null;
create index if not exists idx_qr_gen_type_status on qr_generation_records(qr_type, status);

-- =========================================================================
-- Pallets — the individually-numbered units a QR batch produces. Explicit
-- FK relationships everywhere (never resolved by parsing display_id).
-- =========================================================================
create table if not exists pallets (
  id uuid primary key default gen_random_uuid(),
  display_id text not null unique,           -- immutable, human-readable, the QR payload's identity
  pallet_type text not null,                 -- 'rm' | 'fg' — shares the same display-id namespace/prefix
  category text,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  shipment_number text,
  source_qr_generation_id uuid not null references qr_generation_records(id),
  source_inward_qc_id uuid references inward_qc_records(id),
  source_production_run_id uuid references production_runs(id),
  lifecycle_status text not null default 'generated',
  current_location_id uuid references locations(id),
  qr_storage_path text,
  qr_public_url text,
  qr_payload text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pallet_type in ('rm', 'fg')),
  check (lifecycle_status in ('generated','pending_storage','stored','consumed','picked','shipped'))
);

create index if not exists idx_pallets_lifecycle on pallets(pallet_type, lifecycle_status);
create index if not exists idx_pallets_source_qr on pallets(source_qr_generation_id);

-- =========================================================================
-- Pallet lifecycle ledger — full history, mirrors the prototype's
-- PALLET_LEDGER[pallet].history entries (stage + timestamp + metadata).
-- =========================================================================
create table if not exists pallet_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  pallet_id uuid not null references pallets(id) on delete cascade,
  stage text not null,
  metadata jsonb,
  actor_user_id uuid references app_users(id),
  occurred_at timestamptz not null default now()
);

create index if not exists idx_pallet_events_pallet on pallet_lifecycle_events(pallet_id, occurred_at);

-- =========================================================================
-- Storage records (RM + FG share one table; storage_type distinguishes).
-- A pallet may have at most one storage record — a relocation workflow
-- would need its own design; for now, re-storing an already-stored pallet
-- is rejected outright, matching the task's explicit instruction.
-- =========================================================================
create table if not exists storage_records (
  id uuid primary key default gen_random_uuid(),
  storage_type text not null,                -- 'rm' | 'fg'
  pallet_id uuid not null unique references pallets(id) on delete restrict,
  location_id uuid not null references locations(id) on delete restrict,
  source_qr_generation_id uuid not null references qr_generation_records(id),
  source_inward_qc_id uuid references inward_qc_records(id),
  source_production_run_id uuid references production_runs(id),
  stored_by uuid references app_users(id),
  stored_at timestamptz not null default now(),
  check (storage_type in ('rm', 'fg'))
);

create index if not exists idx_storage_type on storage_records(storage_type);
create index if not exists idx_storage_location on storage_records(location_id);

-- =========================================================================
-- Module permissions for the four new modules
-- =========================================================================
insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
values
  ('00000000-0000-0000-0000-000000000001', 'rm_qr_generation', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'rm_qr_generation', true, false, false, false, false, true),
  ('00000000-0000-0000-0000-000000000001', 'rm_storage', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'rm_storage', true, true, false, false, false, true),
  ('00000000-0000-0000-0000-000000000001', 'fg_qr_generation', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'fg_qr_generation', true, false, false, false, false, true),
  ('00000000-0000-0000-0000-000000000001', 'fg_storage', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'fg_storage', true, true, false, false, false, true)
on conflict (user_id, module) do nothing;

-- =========================================================================
-- Seed locations — exact display IDs from the prototype's location pools
-- (STORAGE_SCAN_POOL-equivalent list + FG_LOCATION_SCAN_POOL)
-- =========================================================================
insert into locations (display_id, zone) values
  ('FNPGTRAY-A03-R12-L02-P01-B', 'FNPGTRAY'),
  ('FNPGPAD-A02-R05-L01-P01-A', 'FNPGPAD'),
  ('FNPGTRAY-A02-R01-L01-P01-A', 'FNPGTRAY'),
  ('FNPGTRAY-A02-R02-L01-P01-B', 'FNPGTRAY'),
  ('FNPGTRAY-A03-R05-L01-P01-A', 'FNPGTRAY'),
  ('FNPGTRAY-A04-R03-L01-P02-B', 'FNPGTRAY'),
  ('FNPGPAD-A02-R06-L02-P01-A', 'FNPGPAD'),
  ('FNPGPOLYBAG-A01-R02-L01-P01-A', 'FNPGPOLYBAG'),
  ('FNPGCFB-A01-R03-L01-P01-B', 'FNPGCFB'),
  ('FNPGGLUE-A01-R01-L01-P01-A', 'FNPGGLUE'),
  ('FNPGTRAY-A03-R09-L01-P01-A', 'FNPGTRAY'),
  ('FPG-A01-R01-L01-P01-A', 'FPG'),
  ('FPG-A01-R02-L01-P01-B', 'FPG'),
  ('FPG-A02-R01-L01-P01-A', 'FPG'),
  ('FPG-A02-R03-L02-P01-A', 'FPG')
on conflict (display_id) do nothing;

-- =========================================================================
-- Seed one approved Production Run so FG QR Generation has something to
-- auto-populate from immediately (mirrors the prototype's PR-0001, which
-- backs FGQR-0001 / SKU-3P / V1 / 2 FG pallets).
-- =========================================================================
insert into production_runs (run_number, shipment_number, sku_code_id, sku_version_id, category, total_fg_pallets, shift, status)
select 'PR-0001', 'D45', sc.id, sv.id, 'fgtray', 2, 'Shift A', 'approved'
from sku_codes sc
join sku_versions sv on sv.sku_code_id = sc.id and sv.version = 'V1'
where sc.code = 'SKU-3P'
on conflict (run_number) do nothing;
