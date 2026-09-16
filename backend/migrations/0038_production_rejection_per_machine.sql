-- Rejection Classification, currently one flat value shared across the
-- whole Production Run (production_runs.rejection_damage / ...), becomes
-- one column PER MACHINE ENTRY -- matching how "Production Details"
-- (weight/pad_type/etc, migration 0034) and the frontend's
-- MachineEntryPanel/PROD_DETAIL_ROWS already give each machine its own
-- column. The user's own words: "based on the number of machines selected
-- we should have those many columns in rejection classification as well,
-- same like production details."
--
-- The six flat production_runs.rejection_* columns are left in place
-- (nothing else reads them after this change -- confirmed by repo-wide
-- search) rather than dropped, both because dropping a column is
-- destructive and because api/production.py's response schema still
-- echoes an aggregate total from that same name for backward
-- compatibility of the API contract; they're just no longer the source of
-- truth for what a save actually stores.
alter table material_consumption_machine_entries add column if not exists rejection_damage numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_misplaced_glue numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_misplaced_pad numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_glue_on_pad numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_pad_placement_direction numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_adhesion_issue numeric not null default 0;

comment on column material_consumption_machine_entries.rejection_damage is 'Per-machine-entry Rejection Classification (migration 0038) -- one Production Run with N machines now has N independently-editable rejection counts per field, replacing the old single flat value on production_runs.';

-- Backfill: preserve any rejection counts already recorded under the old
-- flat production_runs columns. There is no way to know how an existing
-- multi-machine run's flat total should split across its machines, so the
-- whole historical total is placed on that run's EARLIEST machine entry
-- (by sort_order, then created_at) -- the total is preserved and visible
-- somewhere, never silently dropped, rather than guessed at per machine.
-- A run with only one machine entry (the common case) ends up exactly
-- right with no guessing involved at all.
with first_entry as (
  select distinct on (mc.production_run_id)
    mc.production_run_id as run_id,
    e.id as entry_id
  from material_consumption_machine_entries e
  join material_consumptions mc on mc.id = e.material_consumption_id
  where mc.production_run_id is not null
  order by mc.production_run_id, e.sort_order, e.created_at
)
update material_consumption_machine_entries e
set
  rejection_damage = pr.rejection_damage,
  rejection_misplaced_glue = pr.rejection_misplaced_glue,
  rejection_misplaced_pad = pr.rejection_misplaced_pad,
  rejection_glue_on_pad = pr.rejection_glue_on_pad,
  rejection_pad_placement_direction = pr.rejection_pad_placement_direction,
  rejection_adhesion_issue = pr.rejection_adhesion_issue
from first_entry fe
join production_runs pr on pr.id = fe.run_id
where e.id = fe.entry_id
  and (
    pr.rejection_damage <> 0 or pr.rejection_misplaced_glue <> 0 or pr.rejection_misplaced_pad <> 0
    or pr.rejection_glue_on_pad <> 0 or pr.rejection_pad_placement_direction <> 0 or pr.rejection_adhesion_issue <> 0
  );
