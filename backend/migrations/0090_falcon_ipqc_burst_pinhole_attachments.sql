-- 0090: Falcon IPQC -- Burst Test, Pinhole Test and file attachments.
--
-- REQUIRES 0088 (the unit key is 'falcon') and 0086/0087 (machines.machine_type
-- and the LM1-LM7 machines). ADDITIVE and re-runnable: new tables only; no
-- existing table, row or policy is changed. Gainesville ('factory') never uses
-- any of this (the app hides it and the API refuses it for that unit), and the
-- product-scope policies below keep the two units' rows apart anyway.
--
-- What is stored
--   * ipqc_burst_tests / ipqc_burst_test_readings   -- one test per sheet, many numbered readings
--   * ipqc_pinhole_tests / ipqc_pinhole_test_readings
--   * ipqc_attachments   -- images / PDF / DOCX, linked to an IPQC record OR a burst test OR a pinhole test
--   * ipqc_test_events   -- one row per create / save / attachment change (who, when, status after)
--
-- Every test is tied to a PRODUCTION RUN (never to a SKU alone) and to one
-- lamination machine (LM1-LM7). SKU / SKU Version / Shift / Run Number are
-- snapshotted from that run at creation, so the record stays readable even if
-- the run's master data later changes.
--
-- Rules enforced in the database as a last line of defence (the API enforces
-- them first, with friendly messages):
--   * machine_code must be LM1..LM7 (e.g. 'LM5 FILM')
--   * status is draft | passed | failed
--   * a test cannot be 'passed' while it has any failed or undetermined reading
--     (fail_count / undetermined_count are maintained by the API on every save)
--   * one test per (unit, client_request_id)  -> a retried / double-clicked
--     create returns the same record instead of a duplicate
--   * test_number is unique per Production Run -> legitimate repeat tests for the
--     same run are allowed and numbered 1, 2, 3 ...
--   * the testing time is the database clock (now()); recorded_by is the signed-in
--     user, set by the API from the login -- never typed in.
--
-- NOT decided here (not established by the source sheets -- see the hand-over notes):
--   * what to do with a burst reading of EXACTLY 16 inHg  (stored as 'undetermined'; a test
--     with such a reading cannot be saved as final)
--   * the pinhole 'dimensions' column that is cut off in the sheet image
--   * the pinhole weight tolerance's reference weight (the +/-1 g is shown as information only)

-- ---------------------------------------------------------------------------
-- Burst Test
-- ---------------------------------------------------------------------------
create table if not exists ipqc_burst_tests (
  id uuid primary key default gen_random_uuid(),
  product text not null default app_request_product(),
  client_request_id uuid not null,
  production_run_id uuid not null references production_runs(id) on delete restrict,
  run_number_snapshot text,
  machine_id uuid not null references machines(id),
  machine_code text not null,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  shift text,
  production_date text,
  test_number integer not null,
  container_number text,
  remarks text,
  status text not null default 'draft',
  fail_count integer not null default 0,
  undetermined_count integer not null default 0,
  tested_at timestamptz not null default now(),
  recorded_by uuid references app_users(id),
  updated_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ipqc_burst_tests_product_check check (product in ('factory', 'falcon')),
  constraint ipqc_burst_tests_status_check check (status in ('draft', 'passed', 'failed')),
  constraint ipqc_burst_tests_machine_check check (machine_code ~ '^LM[1-7]($| )'),
  constraint ipqc_burst_tests_counts_check check (fail_count >= 0 and undetermined_count >= 0),
  constraint ipqc_burst_tests_never_passed_with_failures
    check (status <> 'passed' or (fail_count = 0 and undetermined_count = 0)),
  constraint ipqc_burst_tests_request_key unique (product, client_request_id),
  constraint ipqc_burst_tests_run_number_key unique (production_run_id, test_number)
);
create index if not exists idx_ipqc_burst_tests_run on ipqc_burst_tests(production_run_id);
create index if not exists idx_ipqc_burst_tests_created on ipqc_burst_tests(created_at desc);
create index if not exists idx_ipqc_burst_tests_status on ipqc_burst_tests(status);

create table if not exists ipqc_burst_test_readings (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references ipqc_burst_tests(id) on delete cascade,
  sr integer not null,
  sealing_temp_c numeric,
  sealing_time_s numeric,
  burst_inhg numeric,
  result text,
  constraint ipqc_burst_readings_result_check check (result is null or result in ('pass', 'fail', 'undetermined')),
  constraint ipqc_burst_readings_values_check check (
    (sealing_temp_c is null or sealing_temp_c >= 0) and (sealing_time_s is null or sealing_time_s >= 0)
    and (burst_inhg is null or burst_inhg >= 0)),
  constraint ipqc_burst_readings_sr_key unique (test_id, sr)
);
create index if not exists idx_ipqc_burst_readings_test on ipqc_burst_test_readings(test_id);

