-- Material Consumption: Shipment Number is now entered by the operator up
-- front on Page 1 (alongside Shift), instead of only ever being derived
-- from a scanned primary pallet's own shipment_number after the fact.
-- Nullable and additive -- existing rows are unaffected, and the derive-
-- from-pallet fallback in material_consumption_service.py still applies
-- for any record where this is left blank.
alter table material_consumptions add column if not exists shipment_number text;
