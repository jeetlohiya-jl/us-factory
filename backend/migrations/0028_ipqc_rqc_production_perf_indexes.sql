-- Performance pass, same "review... missing useful indexes" scope as the
-- original spec, following up on 0016 (which added created_at DESC list
-- indexes for six tables but predates IPQC/RQC, and never covered
-- production_runs' own date/shift filters). Columns below are exactly what
-- frontend/src/lib/api.ts's list functions actually filter/sort by:
--   listIpqcSb: .order(created_at desc), .eq(production_date), .eq(shift), .eq(status)
--   listRqcSb:  .order(created_at desc), .eq(status)
--   listProductionSb: .eq(production_date), .eq(shift)
-- (production_runs.created_at already has an index from 0007.)

create index if not exists idx_ipqc_records_created_at on ipqc_records(created_at desc);
create index if not exists idx_ipqc_records_production_date on ipqc_records(production_date);
create index if not exists idx_ipqc_records_shift on ipqc_records(shift);
create index if not exists idx_ipqc_records_status on ipqc_records(status);

create index if not exists idx_rqc_records_created_at on rqc_records(created_at desc);
create index if not exists idx_rqc_records_status on rqc_records(status);

create index if not exists idx_production_runs_production_date on production_runs(production_date);
create index if not exists idx_production_runs_shift on production_runs(shift);
