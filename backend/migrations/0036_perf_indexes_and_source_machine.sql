-- Section 17: Performance re-optimization pass.
--
-- This segment's own new code introduced a genuinely new hot query shape
-- (traceability_service._gather, Section 15) that filters several tables
-- directly by shipment_number -- a column that, on two of those tables,
-- never had an index at all (it was only ever joined-to via FK before, ​
-- never filtered on directly at the top of a query). Same pattern this
-- project's own earlier database-audit.md flagged repeatedly: Postgres
-- never indexes a column just because the app filters on it, and a filter
-- column with no index degrades from an index scan to a full table scan
-- as each table grows -- exactly the class of bug that audit's §4 fixed
-- for FK columns. This migration is the equivalent pass for the shipment_
-- number filter columns the PDF export now depends on, plus the one new
-- FK column (pallets.source_machine_id, Section 11) that child-side-of-FK
-- convention would otherwise miss.
--
-- pallets.shipment_number and qr_generation_records.shipment_number were
-- always present but only ever reached via a join through another table
-- (source_inward_qc_id/source_production_run_id) until traceability_service
-- started filtering on them directly. shipment_picking_requests.shipment_number
-- has the same gap -- idx_sp_requests_shipment (migration 0020) only covers
-- customer_shipment_id, not the shipment_number column traceability_service
-- filters on.
create index if not exists ix_pallets_shipment_number on pallets(shipment_number);
create index if not exists ix_qr_generation_records_shipment_number on qr_generation_records(shipment_number);
create index if not exists ix_shipment_picking_requests_shipment_number on shipment_picking_requests(shipment_number);

-- Child-side FK index for Section 11's new pallets.source_machine_id
-- (migration 0033) -- Postgres never indexes the child side of a FK
-- automatically, and this column is read on every FG Storage detail view
-- and every traceability PDF (Pallet.source_machine joinedload).
create index if not exists ix_pallets_source_machine_id on pallets(source_machine_id);
