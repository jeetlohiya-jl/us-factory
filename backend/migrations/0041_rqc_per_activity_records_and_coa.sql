-- 2026-09-17: RQC moves from "one record per Shipment Number, with a
-- growing ledger of approval-activity child rows" to "one record per
-- ACTIVITY" -- a fresh batch of pallets tested and (partially) approved on
-- a given date/machine/shift. The same Shipment Number now legitimately
-- gets a brand-new rqc_records row every time more pallets are produced
-- and tested, instead of a new rqc_approval_entries row under one shared
-- record. Nothing already saved is touched or migrated -- existing records
-- and their existing approval-entry ledgers stay exactly as they are and
-- remain fully readable; only new activity from here on uses the new
-- per-record shape.

-- Shipment Number is no longer unique across rqc_records.
alter table rqc_records drop constraint if exists rqc_records_shipment_number_key;
-- Replace it with a plain (non-unique) index -- shipment-based lookups
-- (the IPQC/Production-Run fallback built earlier, and the new
-- COA-by-shipment lookup below) still need to stay fast.
create index if not exists idx_rqc_records_shipment_number on rqc_records (shipment_number);

-- This activity's own Machine/Shift/Number-of-Pallets-Tested (Page 3/Page 2
-- of the new RQC wizard) -- see backend/app/db/models.py's RqcRecord
-- docstring for why these are stored per-record now instead of derived
-- from the linked Production Run.
alter table rqc_records add column if not exists machine_id uuid references machines(id);
alter table rqc_records add column if not exists shift text;
alter table rqc_records add column if not exists pallets_tested integer;

-- COA moves out of the main RQC form into its own flow: one COA record per
-- SHIPMENT (never per activity, never more than one per shipment).
create table if not exists rqc_coa_entries (
  id uuid primary key default gen_random_uuid(),
  shipment_number text not null unique,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same RLS/grant shape as every other rqc_* table (0019_rqc_module.sql) --
-- owned by FastAPI's service role (writes bypass RLS), SELECT opened for
-- the browser client's direct-Supabase reads, gated on the same 'rqc'
-- module permission.
alter table rqc_coa_entries enable row level security;
grant select on rqc_coa_entries to authenticated;
drop policy if exists rqc_coa_entries_select on rqc_coa_entries;
create policy rqc_coa_entries_select on rqc_coa_entries for select
  using (app_can('rqc', 'view'));

-- rqc_coa_observations gains a link to the new per-shipment entry.
-- rqc_record_id stays exactly as it is (still not-null-enforced by any
-- migration, but the ORM model now allows null) -- existing rows keep
-- their existing rqc_record_id link untouched; new rows use
-- rqc_coa_entry_id instead and leave rqc_record_id null.
alter table rqc_coa_observations add column if not exists rqc_coa_entry_id uuid references rqc_coa_entries(id) on delete cascade;
alter table rqc_coa_observations alter column rqc_record_id drop not null;
create unique index if not exists rqc_coa_observations_coa_entry_group_sr_key
  on rqc_coa_observations (rqc_coa_entry_id, coa_group, sr)
  where rqc_coa_entry_id is not null;