-- ---------------------------------------------------------------------------
-- Pinhole Test
-- ---------------------------------------------------------------------------
create table if not exists ipqc_pinhole_tests (
  id uuid primary key default gen_random_uuid(),
  product text not null default app_request_product(),
  client_request_id uuid not null,
  production_run_id uuid not null references production_runs(id) on delete restrict,
  run_number_snapshot text,
  machine_id uuid not null references machines(id),
  machine_code text not null,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  sku_weight_snapshot text,            -- the SKU Version's weight at creation, for reference only
  shift text,
  production_date text,
  test_number integer not null,
  container_number text,               -- the sheet's header shows "Container No."; optional here
  remarks text,
  status text not null default 'draft',
  fail_count integer not null default 0,
  tested_at timestamptz not null default now(),
  recorded_by uuid references app_users(id),
  updated_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ipqc_pinhole_tests_product_check check (product in ('factory', 'falcon')),
  constraint ipqc_pinhole_tests_status_check check (status in ('draft', 'passed', 'failed')),
  constraint ipqc_pinhole_tests_machine_check check (machine_code ~ '^LM[1-7]($| )'),
  constraint ipqc_pinhole_tests_counts_check check (fail_count >= 0),
  constraint ipqc_pinhole_tests_never_passed_with_failures check (status <> 'passed' or fail_count = 0),
  constraint ipqc_pinhole_tests_request_key unique (product, client_request_id),
  constraint ipqc_pinhole_tests_run_number_key unique (production_run_id, test_number)
);
create index if not exists idx_ipqc_pinhole_tests_run on ipqc_pinhole_tests(production_run_id);
create index if not exists idx_ipqc_pinhole_tests_created on ipqc_pinhole_tests(created_at desc);
create index if not exists idx_ipqc_pinhole_tests_status on ipqc_pinhole_tests(status);

create table if not exists ipqc_pinhole_test_readings (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references ipqc_pinhole_tests(id) on delete cascade,
  sr integer not null,
  shot_number text,                    -- Lamination Machine Shot No.
  avg_weight_g numeric,                -- Avg Weight of 10 Trays (g), sheet tolerance +/-1 g
  trays_failed integer,                -- Trays Quantity Failed
  remarks text,                        -- Pinhole Location / Remarks
  result text,
  constraint ipqc_pinhole_readings_result_check check (result is null or result in ('pass', 'fail')),
  constraint ipqc_pinhole_readings_values_check check (
    (avg_weight_g is null or avg_weight_g >= 0) and (trays_failed is null or trays_failed >= 0)),
  constraint ipqc_pinhole_readings_sr_key unique (test_id, sr)
);
create index if not exists idx_ipqc_pinhole_readings_test on ipqc_pinhole_test_readings(test_id);

-- ---------------------------------------------------------------------------
-- Attachments (IPQC record, Burst Test or Pinhole Test) and the audit trail
-- ---------------------------------------------------------------------------
create table if not exists ipqc_attachments (
  id uuid primary key default gen_random_uuid(),
  ipqc_record_id uuid references ipqc_records(id) on delete cascade,
  burst_test_id uuid references ipqc_burst_tests(id) on delete cascade,
  pinhole_test_id uuid references ipqc_pinhole_tests(id) on delete cascade,
  filename text not null,
  content_type text,
  size_bytes integer,
  content_sha256 text,                 -- the same file cannot be attached twice to one record (retry safety)
  storage_path text not null,
  public_url text,
  uploaded_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  constraint ipqc_attachments_one_owner check (num_nonnulls(ipqc_record_id, burst_test_id, pinhole_test_id) = 1)
);
create index if not exists idx_ipqc_attachments_record on ipqc_attachments(ipqc_record_id) where ipqc_record_id is not null;
create index if not exists idx_ipqc_attachments_burst on ipqc_attachments(burst_test_id) where burst_test_id is not null;
create index if not exists idx_ipqc_attachments_pinhole on ipqc_attachments(pinhole_test_id) where pinhole_test_id is not null;
create unique index if not exists ipqc_attachments_record_sha on ipqc_attachments(ipqc_record_id, content_sha256) where ipqc_record_id is not null and content_sha256 is not null;
create unique index if not exists ipqc_attachments_burst_sha on ipqc_attachments(burst_test_id, content_sha256) where burst_test_id is not null and content_sha256 is not null;
create unique index if not exists ipqc_attachments_pinhole_sha on ipqc_attachments(pinhole_test_id, content_sha256) where pinhole_test_id is not null and content_sha256 is not null;

