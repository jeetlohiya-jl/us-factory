-- Database optimization pass (spec: "review... redundant indexes"):
-- dropping duplicate indexes found across the schema, none of which add
-- any query plan this app doesn't already have covered elsewhere.
--
-- 1) inward_qc_records.created_at and inward_vehicle_inspections.created_at
--    each ended up with TWO indexes on the exact same single column:
--    idx_qc_created_at (0002) / idx_ivi_created_at (0001) — plain ascending
--    — duplicated by idx_inward_qc_records_created_at /
--    idx_inward_vehicle_inspections_created_at (0016) — created_at DESC,
--    added later specifically to serve `ORDER BY created_at DESC LIMIT 50`
--    list-page queries (see 0016's own comment). A Postgres btree index can
--    already be scanned backward just as cheaply as forward, so the plain
--    ascending index was never actually needed once the DESC one existed
--    (and wasn't needed for anything else either -- nothing in this app
--    queries these tables ordered ascending by created_at). Keep the
--    0016 (DESC) index, which is the one every current list query actually
--    relies on; drop the older duplicate.
--
-- 2) outward_vehicle_inspections.customer_shipment_id has both an explicit
--    index (idx_ovi_customer_shipment, 0021) and the unique constraint
--    outward_vehicle_inspections_customer_shipment_id_key (also 0021, one
--    column, same table) -- a unique constraint always creates its own
--    index, making the explicit one a pure duplicate from the moment both
--    existed. Drop the explicit one; the constraint's index remains and
--    still serves every lookup/join on this column.

drop index if exists idx_qc_created_at;
drop index if exists idx_ivi_created_at;
drop index if exists idx_ovi_customer_shipment;
