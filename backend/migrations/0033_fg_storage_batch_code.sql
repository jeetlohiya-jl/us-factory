-- Section 11: FG Storage Batch Code generation.
--
-- Target format (as given in the task): 03170-D401-200725-A-T1-M01
--   03170   = SKU number                       (sku_codes.batch_number)
--   D401    = Shipment Number ("D4") + 2-digit  (derived at generation time,
--             Combo Number ("01"), concatenated  not stored as its own column
--             with NO separating hyphen           -- see qr_generation_service)
--   200725  = Production Date as DDMMYY          (production_runs.production_date)
--   A       = Shift, first letter                (production_runs.shift)
--   T1      = RQC Table/Person Number, "T"+value (rqc_records.table_person_number)
--   M01     = Machine number                     (machines.batch_number)
--
-- The Combo Number (01->44, wraps back to 01, never 45) is scoped per
-- Shipment Number and derived by counting how many previous FG QR
-- Generation batches already used that same shipment number -- see
-- qr_generation_service.py's _next_combo_number -- so it does not need its
-- own persisted counter column.
--
-- SKU number and Machine number are admin-supplied reference data the task
-- says will be "supplied later" -- both columns are nullable text; until
-- populated, batch codes fall back to a clearly-marked placeholder
-- ("00000" / "00") rather than silently omitting the segment, so a batch
-- code is never generated with a missing segment.
alter table sku_codes add column if not exists batch_number text;
comment on column sku_codes.batch_number is 'Admin-supplied 5-digit SKU number used as the first segment of the FG Storage Batch Code (Section 11). Populated later by the business, not derived.';

alter table machines add column if not exists batch_number text;
comment on column machines.batch_number is 'Admin-supplied 2-digit machine number used as the last segment (M<nn>) of the FG Storage Batch Code (Section 11). Populated later by the business, not derived.';

alter table rqc_records add column if not exists table_person_number text;
comment on column rqc_records.table_person_number is 'RQC Table/Person Number -- a brand-new, manually-entered field on the RQC form (never derived from the logged-in user), used as the T<n> segment of the FG Storage Batch Code (Section 11).';

-- Per-machine allocation of "how many of this RQC's FG Pallets Generated
-- came off each machine" -- needed because a Production Run can span more
-- than one machine (production_run_machines), but the Batch Code's Machine
-- segment must name the ONE specific machine that produced each pallet,
-- which the app has never tracked at pallet granularity before. For a
-- single-machine run this table gets exactly one row holding the full
-- fg_pallets_generated count; for a multi-machine run the operator splits
-- the total across machines on the RQC form (sum must equal
-- fg_pallets_generated -- enforced in application code, not a DB
-- constraint, so a still-draft/incomplete split never blocks saving RQC
-- itself).
create table if not exists rqc_machine_allocations (
  id uuid primary key default gen_random_uuid(),
  rqc_record_id uuid not null references rqc_records(id) on delete cascade,
  machine_id uuid not null references machines(id),
  fg_pallets_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (rqc_record_id, machine_id)
);
create index if not exists ix_rqc_machine_allocations_rqc_record_id on rqc_machine_allocations(rqc_record_id);

-- The pallet-level attribution this all exists to support: which machine
-- actually produced THIS pallet, and the finished Batch Code string,
-- computed once at generation time (qr_generation_service.generate_pallets)
-- and stored verbatim -- never recomputed later, so a subsequent change to
-- SKU/Machine number mapping never silently rewrites history for pallets
-- already generated and printed.
alter table pallets add column if not exists source_machine_id uuid references machines(id);
alter table pallets add column if not exists batch_code text;
comment on column pallets.batch_code is 'FG pallets only (Section 11): the full generated Batch Code string, e.g. 03170-D401-200725-A-T1-M01. Computed once at QR generation time and frozen -- never recomputed.';

-- The Combo Number is frozen onto the BATCH (QrGenerationRecord), not just
-- each pallet, purely so it can be displayed on the FG QR Generation screen
-- before/without opening an individual pallet -- every pallet in the same
-- batch shares the same combo number, since it's a property of "this
-- generate-QR action for this shipment number", not of the individual
-- pallet.
alter table qr_generation_records add column if not exists combo_number integer;
comment on column qr_generation_records.combo_number is 'FG batches only (Section 11): the 01-44 (wraps to 01, never 45) Combo Number for this Shipment Number, frozen at generate time.';
