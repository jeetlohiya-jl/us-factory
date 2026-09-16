-- IPQC gets a "+ New Record" manual-creation path, exactly mirroring RQC's
-- own manual-creation migration (0022_rqc_manual_and_ivi_informational.sql):
-- IPQC is no longer strictly "one record per Production Run, auto-created
-- only" -- it can now ALSO be created manually via POST /api/v1/ipqc-records
-- (see ipqc_service.create_ipqc). The existing auto-creation trigger
-- (material_consumption_service.find_or_create_ipqc, fired when a Material
-- Consumption record is finalized) is completely unchanged and remains the
-- dominant path -- this migration only removes the schema-level constraint
-- that made a second (manual, unlinked) IPQC record impossible.
--
-- production_run_id: drop NOT NULL + drop its unique constraint. A manually
-- created record has no Production Run yet (nothing to auto-link to until
-- a matching Shipment Number shows up), and even once one exists, IPQC's
-- true dedup key for the AUTO path remains "one row per Production Run" --
-- that invariant is now enforced by find_or_create_ipqc's own find-before-
-- create query (already how Production Run itself is deduped by date+shift),
-- not by a DB constraint, since a manual record must be allowed to exist
-- with production_run_id null or non-unique (shipment_number may match a
-- run that a manual record from a different flow already claimed).

alter table ipqc_records drop constraint if exists ipqc_records_production_run_id_key;
alter table ipqc_records alter column production_run_id drop not null;

-- Same ON DELETE re-pointing as RQC's equivalent change: a Production Run
-- being deleted should unlink IPQC, not cascade-delete the IPQC record
-- itself, now that an IPQC record's identity is no longer solely "the one
-- record for this run".
alter table ipqc_records drop constraint if exists ipqc_records_production_run_id_fkey;
alter table ipqc_records add constraint ipqc_records_production_run_id_fkey
  foreign key (production_run_id) references production_runs(id) on delete set null;

-- shipment_number already has a non-unique index (0022) -- IPQC keeps no
-- uniqueness constraint on it (unlike RQC/Inward QC/Inward Vehicle
-- Inspection), since more than one manually created IPQC record may
-- legitimately share a shipment_number while upstream data catches up.
