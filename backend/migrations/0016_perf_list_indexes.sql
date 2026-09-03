-- Performance follow-up (PERF_AUDIT.md finding #7): every list endpoint
-- that orders by a "when was this created/stored" column had no index on
-- that column. Migrations 0007/0010 already indexed every foreign-key
-- (join/filter) column; this migration is purely about the ORDER BY side
-- of the six unpaginated-turned-paginated lists fixed alongside it
-- (findings #1-#6) -- once a query does `ORDER BY created_at DESC LIMIT
-- 50`, an index lets Postgres walk the index in order and stop after 50
-- rows instead of sorting the whole filtered set (previously spilling to
-- disk for the 17,894-row join in finding #1's EXPLAIN ANALYZE).
--
-- IF NOT EXISTS guards make this safe to re-run.

CREATE INDEX IF NOT EXISTS idx_material_consumptions_created_at
    ON material_consumptions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storage_records_stored_at
    ON storage_records (stored_at DESC);

CREATE INDEX IF NOT EXISTS idx_production_runs_created_at
    ON production_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_qr_generation_records_created_at
    ON qr_generation_records (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inward_qc_records_created_at
    ON inward_qc_records (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inward_vehicle_inspections_created_at
    ON inward_vehicle_inspections (created_at DESC);