create table if not exists ipqc_test_events (
  id uuid primary key default gen_random_uuid(),
  burst_test_id uuid references ipqc_burst_tests(id) on delete cascade,
  pinhole_test_id uuid references ipqc_pinhole_tests(id) on delete cascade,
  action text not null,                -- created | saved | attachment_added | attachment_removed
  status_after text,
  detail text,
  user_id uuid references app_users(id),
  created_at timestamptz not null default now(),
  constraint ipqc_test_events_one_owner check (num_nonnulls(burst_test_id, pinhole_test_id) = 1)
);
create index if not exists idx_ipqc_test_events_burst on ipqc_test_events(burst_test_id) where burst_test_id is not null;
create index if not exists idx_ipqc_test_events_pinhole on ipqc_test_events(pinhole_test_id) where pinhole_test_id is not null;

-- ---------------------------------------------------------------------------
-- Row-level security: reads go straight from the browser (same as every other
-- module); every write goes through FastAPI's service connection.
-- ---------------------------------------------------------------------------
alter table ipqc_burst_tests enable row level security;
alter table ipqc_burst_test_readings enable row level security;
alter table ipqc_pinhole_tests enable row level security;
alter table ipqc_pinhole_test_readings enable row level security;
alter table ipqc_attachments enable row level security;
alter table ipqc_test_events enable row level security;

grant select on ipqc_burst_tests, ipqc_burst_test_readings, ipqc_pinhole_tests, ipqc_pinhole_test_readings,
  ipqc_attachments, ipqc_test_events to authenticated;

drop policy if exists ipqc_burst_tests_select on ipqc_burst_tests;
create policy ipqc_burst_tests_select on ipqc_burst_tests for select using (app_can('ipqc', 'view'));
drop policy if exists ipqc_burst_tests_product_scope on ipqc_burst_tests;
create policy ipqc_burst_tests_product_scope on ipqc_burst_tests as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());

drop policy if exists ipqc_pinhole_tests_select on ipqc_pinhole_tests;
create policy ipqc_pinhole_tests_select on ipqc_pinhole_tests for select using (app_can('ipqc', 'view'));
drop policy if exists ipqc_pinhole_tests_product_scope on ipqc_pinhole_tests;
create policy ipqc_pinhole_tests_product_scope on ipqc_pinhole_tests as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());

-- Children inherit the parent's unit through the EXISTS (the parent's own policies apply inside it).
drop policy if exists ipqc_burst_readings_select on ipqc_burst_test_readings;
create policy ipqc_burst_readings_select on ipqc_burst_test_readings for select
  using (app_can('ipqc', 'view') and exists (select 1 from ipqc_burst_tests t where t.id = test_id));
drop policy if exists ipqc_pinhole_readings_select on ipqc_pinhole_test_readings;
create policy ipqc_pinhole_readings_select on ipqc_pinhole_test_readings for select
  using (app_can('ipqc', 'view') and exists (select 1 from ipqc_pinhole_tests t where t.id = test_id));
drop policy if exists ipqc_test_events_select on ipqc_test_events;
create policy ipqc_test_events_select on ipqc_test_events for select
  using (app_can('ipqc', 'view') and (
    exists (select 1 from ipqc_burst_tests t where t.id = burst_test_id)
    or exists (select 1 from ipqc_pinhole_tests t where t.id = pinhole_test_id)));
drop policy if exists ipqc_attachments_select on ipqc_attachments;
create policy ipqc_attachments_select on ipqc_attachments for select
  using (app_can('ipqc', 'view') and (
    exists (select 1 from ipqc_records r where r.id = ipqc_record_id)
    or exists (select 1 from ipqc_burst_tests t where t.id = burst_test_id)
    or exists (select 1 from ipqc_pinhole_tests t where t.id = pinhole_test_id)));

comment on table ipqc_burst_tests is 'Falcon IPQC Burst Test (sheet: Burst Test Container wise Record Sheet). One row per test; readings in ipqc_burst_test_readings. Pass > 16 inHg, fail < 16 inHg; exactly 16 is undefined in the source sheet.';
comment on table ipqc_pinhole_tests is 'Falcon IPQC Pinhole Test. One row per test; readings in ipqc_pinhole_test_readings.';
comment on table ipqc_attachments is 'Files (image / PDF / DOCX) attached to an IPQC record, a Burst Test or a Pinhole Test.';

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only). Expect 6 rows, all with relrowsecurity = true:
-- ---------------------------------------------------------------------------
select c.relname, c.relrowsecurity
from pg_class c
where c.relname in ('ipqc_burst_tests','ipqc_burst_test_readings','ipqc_pinhole_tests',
                    'ipqc_pinhole_test_readings','ipqc_attachments','ipqc_test_events')
order by 1;
