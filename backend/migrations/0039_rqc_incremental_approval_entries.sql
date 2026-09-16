-- RQC incremental approval redesign.
--
-- Prior model: RqcRecord carries ONE editable fg_pallets_generated total
-- for the whole shipment, and saving the record as "approved" triggers ONE
-- FG QR Generation batch for that whole total (get_or_create_fg_qr_for_
-- production_run, backed by a partial unique index on
-- qr_generation_records.source_production_run_id -- at most one FG batch
-- per Production Run, ever).
--
-- New model, per explicit task requirements: a shipment's RQC activity can
-- span multiple dates and operators, each approving some number of
-- pallets independently (today Operator A approves 4, tomorrow Operator B
-- approves 3 more, ...) -- never overwriting a prior approval, never one
-- cumulative field as the only record. RqcRecord stays exactly what it
-- already was (one row per Shipment Number, created manually, never
-- recreated per Material Consumption/Production Run -- unchanged). What's
-- new is rqc_approval_entries: a real child table, one row per approval
-- activity, and each entry independently triggers its own FG QR
-- Generation batch for exactly its own approved_pallets -- never the
-- whole-shipment total, never re-triggering/duplicating an earlier
-- entry's already-issued pallets.
--
-- rqc_records.fg_pallets_generated is left in place (not dropped) as a
-- denormalized running total, kept in sync by the application (sum of
-- every entry's approved_pallets) purely for cheap display/backward
-- compatibility with anything still reading it -- rqc_approval_entries is
-- the real source of truth from here on.

-- =========================================================================
-- Production: pallets produced per shift + machine (task section 1)
-- =========================================================================
-- Shift already lives on material_consumptions.shift (shared by every
-- machine entry on that record -- see MaterialConsumptionMachineEntry's
-- own docstring); machine already lives on this same row. So "per shift
-- and per machine" needs exactly one new column here, on the exact same
-- table Production Details/Rejection Classification already use for their
-- own one-column-per-machine data (migrations 0034/0038) -- no new table.
alter table material_consumption_machine_entries add column if not exists pallets_produced integer not null default 0;
comment on column material_consumption_machine_entries.pallets_produced is 'FG pallets actually produced on this machine for this record''s shift (migration 0039). Production''s own count -- distinct from and never overwritten by RQC''s approved_pallets.';

-- =========================================================================
-- RQC: incremental approval entries (task sections 2-6)
-- =========================================================================
create table if not exists rqc_approval_entries (
  id uuid primary key default gen_random_uuid(),
  rqc_record_id uuid not null references rqc_records(id) on delete cascade,
  entry_date text not null,
  operator_user_id uuid references app_users(id),
  approved_pallets integer not null,
  table_person_number text,
  created_at timestamptz not null default now(),
  check (approved_pallets > 0)
);
create index if not exists idx_rqc_approval_entries_record on rqc_approval_entries(rqc_record_id, entry_date);

comment on table rqc_approval_entries is 'One row per incremental RQC approval activity (date + operator + approved pallet count) for a Shipment Number -- never overwritten, never collapsed into one cumulative field. Drives FG QR Generation one entry at a time (see qr_generation_records.source_rqc_approval_entry_id).';

-- Ownership/RLS: same pattern as every other rqc_* child table
-- (0019_rqc_module.sql) -- owned by the service-role connection (writes
-- always go through FastAPI, never direct-Supabase), RLS opened for
-- SELECT only so the browser client's direct reads work.
alter table rqc_approval_entries enable row level security;
grant select on rqc_approval_entries to authenticated;
drop policy if exists rqc_approval_entries_select on rqc_approval_entries;
create policy rqc_approval_entries_select on rqc_approval_entries for select
  using (app_can('rqc', 'view'));

-- Machine allocation now scoped per approval entry, not per whole
-- RqcRecord (task section 5: each entry's own released pallets may have
-- come off a different machine mix than an earlier or later entry).
alter table rqc_machine_allocations add column if not exists rqc_approval_entry_id uuid references rqc_approval_entries(id) on delete cascade;
alter table rqc_machine_allocations drop constraint if exists rqc_machine_allocations_rqc_record_id_machine_id_key;
create unique index if not exists uq_rqc_machine_allocations_entry_machine
  on rqc_machine_allocations(rqc_approval_entry_id, machine_id) where rqc_approval_entry_id is not null;

-- =========================================================================
-- FG QR Generation: one batch per approval entry, not one per Production
-- Run (task sections 3, 4, 6)
-- =========================================================================
alter table qr_generation_records add column if not exists source_rqc_approval_entry_id uuid references rqc_approval_entries(id) on delete set null;
create index if not exists idx_qr_gen_source_rqc_approval_entry on qr_generation_records(source_rqc_approval_entry_id);

comment on column qr_generation_records.source_rqc_approval_entry_id is 'Migration 0039: set for a batch created from one RQC Approval Entry (the current flow). Null for a batch created via the older whole-run path (dev/test manual endpoint, Hold & Release Release action) -- those still exist and still work, scoped separately below.';

-- The old constraint ("at most one FG batch per Production Run, ever") no
-- longer holds -- a run now legitimately gets many FG batches, one per
-- approval entry. Replace it with a narrower partial index that only
-- still applies to the legacy whole-run path (rows with no approval entry
-- attached), so that path keeps its own original one-batch-per-run
-- guarantee, while entry-driven batches get their own uniqueness below.
drop index if exists uq_qr_source_production_run;
create unique index if not exists uq_qr_source_production_run_legacy
  on qr_generation_records(source_production_run_id)
  where source_production_run_id is not null and source_rqc_approval_entry_id is null;

-- The real idempotency guarantee for the new flow (task section 6): at
-- most one FG QR batch per RQC Approval Entry, ever -- re-posting/
-- retrying the same entry finds this existing row instead of creating a
-- duplicate (see qr_generation_service.get_or_create_fg_qr_for_rqc_approval_entry).
-- generate_pallets' own row-lock + status='generated' guard (unchanged)
-- is the second, independent backstop against duplicate pallet creation.
create unique index if not exists uq_qr_source_rqc_approval_entry
  on qr_generation_records(source_rqc_approval_entry_id) where source_rqc_approval_entry_id is not null;

-- =========================================================================
-- Backfill: preserve already-recorded approvals as history
-- =========================================================================
-- Any RqcRecord that already had a positive fg_pallets_generated under the
-- old single-total model gets exactly one synthetic approval entry
-- carrying that same total, dated to when the record was created, so the
-- new ledger view doesn't show 0 total approved for a shipment that
-- genuinely already had approvals recorded pre-migration. This entry is
-- deliberately left UNLINKED from any already-generated FG QR batch
-- (source_rqc_approval_entry_id stays null on those legacy rows) -- it
-- only backfills the RQC-side history, never touches already-issued
-- pallets/QR codes.
insert into rqc_approval_entries (rqc_record_id, entry_date, approved_pallets, table_person_number, created_at)
select r.id, to_char(r.created_at, 'YYYY-MM-DD'), r.fg_pallets_generated, r.table_person_number, r.created_at
from rqc_records r
where coalesce(r.fg_pallets_generated, 0) > 0
  and not exists (select 1 from rqc_approval_entries e where e.rqc_record_id = r.id);
