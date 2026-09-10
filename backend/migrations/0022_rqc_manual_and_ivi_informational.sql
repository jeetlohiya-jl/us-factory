-- Two independent changes, batched into one migration since both are small
-- schema corrections to existing modules (no new tables):
--
-- 1) RQC becomes manually-created (via "+ New Record"), keyed on Shipment
--    Number instead of auto-derived 1:1 from Production Run:
--      - production_run_id: drop NOT NULL + drop its unique constraint
--        (RQC is no longer "one record per Production Run" -- it is "one
--        record per Shipment Number", manually created and only
--        best-effort linked to a Production Run when one exists with a
--        matching shipment_number).
--      - shipment_number: was nullable/unconstrained (always auto-filled
--        from the linked IPQC record); now the required, unique,
--        user-entered business key. Existing rows already have it
--        populated (it was always copied from IPQC at creation), so this
--        is a safe NOT NULL + UNIQUE to add.
--      - index on ipqc_records.shipment_number: this is now a genuine
--        lookup path (create_rqc looks up IPQC by shipment_number every
--        time a new RQC record is created), not just a snapshot column.
--
-- 2) Inward Vehicle Inspection's "Vehicle arrived within scheduled time
--    window" checklist question becomes informational-only: its answer
--    must never affect Approved/Hold status or block a record from being
--    considered "complete" for submission. affects_status defaults true
--    (every other checklist item keeps behaving exactly as before) and is
--    set false only for this one seeded row.

alter table rqc_records drop constraint if exists rqc_records_production_run_id_key;
alter table rqc_records alter column production_run_id drop not null;

-- A production_run getting deleted should unlink RQC, not cascade-delete
-- the RQC record itself (RQC's identity is its Shipment Number, not its
-- Production Run link) -- re-point the FK's ON DELETE behavior accordingly.
alter table rqc_records drop constraint if exists rqc_records_production_run_id_fkey;
alter table rqc_records add constraint rqc_records_production_run_id_fkey
  foreign key (production_run_id) references production_runs(id) on delete set null;

update rqc_records set shipment_number = 'RQC-' || id::text where shipment_number is null;
alter table rqc_records alter column shipment_number set not null;
alter table rqc_records add constraint rqc_records_shipment_number_key unique (shipment_number);

create index if not exists idx_ipqc_records_shipment_number on ipqc_records(shipment_number);

alter table inward_vehicle_inspection_checklist_items
  add column if not exists affects_status boolean not null default true;

update inward_vehicle_inspection_checklist_items
  set affects_status = false
  where label = 'Vehicle arrived within scheduled time window';
