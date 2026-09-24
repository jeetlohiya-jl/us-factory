-- 2026-09-24 -- RM pallets picked for Material Consumption now free their
-- RM Storage location the moment they're scanned (unconditionally, whether
-- or not they end up marked "fully consumed" -- an operator has physically
-- pulled the pallet off the shelf either way), instead of the location
-- staying occupied until the record is finalized/consumed. This column
-- remembers the released location on each material_consumption_pallets row
-- so removing a mistakenly-scanned pallet from a still-draft record can
-- restore its StorageRecord at that same location (mirrors
-- shipment_picking_picks.location_id's existing remembered-location
-- pattern for the same reason).

alter table material_consumption_pallets
  add column if not exists released_location_id uuid references locations(id);
