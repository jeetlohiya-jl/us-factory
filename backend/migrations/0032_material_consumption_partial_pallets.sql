-- Section 8: Material Consumption -- partial pallet consumption (no more
-- auto-full-consumption on scan).
--
-- Previously material_consumption_pallets.pallet_id carried a flat UNIQUE
-- constraint, meaning a pallet could be attached to at most one Material
-- Consumption row EVER, across its entire history. Combined with
-- add_primary_pallet always writing quantity=1 and finalize() always
-- emitting a 'consumed' lifecycle event for every attached pallet, that
-- made every primary-pallet scan an implicit "whole pallet, gone forever"
-- action -- exactly the "auto-full-consumption on scan" behaviour this
-- section removes.
--
-- Drop the flat unique constraint so the same physical pallet can be
-- attached across more than one Material Consumption record over time (a
-- later record picking up where an earlier one left off). Uniqueness
-- *while a pallet is still actively claimed* is now enforced in
-- application code instead:
--   - material_consumption_service._assert_not_already_allocated blocks a
--     pallet already scanned into another still-DRAFT (in-progress)
--     record, preventing two operators from double-booking the same
--     physical pickup at the same time.
--   - A pallet whose most recent finalize() marked it fully_consumed has
--     its Pallet.lifecycle_status flipped to 'consumed', which
--     _assert_pallet_available already rejects.
-- A partially-consumed pallet's lifecycle_status is deliberately left at
-- 'stored' (see finalize()), which is what makes it re-scannable later.
alter table material_consumption_pallets drop constraint if exists material_consumption_pallets_pallet_id_key;
create index if not exists ix_material_consumption_pallets_pallet_id on material_consumption_pallets(pallet_id);

-- Each attachment row now records how much of the pallet THIS scan/entry
-- drew (Quantity + Unit, matching the app-wide Quantity+Unit convention
-- from migration 0031) and whether the operator says the pallet is now
-- fully used up. Defaults preserve today's exact behaviour for every
-- existing row, and for secondary materials (cfb/pad/glue/polybag), which
-- keep behaving as "one scan = fully consumed" -- see Section 9 for any
-- change to that.
alter table material_consumption_pallets add column if not exists unit text not null default 'Pallets';
alter table material_consumption_pallets add column if not exists fully_consumed boolean not null default true;

comment on column material_consumption_pallets.unit is
  'Unit the quantity column is measured in (Pallets/Kgs/Units) -- app-wide Quantity+Unit convention, see migration 0031.';
comment on column material_consumption_pallets.fully_consumed is
  'true (default) = this scan finished off the pallet; at finalize() the pallet''s lifecycle_status moves to consumed. false = a partial draw -- the pallet stays stored/available so a later Material Consumption record can keep consuming it.';
