-- Database audit hardening pass (see database-audit.md for the full
-- reasoning behind each change). Every change here is additive or a
-- constraint tightening backed by a check against real data -- nothing
-- drops a column, renames a field, or changes an existing API shape.

-- =========================================================================
-- 1) Missing UNIQUE constraints on shipment numbers
-- =========================================================================
-- Partial (excludes '') because a blank shipment_number is a legitimate
-- in-progress-draft state today: every current blank row in the dev DB is
-- either a not-yet-filled-in manual "tray" draft, or an fgtray QC record
-- that only gets its number once its source Vehicle Inspection is
-- approved. Verified zero real (non-blank) duplicates exist today.

create unique index if not exists uq_ivi_shipment_number
  on inward_vehicle_inspections(shipment_number) where shipment_number != '';

create unique index if not exists uq_qc_shipment_number
  on inward_qc_records(shipment_number) where shipment_number != '';

-- =========================================================================
-- 2) Missing indexes on foreign-key columns
-- =========================================================================

create index if not exists idx_qc_sku_code on inward_qc_records(sku_code_id);
create index if not exists idx_qc_sku_version on inward_qc_records(sku_version_id);

create index if not exists idx_ivi_line_items_sku_code on inward_vehicle_inspection_line_items(sku_code_id);
create index if not exists idx_ivi_line_items_sku_version on inward_vehicle_inspection_line_items(sku_version_id);

create index if not exists idx_ivi_checklist_answers_inspection on inward_vehicle_inspection_checklist_answers(inspection_id);

create index if not exists idx_qc_fgtray_answers_qc on inward_qc_fgtray_criteria_answers(inward_qc_id);
create index if not exists idx_qc_attribute_values_qc on inward_qc_attribute_values(inward_qc_id);

create index if not exists idx_qr_generation_records_sku_version on qr_generation_records(sku_version_id);
create index if not exists idx_production_runs_sku_version on production_runs(sku_version_id);
create index if not exists idx_ipqc_records_sku_version on ipqc_records(sku_version_id);

create index if not exists idx_mc_machine_entries_sku_code on material_consumption_machine_entries(sku_code_id);
create index if not exists idx_mc_machine_entries_sku_version on material_consumption_machine_entries(sku_version_id);

-- =========================================================================
-- 3) Tighten material_consumption_pallets.machine_entry_id to NOT NULL
-- =========================================================================
-- Nullable only because migration 0008 had to add it to an existing table
-- and backfill it in a second step. Every row current code creates always
-- sets it. Defensive backfill first so this is safe even if 0008 hasn't
-- run yet on a given database at the time this runs.

update material_consumption_pallets p
set machine_entry_id = e.id
from material_consumption_machine_entries e
where p.machine_entry_id is null and e.material_consumption_id = p.material_consumption_id;

alter table material_consumption_pallets
  alter column machine_entry_id set not null;

-- =========================================================================
-- 4) vendor_id normalization
-- =========================================================================
-- vendor_name stays exactly as-is everywhere (permanent display snapshot,
-- and the fallback for any row a match can't be found for). vendor_id is
-- new, nullable, and backfilled by matching today's already-a-dropdown
-- vendor_name text back to the vendors row it was actually selected from
-- -- the same (category, name) match the app's own country-resolution
-- code already does at read time (see qr_generation_service.py), just
-- done once here and then kept accurate going forward at write time
-- instead of being re-derived by fuzzy text match on every QR generation.

alter table inward_vehicle_inspections
  add column if not exists vendor_id uuid references vendors(id);
create index if not exists idx_ivi_vendor on inward_vehicle_inspections(vendor_id);

alter table inward_qc_records
  add column if not exists vendor_id uuid references vendors(id);
create index if not exists idx_qc_vendor on inward_qc_records(vendor_id);

-- Backfill: Vehicle Inspection's own category is always the right lookup
-- category (vendor_name was chosen from a dropdown filtered to it).
update inward_vehicle_inspections vi
set vendor_id = v.id
from vendors v
where vi.vendor_id is null
  and vi.vendor_name is not null and vi.vendor_name != ''
  and v.category = vi.category
  and v.name = vi.vendor_name;

-- Backfill: Inward QC's lookup category is its OWN category, EXCEPT for
-- an auto-created fgtray QC record, whose vendor_name was actually chosen
-- on its linked Vehicle Inspection (always category 'tray') -- mirrors
-- the exact nuance already documented in
-- qr_generation_service._resolve_qc_country.
update inward_qc_records qc
set vendor_id = v.id
from vendors v
where qc.vendor_id is null
  and qc.vendor_name is not null and qc.vendor_name != ''
  and v.name = qc.vendor_name
  and v.category = coalesce(
    (select vi.category from inward_vehicle_inspections vi where vi.id = qc.linked_vehicle_inspection_id),
    qc.category
  );
