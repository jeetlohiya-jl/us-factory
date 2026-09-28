-- Factory's own Production "Rejection Classification" attribute set is
-- replaced with the 5 items from the "FINISHED GOODS RANDOM QUALITY
-- ASSURANCE PLAN -- PADDED TRAYS" sheet (the same list migration
-- 0001-factory-rqc-padded-trays-plan.patch already added to Factory RQC's
-- own defect classification, for consistency across the two screens):
--   - Foreign material (insects, hair, dust)
--   - Glue strings / glue on side walls
--   - Direction of the pad
--   - Placement / offset of the pad
--   - Stickiness of the pad
--
-- Per explicit direction, this is FACTORY-ONLY: US Factory's existing
-- 6-field Rejection Classification (Damage / Misplaced Glue / Misplaced
-- Pad / Glue on Pad / Pad Placement Direction / Adhesion Issue, migration
-- 0038) is untouched and keeps being read/written exactly as before. Both
-- sets of columns live on the same material_consumption_machine_entries
-- row (that table itself isn't ProductScoped -- it's reached only through
-- its parent material_consumptions -> production_runs.product), so a
-- Factory row only ever gets the 5 new columns written and a US Factory
-- row only ever gets the 6 old ones; a given row's "other" set simply
-- stays 0, same non-destructive coexistence pattern migration 0038 itself
-- used for the even-older flat production_runs.rejection_* columns.
alter table material_consumption_machine_entries add column if not exists rejection_foreign_material numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_glue_strings numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_pad_direction numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_pad_placement numeric not null default 0;
alter table material_consumption_machine_entries add column if not exists rejection_stickiness numeric not null default 0;

comment on column material_consumption_machine_entries.rejection_foreign_material is 'Factory-only Rejection Classification (migration 0065) -- Foreign material (insects, hair, dust). US Factory does not use this column.';
comment on column material_consumption_machine_entries.rejection_glue_strings is 'Factory-only Rejection Classification (migration 0065) -- Glue strings / glue on side walls. US Factory does not use this column.';
comment on column material_consumption_machine_entries.rejection_pad_direction is 'Factory-only Rejection Classification (migration 0065) -- Direction of the pad. US Factory does not use this column.';
comment on column material_consumption_machine_entries.rejection_pad_placement is 'Factory-only Rejection Classification (migration 0065) -- Placement / offset of the pad. US Factory does not use this column.';
comment on column material_consumption_machine_entries.rejection_stickiness is 'Factory-only Rejection Classification (migration 0065) -- Stickiness of the pad. US Factory does not use this column.';

-- Best-effort backfill for Factory's own already-recorded counts, restricted
-- to machine entries belonging to a FACTORY production run (a US Factory
-- run's old 6 columns are left completely alone -- that set is still its
-- real, current data, not something being migrated away from). The old and
-- new attribute sets don't map 1:1; this is a best-effort mapping onto the
-- closest new field, not a guaranteed-accurate reclassification:
--   misplaced_glue + glue_on_pad  -> glue_strings      (both were glue-
--                                                        placement defects)
--   misplaced_pad                -> pad_placement      (direct equivalent)
--   pad_placement_direction      -> pad_direction       (direct equivalent)
--   adhesion_issue                -> stickiness         (direct equivalent)
--   damage                        -> (no honest match; NOT folded into
--                                      foreign_material -- a damaged tray
--                                      and a foreign-material defect are
--                                      different things. Left as historical
--                                      data only in the old rejection_damage
--                                      column, which nothing Factory-facing
--                                      reads any more.)
update material_consumption_machine_entries e
set
  rejection_glue_strings = e.rejection_misplaced_glue + e.rejection_glue_on_pad,
  rejection_pad_placement = e.rejection_misplaced_pad,
  rejection_pad_direction = e.rejection_pad_placement_direction,
  rejection_stickiness = e.rejection_adhesion_issue
from material_consumptions mc
join production_runs pr on pr.id = mc.production_run_id
where e.material_consumption_id = mc.id
  and pr.product = 'factory'
  and (
    e.rejection_misplaced_glue <> 0 or e.rejection_glue_on_pad <> 0 or e.rejection_misplaced_pad <> 0
    or e.rejection_pad_placement_direction <> 0 or e.rejection_adhesion_issue <> 0
  );
