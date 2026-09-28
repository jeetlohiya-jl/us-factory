-- Goods Receipt -> Inward Inspection (2026-09-28)
--
-- Factory's Goods Receipt "Inward" action no longer completes the inward
-- directly: it now opens a multi-step Inward Inspection wizard modeled on
-- (and literally reusing) the existing US Factory "Inward Vehicle
-- Inspection" system -- same tables, same service, same photo-upload and
-- checklist components. Only the actual inward (marking the Goods Receipt
-- entry Inwarded, unlocking RM QR Generation) happens once that inspection
-- reaches Approved.
--
-- This is the FIRST time inward_vehicle_inspections is written from the
-- Factory product (it has always been US-Factory-only until now), so it
-- needs the same per-unit separation migration 0048 already gave every
-- other shared root-record table -- it was simply never touched there
-- because Factory had no reason to write to it yet.
--
-- Additive and re-runnable.

-- 1. Product-scope inward_vehicle_inspections exactly like migration 0048
--    did for material_consumptions/production_runs/etc. Evaluated once at
--    migration time (no request context), app_request_product() falls back
--    to 'us_factory' -- so every pre-existing row (all of them are US
--    Factory's own) backfills correctly with no explicit UPDATE needed,
--    same technique 0048 relied on.
alter table inward_vehicle_inspections add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inward_vehicle_inspections_product_check') then
    alter table inward_vehicle_inspections add constraint inward_vehicle_inspections_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists inward_vehicle_inspections_product_scope on inward_vehicle_inspections;
create policy inward_vehicle_inspections_product_scope on inward_vehicle_inspections as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());

-- 2. The link back to the specific Goods Receipt entry this inspection was
--    opened for. Nullable (US Factory's own Vehicle Inspections never set
--    it) and unique (one inspection per entry -- re-clicking "Inward" on
--    the same entry resumes the existing inspection rather than creating a
--    second one, enforced here rather than only in application code).
alter table inward_vehicle_inspections add column if not exists source_goods_receipt_entry_id uuid references goods_receipt_entries(id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inward_vehicle_inspections_source_gr_entry_key') then
    alter table inward_vehicle_inspections add constraint inward_vehicle_inspections_source_gr_entry_key unique (source_goods_receipt_entry_id);
  end if;
end $$;
create index if not exists idx_ivi_source_gr_entry on inward_vehicle_inspections (source_goods_receipt_entry_id) where source_goods_receipt_entry_id is not null;

-- 3. Checklist items become per-unit master data too (same treatment as
--    Vendors/SKU Names/Machines under 0048 point 4) -- Factory's Inward
--    Inspection checklist is a different list from US Factory's own 8
--    items, not a shared one. Existing 8 rows backfill to 'us_factory'
--    explicitly (they predate any product column, and were never anything
--    but US Factory's own).
alter table inward_vehicle_inspection_checklist_items add column if not exists product text not null default 'us_factory';
update inward_vehicle_inspection_checklist_items set product = 'us_factory' where product is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ivi_checklist_items_product_check') then
    alter table inward_vehicle_inspection_checklist_items add constraint ivi_checklist_items_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists ivi_checklist_items_product_scope on inward_vehicle_inspection_checklist_items;
create policy ivi_checklist_items_product_scope on inward_vehicle_inspection_checklist_items as restrictive for select
  using (product = app_request_product());

-- 4. Factory's own 7-item checklist, from the "Vehicle is clean & dry / No
--    objectionable odour / ..." reference sheet. Every item affects status
--    (any NOT OK -> Hold) -- none of them were called out as informational-
--    only, unlike US Factory's own "Vehicle arrived within scheduled time
--    window" (migration 0022).
--
--    This table has no unique constraint on (label, product) -- "on
--    conflict do nothing" (the pattern 0001/0002 used for their own seed
--    inserts) would silently detect no conflict at all and duplicate these
--    7 rows on every re-run, so the guard is an explicit not-exists check
--    instead.
insert into inward_vehicle_inspection_checklist_items (label, sort_order, product, affects_status)
select v.label, v.sort_order, 'factory', true
from (values
  ('Vehicle is clean & dry', 1),
  ('No objectionable odour', 2),
  ('No insects, rodents or signs of pest activity', 3),
  ('No floor damage or contamination risk', 4),
  ('No water leakage', 5),
  ('No rust inside the container / trailer', 6),
  ('No damaged boxes/packages observed', 7)
) as v(label, sort_order)
where not exists (
  select 1 from inward_vehicle_inspection_checklist_items existing
  where existing.product = 'factory' and existing.label = v.label
);
