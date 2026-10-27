-- 0102 -- Inventory shows glue in boxes as well as kg.
-- inventory_sources gains pallets_in, boxes_per_pallet, boxes_in and kg_per_box (all null for other materials).
-- Boxes on the floor = quantity (kg) / kg_per_box, summed over the item's source rows, so any later use of the glue
-- (production consumption, an inventory correction) shows up as consumed boxes without extra bookkeeping.
-- Additive and re-runnable. Run after 0101.

alter table inventory_sources add column if not exists pallets_in integer;
alter table inventory_sources add column if not exists boxes_per_pallet integer;
alter table inventory_sources add column if not exists boxes_in integer;
alter table inventory_sources add column if not exists kg_per_box numeric;
