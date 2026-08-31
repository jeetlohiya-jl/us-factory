-- Cirkla Factory OS — initial schema
-- Module: Inward Vehicle Inspection (first module). Written to be Supabase/Postgres compatible.
-- RLS policies are included but permissive-by-default for now; the FastAPI layer enforces
-- fine-grained permissions today. Tighten RLS when Supabase Auth (Google OAuth) is wired in.

create extension if not exists "pgcrypto";

-- =========================================================================
-- USERS & PERMISSIONS (minimal foundation — no existing system to reuse yet)
-- =========================================================================
-- This is intentionally the smallest possible user-based permission model:
-- one row per user, one boolean per action per module. Future modules add
-- their own module_permissions columns/rows rather than introducing a new
-- role-based model.

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid, -- maps to Supabase auth.users.id once Google OAuth is wired in
  email text not null unique,
  full_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists module_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  module text not null, -- e.g. 'inward_vehicle_inspection'
  can_view boolean not null default true,
  can_create boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  can_approve boolean not null default false,
  can_fill_section boolean not null default false,
  unique(user_id, module)
);

-- =========================================================================
-- REFERENCE DATA (SKU master) — future Admin console manages these rows.
-- Not built in this task; seeded directly for now.
-- =========================================================================

create table if not exists sku_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  category text not null, -- tray | pad | polybag | cfb | glue
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists sku_versions (
  id uuid primary key default gen_random_uuid(),
  sku_code_id uuid not null references sku_codes(id) on delete cascade,
  version text not null,
  is_active boolean not null default true,
  unique(sku_code_id, version)
);

-- =========================================================================
-- INWARD VEHICLE INSPECTION
-- =========================================================================

create table if not exists inward_vehicle_inspections (
  id uuid primary key default gen_random_uuid(),
  shipment_number text not null,       -- manual for 'tray'; system-generated for others
  is_auto_shipment_number boolean not null default false,
  category text not null,               -- tray | pad | polybag | cfb | glue
  truck_number text,
  container_number text,
  vendor_name text,
  invoice_number text,
  transporter_name text,
  seal_number text,
  total_quantity numeric,               -- derived: sum of line items, editable-locked in UI
  inspection_passed_quantity text,
  remarks text,
  status text not null default 'draft', -- draft | pending | approved | hold
  created_by uuid references app_users(id),
  updated_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ivi_status on inward_vehicle_inspections(status);
create index if not exists idx_ivi_category on inward_vehicle_inspections(category);
create index if not exists idx_ivi_created_at on inward_vehicle_inspections(created_at);

create table if not exists inward_vehicle_inspection_line_items (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inward_vehicle_inspections(id) on delete cascade,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  quantity numeric not null default 0,
  sort_order int not null default 0
);

create index if not exists idx_ivi_line_items_inspection on inward_vehicle_inspection_line_items(inspection_id);

-- image_type: container | truck | seal | condition | damage | empty_container
create table if not exists inward_vehicle_inspection_images (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inward_vehicle_inspections(id) on delete cascade,
  image_type text not null,
  storage_path text not null,          -- path/key within the storage adapter's bucket
  public_url text,                     -- resolved URL for display (may be signed)
  ocr_extracted_value text,            -- raw OCR output, kept for audit even after user edits the field
  ocr_confidence numeric,
  ocr_status text,                     -- not_applicable | success | low_confidence | failed
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_ivi_images_inspection on inward_vehicle_inspection_images(inspection_id, image_type);

create table if not exists inward_vehicle_inspection_checklist_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order int not null default 0,
  is_active boolean not null default true
);

create table if not exists inward_vehicle_inspection_checklist_answers (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inward_vehicle_inspections(id) on delete cascade,
  checklist_item_id uuid not null references inward_vehicle_inspection_checklist_items(id),
  answer text, -- ok | not_ok | null (unanswered)
  unique(inspection_id, checklist_item_id)
);

-- =========================================================================
-- INWARD QC (stub — table only, to support the documented downstream
-- auto-population rule. No Inward QC UI/business logic is built here.)
-- =========================================================================

create table if not exists inward_qc_records (
  id uuid primary key default gen_random_uuid(),
  shipment_number text not null,
  category text not null,
  status text not null default 'pending',
  linked_vehicle_inspection_id uuid references inward_vehicle_inspections(id),
  vendor_name text,
  quantity numeric,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_qc_linked_vehicle_inspection on inward_qc_records(linked_vehicle_inspection_id) where linked_vehicle_inspection_id is not null;

-- =========================================================================
-- SEED DATA
-- =========================================================================

insert into app_users (id, email, full_name, is_active)
values
  ('00000000-0000-0000-0000-000000000001', 'r.fernandez@cirkla.com', 'R. Fernandez', true),
  ('00000000-0000-0000-0000-000000000002', 'staff@cirkla.com', 'S. Staff', true)
on conflict (email) do nothing;

insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
values
  ('00000000-0000-0000-0000-000000000001', 'inward_vehicle_inspection', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'inward_vehicle_inspection', true, false, false, false, false, true)
on conflict (user_id, module) do nothing;

insert into sku_codes (code, category, description) values
  ('SKU-3P', 'tray', '3P China tray'),
  ('SKU-PADINV100', 'pad', 'Soaker pad inventory 100'),
  ('SKU-CFB-01', 'cfb', 'CFB standard'),
  ('SKU-PLYBG-STD', 'polybag', 'Polybag standard'),
  ('SKU-GLUE-01', 'glue', 'Glue standard')
on conflict (code) do nothing;

insert into sku_versions (sku_code_id, version)
select id, v from sku_codes, unnest(array['V1','V2']) as v
on conflict do nothing;

insert into inward_vehicle_inspection_checklist_items (label, sort_order) values
  ('Vehicle arrived within scheduled time window', 1),
  ('Truck number matches gate entry / invoice', 2),
  ('Seal intact and matches invoice seal number', 3),
  ('Container in acceptable physical condition', 4),
  ('No visible pest infestation / contamination', 5),
  ('No visible water damage / dampness', 6),
  ('Packaging condition acceptable on first opening', 7),
  ('Quantity matches invoice / shipment documents', 8)
on conflict do nothing;
