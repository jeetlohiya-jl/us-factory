-- A shift can now span more than one Production Run (2026-09-28): a new
-- Material Consumption record picking up a DIFFERENT Shipment Number
-- during the same date+shift gets its own Production Run and RQC record
-- instead of always folding into the one run for that shift. See
-- find_or_create_production_run in material_consumption_service.py, which
-- now looks up (and creates) runs keyed by (production_date, shift,
-- shipment_number) rather than (production_date, shift) alone.
--
-- 1) Backfill production_runs.shipment_number for existing rows (this
--    column has existed since the very first Production Run migration but
--    was never actually populated by the Material Consumption flow -- only
--    IPQC/RQC/the MC record itself carried a shipment number). Picking any
--    one linked Material Consumption record's shipment number is safe and
--    non-destructive: it doesn't rewrite or split any existing run's
--    history, it only gives old runs a real key so a NEW record for a
--    DIFFERENT shipment number in the same shift correctly gets a fresh
--    run instead of colliding with (or silently reusing) one already
--    associated with unrelated material.
update production_runs pr
set shipment_number = sub.shipment_number
from (
  select distinct on (production_run_id) production_run_id, shipment_number
  from material_consumptions
  where production_run_id is not null and shipment_number is not null and shipment_number != ''
  order by production_run_id, created_at asc
) sub
where pr.id = sub.production_run_id and pr.shipment_number is null;

-- 2) Supporting index for the new (product, production_date, shift,
--    shipment_number) lookup -- same non-unique performance-index
--    convention as idx_production_runs_product_date_shift (migration
--    0048); no DB-level uniqueness enforced here either, matching that
--    existing pattern (find-then-create, not a hard constraint).
create index if not exists idx_production_runs_product_date_shift_shipment
  on production_runs (product, production_date, shift, shipment_number);
