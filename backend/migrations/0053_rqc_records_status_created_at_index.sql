-- 2026-09-24 -- performance investigation (item 10 of the operator feedback
-- batch). rqc_records grew a lot heavier per-shipment after migration 0041
-- moved RQC from one row per shipment to one row per activity, and
-- listRqcSb (frontend/src/lib/api.ts) filters by status AND orders by
-- created_at desc in the same query. 0028 gave each column its own
-- single-column index, but Postgres can only ride one index per query --
-- the common "status = X, newest first" list read forces a sort or a
-- bitmap-heap combine of both indexes once the table outgrows the seeded
-- baseline. A composite index lets that exact query stay index-order with
-- no extra sort step. The old single-column idx_rqc_records_status is left
-- in place (0028) since a status-only filter with no explicit sort, or a
-- covering-index-only count, can still use it more cheaply than the
-- composite.

create index if not exists idx_rqc_records_status_created_at
  on rqc_records(status, created_at desc);
