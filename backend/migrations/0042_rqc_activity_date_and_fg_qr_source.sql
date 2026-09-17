-- 2026-09-17 -- follow-up to 0041 (RQC per-activity records). Two things
-- missed there:
--
-- 1. rqc_records needs its own "Date" for this activity (Page 3 of the new
--    RQC wizard) -- previously "Date" was only ever read off the linked
--    Production Run's production_date, but that's one value per run while
--    an activity's own date can legitimately differ (and a run can now
--    have many RQC activity records).
alter table rqc_records add column if not exists activity_date text;

-- 2. FG QR Generation needs a trigger keyed directly off ONE RqcRecord (one
--    activity = one FG QR batch, sized to that activity's own Approved
--    Pallets/fg_pallets_generated), same idempotency pattern as migration
--    0039's source_rqc_approval_entry_id -- just one level up, since each
--    RqcRecord is now itself one activity instead of a container for many.
alter table qr_generation_records add column if not exists source_rqc_record_id uuid references rqc_records(id) on delete set null;
create index if not exists idx_qr_gen_source_rqc_record on qr_generation_records(source_rqc_record_id);
comment on column qr_generation_records.source_rqc_record_id is '2026-09-17: set for a batch created from one per-activity RqcRecord (the current flow, see get_or_create_fg_qr_for_rqc_record). Null for a batch created via the older approval-entry ledger (source_rqc_approval_entry_id) or the legacy whole-run path -- those still exist and still work, scoped separately.';

-- Idempotency backstop: at most one FG batch per RqcRecord.
create unique index if not exists uq_qr_source_rqc_record
  on qr_generation_records(source_rqc_record_id) where source_rqc_record_id is not null;
