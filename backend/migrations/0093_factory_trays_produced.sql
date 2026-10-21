-- 0093 -- Factory Production: record TRAYS produced; pallets produced is worked out from it.
--
-- Production used to ask for "Pallets Produced" directly. For Factory it now asks
-- for Trays Produced per machine, and pallets produced = full pallets =
-- trays produced / Total No. of Pcs/Pallet (rounded DOWN; leftover trays do not make
-- a pallet). pallets_produced stays the single figure RQC and FG QR Generation
-- read -- the server fills it in from the trays figure when a Factory record is saved.
--
-- trays_produced is null on every existing record (and for Falcon, which still
-- enters pallets directly), so nothing already saved changes.
--
-- Run this BEFORE deploying the new frontend: the Production page now reads this column.

alter table material_consumption_machine_entries
  add column if not exists trays_produced integer;

comment on column material_consumption_machine_entries.trays_produced is
  'Factory: trays produced on this machine for this record''s shift (migration 0093). pallets_produced = trays_produced / Total No. of Pcs/Pallet, rounded down. Null = not entered (older records, and Falcon).';

select count(*) as rows_with_column
from information_schema.columns
where table_name = 'material_consumption_machine_entries' and column_name = 'trays_produced';
