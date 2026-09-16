-- Moves "Number of FG Pallets Generated" out of Production and into RQC
-- (spec: "Do NOT ask for FG pallets generated in Production anymore. Move
-- this input to the top of the RQC form.").
--
-- production_runs.total_fg_pallets is NOT dropped -- removing it would be
-- a destructive schema change for a column several existing read paths
-- still reference (Production's own read-only display, the dev/test-only
-- POST /production-runs endpoint, ProductionRunOut/ProductionSaveOut). It
-- simply stops being written from Production's save route (see
-- api/production.py) and stops being the value FG QR Generation reads --
-- that's now rqc_records.fg_pallets_generated (see api/rqc.py,
-- qr_generation_service.get_or_create_fg_qr_for_production_run). Keeping
-- both columns but making only one of them writable-from-the-relevant-flow
-- is the "single source of truth, no second conflicting quantity" the spec
-- asks for -- not a second competing input.

alter table rqc_records add column if not exists fg_pallets_generated integer;

comment on column rqc_records.fg_pallets_generated is
  'Authoritative FG pallet count for this run''s FG QR Generation, entered at the top of the RQC form. Supersedes production_runs.total_fg_pallets as of migration 0030 -- see qr_generation_service.get_or_create_fg_qr_for_production_run.';

comment on column production_runs.total_fg_pallets is
  'Legacy/display only as of migration 0030 -- Production no longer collects this input; rqc_records.fg_pallets_generated is now the source of truth for FG QR Generation.';
