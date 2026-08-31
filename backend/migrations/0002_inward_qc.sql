-- Inward QC — second module. Source of truth for fields/checklists/sampling
-- plans is the approved HTML prototype (QC_ATTRS, SAMPLING_PLANS, QC_ATTRS.fgtray
-- criteria, MATERIAL_SKU_MAP). This migration expands the inward_qc_records
-- stub from module 1 into the full table and adds the reference/answer
-- tables needed to reproduce the prototype's behaviour with real persistence.

-- =========================================================================
-- Expand inward_qc_records (was a stub with just enough columns to support
-- the Vehicle Inspection -> QC auto-population link)
-- =========================================================================

alter table inward_qc_records
  add column if not exists is_auto_shipment_number boolean not null default false,
  add column if not exists sku_code_id uuid references sku_codes(id),
  add column if not exists sku_version_id uuid references sku_versions(id),
  add column if not exists sku_code_snapshot text,       -- historical: survives sku_codes edits/deletes
  add column if not exists sku_version_snapshot text,
  add column if not exists coa_storage_path text,
  add column if not exists coa_filename text,
  add column if not exists conclusion_or_suggestions text, -- "Suggestions" (pad) / "Conclusion" (polybag/cfb/glue)
  -- sampling plan snapshot, recorded at submit time so later edits to the
  -- reference tiers below never change what a historical record shows:
  add column if not exists sampling_sample_size text,
  add column if not exists sampling_upper_limit text,
  add column if not exists sampling_note text,
  add column if not exists quantity_label text,
  add column if not exists created_by uuid references app_users(id),
  add column if not exists updated_by uuid references app_users(id),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists submitted_at timestamptz;

create index if not exists idx_qc_status on inward_qc_records(status);
create index if not exists idx_qc_category on inward_qc_records(category);
create index if not exists idx_qc_created_at on inward_qc_records(created_at);

-- =========================================================================
-- Tray (fgtray) QC criteria — QC_ATTRS.fgtray in the prototype: a fixed
-- 3-row OK/NOT OK checklist with a free-text remark per row.
-- =========================================================================

create table if not exists inward_qc_fgtray_criteria (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order int not null default 0,
  is_active boolean not null default true
);

create table if not exists inward_qc_fgtray_criteria_answers (
  id uuid primary key default gen_random_uuid(),
  inward_qc_id uuid not null references inward_qc_records(id) on delete cascade,
  criteria_id uuid not null references inward_qc_fgtray_criteria(id),
  answer text,        -- 'ok' | 'not_ok' | null
  remarks text,
  unique(inward_qc_id, criteria_id)
);

-- =========================================================================
-- Manual-category (pad/polybag/cfb/glue) attribute definitions —
-- QC_ATTRS.pad/polybag/cfb/glue in the prototype. Reference data (future
-- Admin console material), seeded here from the prototype's exact values.
-- =========================================================================

create table if not exists inward_qc_attribute_definitions (
  id uuid primary key default gen_random_uuid(),
  category text not null,             -- pad | polybag | cfb | glue
  label text not null,
  field_type text not null,           -- text | number | dropdown
  options_json jsonb,                 -- for dropdown: e.g. ["3 Ply","5 Ply","7 Ply"]
  is_required boolean not null default false,
  sort_order int not null default 0,
  is_active boolean not null default true
);

create index if not exists idx_qc_attr_defs_category on inward_qc_attribute_definitions(category, sort_order);

create table if not exists inward_qc_attribute_values (
  id uuid primary key default gen_random_uuid(),
  inward_qc_id uuid not null references inward_qc_records(id) on delete cascade,
  attribute_definition_id uuid not null references inward_qc_attribute_definitions(id),
  value text,
  unique(inward_qc_id, attribute_definition_id)
);

-- =========================================================================
-- Sampling plan tiers — SAMPLING_PLANS in the prototype. Reference data,
-- but the sample size / upper limit actually applied to a given inspection
-- is snapshotted onto inward_qc_records at submit time (see columns above)
-- so a later change to these tiers never rewrites history.
-- =========================================================================

create table if not exists inward_qc_sampling_plan_tiers (
  id uuid primary key default gen_random_uuid(),
  category text not null,             -- pad | polybag | cfb | glue (fgtray uses a fixed rule, no tiers)
  qty_label text not null,
  min_qty numeric not null default 0,
  max_qty numeric,                    -- null = unbounded (Infinity in the prototype)
  sample_size int not null,
  upper_limit int,                    -- null = "Not specified" in the prototype
  note text,
  sort_order int not null default 0
);

-- =========================================================================
-- Tray QC's own snapshot of the Vehicle Inspection's SKU/Version/Quantity
-- line items, copied at the moment the Tray QC is auto-created so the QC's
-- own historical display never changes even if the Vehicle Inspection is
-- edited later. The live relationship for full traceability is
-- inward_qc_records.linked_vehicle_inspection_id -> inward_vehicle_inspections.
-- =========================================================================

create table if not exists inward_qc_line_item_snapshots (
  id uuid primary key default gen_random_uuid(),
  inward_qc_id uuid not null references inward_qc_records(id) on delete cascade,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  quantity numeric not null default 0,
  sort_order int not null default 0
);

create index if not exists idx_qc_line_item_snapshots_qc on inward_qc_line_item_snapshots(inward_qc_id);

-- =========================================================================
-- Module permissions row for the new module
-- =========================================================================

insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
values
  ('00000000-0000-0000-0000-000000000001', 'inward_qc', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'inward_qc', true, false, false, false, false, true)
on conflict (user_id, module) do nothing;

-- =========================================================================
-- SEED DATA — exact values from the prototype's QC_ATTRS / SAMPLING_PLANS
-- =========================================================================

insert into inward_qc_fgtray_criteria (label, sort_order) values
  ('No damage, deformation or moisture', 1),
  ('Free from dust, stains & foreign matter', 2),
  ('Properly packed & intact', 3)
on conflict do nothing;

insert into inward_qc_attribute_definitions (category, label, field_type, options_json, is_required, sort_order) values
  ('pad', 'Base Material', 'text', null, false, 1),
  ('pad', 'Weight (g)', 'number', null, true, 2),
  ('pad', 'Length (mm) (±2)', 'number', null, true, 3),
  ('pad', 'Width (mm) (±2)', 'number', null, true, 4),
  ('pad', 'Absorption Rate (Normal Water, ml) (±5)', 'number', null, false, 5),
  ('pad', 'Absorption Rate (0.2% Saline Water, ml) (±5)', 'number', null, true, 6),
  ('pad', 'Color (Beige / White)', 'text', null, true, 7),
  ('pad', 'Fold on Pad', 'text', null, true, 8),

  ('polybag', 'Base Material', 'text', null, false, 1),
  ('polybag', 'Weight (Avg.)', 'number', null, true, 2),
  ('polybag', 'Length (mm)', 'number', null, true, 3),
  ('polybag', 'Width (mm)', 'number', null, true, 4),
  ('polybag', 'Width Side Gussets (mm)', 'number', null, true, 5),
  ('polybag', 'Thickness (Microns)', 'number', null, true, 6),
  ('polybag', 'Punch Holes (Units)', 'number', null, true, 7),
  ('polybag', 'Hole Dia. (mm)', 'number', null, true, 8),
  ('polybag', 'Color', 'text', null, true, 9),

  ('cfb', 'Material', 'dropdown', '["3 Ply","5 Ply","7 Ply"]', true, 1),
  ('cfb', 'Length (mm) (±2)', 'number', null, true, 2),
  ('cfb', 'Width (mm) (±2)', 'number', null, true, 3),
  ('cfb', 'Height (mm) (±2)', 'number', null, true, 4),
  ('cfb', 'GSM (±5)', 'number', null, false, 5),
  ('cfb', 'Weight (kg)', 'number', null, false, 6),
  ('cfb', 'Box Type', 'text', null, false, 7),
  ('cfb', 'Artwork/printing', 'text', null, false, 8),
  ('cfb', 'Color (Brown / White)', 'text', null, true, 9),

  ('glue', 'Base Material', 'text', null, false, 1),
  ('glue', 'Viscosity (cP)', 'number', null, true, 2),
  ('glue', 'Solid Content (%)', 'number', null, true, 3),
  ('glue', 'Color', 'text', null, true, 4)
on conflict do nothing;

insert into inward_qc_sampling_plan_tiers (category, qty_label, min_qty, max_qty, sample_size, upper_limit, note, sort_order) values
  ('pad', 'Number of Pallets', 0, 150000, 200, 2, '32 samples for Dimensions/Base Tray Weight testing', 1),
  ('pad', 'Number of Pallets', 150000, 500000, 315, 2, '50 samples for Dimensions/Base Tray Weight testing', 2),
  ('pad', 'Number of Pallets', 500000, null, 500, 2, '80 samples for Dimensions/Base Tray Weight testing', 3),

  ('polybag', 'Lot Size (pcs)', 0, 150000, 500, 22, null, 1),
  ('polybag', 'Lot Size (pcs)', 150000, 500000, 800, 22, null, 2),
  ('polybag', 'Lot Size (pcs)', 500000, null, 1250, 22, null, 3),

  ('cfb', 'Lot Size (pcs)', 0, 280, 32, null, null, 1),
  ('cfb', 'Lot Size (pcs)', 281, 500, 50, null, null, 2),
  ('cfb', 'Lot Size (pcs)', 501, 1200, 80, null, null, 3),
  ('cfb', 'Lot Size (pcs)', 1201, 3200, 125, null, null, 4),
  ('cfb', 'Lot Size (pcs)', 3201, 10000, 200, null, null, 5),

  ('glue', 'Lot Size (units)', 0, 500, 32, null, null, 1),
  ('glue', 'Lot Size (units)', 501, 2000, 80, null, null, 2),
  ('glue', 'Lot Size (units)', 2001, 10000, 125, null, null, 3)
on conflict do nothing;

-- MATERIAL_SKU_MAP from the prototype: fgtray reuses the tray SKU codes
-- (SKU-3P / SKU-3D / SKU-7S). SKU-3P already exists (category 'tray');
-- add the other two tray SKUs referenced by the prototype so fgtray's
-- (snapshotted, not user-picked) SKU list is complete.
insert into sku_codes (code, category, description) values
  ('SKU-3D', 'tray', '3D China tray'),
  ('SKU-7S', 'tray', '7S China tray')
on conflict (code) do nothing;

insert into sku_versions (sku_code_id, version)
select id, v from sku_codes, unnest(array['V1','V2']) as v
where code in ('SKU-3D','SKU-7S')
on conflict do nothing;
