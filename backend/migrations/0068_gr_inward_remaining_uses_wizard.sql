-- "Inward remaining" now follows the same Inward Inspection wizard as a
-- first-time inward (2026-09-28), instead of a bare-bones inline
-- quantity/pallets form that skipped the checklist/photos entirely and
-- inwarded the container directly.
--
-- Migration 0066 gave inward_vehicle_inspections a plain UNIQUE constraint
-- on source_goods_receipt_entry_id: exactly one inspection, ever, per
-- Goods Receipt entry. That was correct while only the FIRST inward went
-- through this table, but it now blocks opening a second inspection for a
-- later "remaining" delivery on the same (already-inwarded) entry.
--
-- Replaced with a partial unique index that only blocks a second
-- CONCURRENT (not yet approved) inspection for the same entry -- once one
-- reaches "approved", the entry is free to open a fresh inspection for its
-- next delivery. Every previously-approved inspection for an entry stays
-- exactly where it was; only entries with more than one delivery ever end
-- up with more than one row here.
--
-- Additive and re-runnable.

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'inward_vehicle_inspections_source_gr_entry_key') then
    alter table inward_vehicle_inspections drop constraint inward_vehicle_inspections_source_gr_entry_key;
  end if;
end $$;

drop index if exists idx_ivi_source_gr_entry;

create unique index if not exists idx_ivi_source_gr_entry_active
  on inward_vehicle_inspections (source_goods_receipt_entry_id)
  where source_goods_receipt_entry_id is not null and status <> 'approved';

create index if not exists idx_ivi_source_gr_entry
  on inward_vehicle_inspections (source_goods_receipt_entry_id)
  where source_goods_receipt_entry_id is not null;
