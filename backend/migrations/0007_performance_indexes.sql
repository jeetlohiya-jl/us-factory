-- Performance/optimization pass: no duplicate data was found anywhere in
-- the database (every table with a real business-uniqueness rule already
-- has a unique constraint enforcing it -- pallets.display_id,
-- vendors(category,name), sku_codes.code, sku_versions(sku_code_id,version),
-- machines.code, locations.display_id, module_permissions(user_id,module),
-- storage_records.pallet_id, material_consumption_pallets.pallet_id,
-- ipqc_records.production_run_id, qr_generation_records.batch_display_id
-- and its two partial unique indexes on source_inward_qc_id /
-- source_production_run_id -- so this migration adds no new constraints.
--
-- What WAS missing: indexes on several foreign-key columns. Postgres does
-- NOT automatically index a foreign key column the way some other
-- databases do -- only the referenced (parent) side gets an index for
-- free, from its primary key. Every one of these columns is the *child*
-- side of a foreign key with no index of its own, which matters in two
-- concrete ways: (1) deleting a row on the parent side (a SKU, a SKU
-- version, a Location, a Machine) makes Postgres scan every table with a
-- foreign key pointing at it to check nothing references the row being
-- deleted -- without an index that's a full sequential scan of
-- potentially the largest table in the schema (pallets); (2) several real
-- application queries filter directly on these columns (e.g. checking
-- whether a Machine is still referenced by any Material Consumption record
-- before allowing its deletion -- see app/api/machines.py).
--
-- pallets is the table this matters most for: it's the one table every
-- other module (Storage, Material Consumption, QR Generation, Production)
-- joins against, and the one most likely to grow largest over time.

create index if not exists idx_pallets_sku_code on pallets(sku_code_id);
create index if not exists idx_pallets_sku_version on pallets(sku_version_id);
create index if not exists idx_pallets_current_location on pallets(current_location_id);
create index if not exists idx_pallets_source_inward_qc on pallets(source_inward_qc_id);
create index if not exists idx_pallets_source_production_run on pallets(source_production_run_id);

create index if not exists idx_storage_records_source_qr on storage_records(source_qr_generation_id);
create index if not exists idx_storage_records_source_inward_qc on storage_records(source_inward_qc_id);
create index if not exists idx_storage_records_source_production_run on storage_records(source_production_run_id);

create index if not exists idx_material_consumptions_machine on material_consumptions(machine_id);
create index if not exists idx_material_consumptions_sku_code on material_consumptions(sku_code_id);
create index if not exists idx_material_consumptions_production_run on material_consumptions(production_run_id);

create index if not exists idx_qr_generation_records_sku_code on qr_generation_records(sku_code_id);

create index if not exists idx_production_runs_sku_code on production_runs(sku_code_id);

create index if not exists idx_qc_line_item_snapshots_sku_code on inward_qc_line_item_snapshots(sku_code_id);

create index if not exists idx_ipqc_records_sku_code on ipqc_records(sku_code_id);

create index if not exists idx_production_run_machines_machine on production_run_machines(machine_id);
