-- Spec: "Every place where the application records a quantity should also
-- record the unit... Avoid ambiguous quantities such as '100' without a
-- unit." Applied to every quantity field that is genuinely ambiguous on
-- its own (a bare number with no unit baked into the field's meaning).
--
-- Deliberately NOT applied to fields whose name already fixes the unit
-- unambiguously -- adding a redundant "Unit: Pallets" dropdown next to a
-- field literally called "Number of FG Pallets Generated" or
-- "pallets_required" would be exactly the kind of unnecessary UI churn the
-- spec's own "keep the existing UI, don't add complexity for its own sake"
-- guidance warns against. Skipped on that basis: rqc_records.fg_pallets_generated
-- (added migration 0030, "FG Pallets" is the unit), customer_shipment_line_items.pallets_required,
-- production_runs.total_fg_pallets (legacy/display-only as of 0030).
-- material_consumption_pallets.quantity gets its own unit column as part of
-- the Material Consumption partial-consumption rework (a later migration in
-- this same spec), rather than here, since that table is being reworked
-- anyway and doesn't need touching twice.
--
-- Default 'Pallets' everywhere below matches this factory's dominant
-- quantity unit (per the prototype and existing "No. of Pallets" labels
-- throughout) -- existing rows populated with a default rather than left
-- null, so historical records don't suddenly show an ambiguous blank unit.

alter table inward_vehicle_inspection_line_items add column if not exists unit text not null default 'Pallets';
alter table inward_qc_records add column if not exists quantity_unit text not null default 'Pallets';
alter table outward_vehicle_inspections add column if not exists quantity_unit text not null default 'Pallets';
