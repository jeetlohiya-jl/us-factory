-- 0089: Falcon Production -- Daily Quality Checks (Vision Inspection 1 / 2).
-- Source: sheet "Daily Quality Checks Data" (Doc ID CTPL/DQCD/FRM/01).
--
-- SCHEMA ONLY: adds nullable whole-number columns to production_runs. No data
-- changes, no behaviour change for Gainesville ('factory' never fills them in
-- and no Factory screen reads them). Re-runnable. Run it BEFORE deploying the
-- frontend (the Production screen selects these columns directly).
--
-- Entered per production run: for each of VI 1 and VI 2 the Pass and Reject
-- counts, then the Reject Recheck Pass and Reject counts. Everything else on
-- the sheet (Total Checked, Totals, Rejection %) is calculated by the app.
-- NULL = not entered yet (distinct from 0).

alter table production_runs add column if not exists vi1_pass integer;
alter table production_runs add column if not exists vi1_reject integer;
alter table production_runs add column if not exists vi1_recheck_pass integer;
alter table production_runs add column if not exists vi1_recheck_reject integer;
alter table production_runs add column if not exists vi2_pass integer;
alter table production_runs add column if not exists vi2_reject integer;
alter table production_runs add column if not exists vi2_recheck_pass integer;
alter table production_runs add column if not exists vi2_recheck_reject integer;

do $$
declare c text;
begin
  foreach c in array array['vi1_pass','vi1_reject','vi1_recheck_pass','vi1_recheck_reject',
                           'vi2_pass','vi2_reject','vi2_recheck_pass','vi2_recheck_reject'] loop
    if not exists (select 1 from pg_constraint where conname = 'production_runs_' || c || '_check') then
      execute format('alter table production_runs add constraint %I check (%I is null or %I >= 0)',
                     'production_runs_' || c || '_check', c, c);
    end if;
  end loop;
  -- The recheck can only cover pieces that were rejected at that inspection.
  if not exists (select 1 from pg_constraint where conname = 'production_runs_vi1_recheck_within_reject') then
    alter table production_runs add constraint production_runs_vi1_recheck_within_reject
      check (coalesce(vi1_recheck_pass, 0) + coalesce(vi1_recheck_reject, 0) <= coalesce(vi1_reject, 0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_runs_vi2_recheck_within_reject') then
    alter table production_runs add constraint production_runs_vi2_recheck_within_reject
      check (coalesce(vi2_recheck_pass, 0) + coalesce(vi2_recheck_reject, 0) <= coalesce(vi2_reject, 0));
  end if;
end $$;

comment on column production_runs.vi1_pass is 'Vision Inspection 1: pieces passed (Falcon).';
comment on column production_runs.vi1_reject is 'Vision Inspection 1: pieces rejected (Falcon). Total checked = pass + reject.';
comment on column production_runs.vi1_recheck_pass is 'VI 1 Reject Recheck: of the VI 1 rejects, pieces that passed on recheck.';
comment on column production_runs.vi1_recheck_reject is 'VI 1 Reject Recheck: of the VI 1 rejects, pieces still rejected.';
comment on column production_runs.vi2_pass is 'Vision Inspection 2: pieces passed (Falcon).';
comment on column production_runs.vi2_reject is 'Vision Inspection 2: pieces rejected (Falcon). Total checked = pass + reject.';
comment on column production_runs.vi2_recheck_pass is 'VI 2 Reject Check: of the VI 2 rejects, pieces that passed on recheck.';
comment on column production_runs.vi2_recheck_reject is 'VI 2 Reject Check: of the VI 2 rejects, pieces still rejected.';

-- Verification (read-only): expect 8 rows.
select column_name from information_schema.columns
where table_name = 'production_runs' and column_name like 'vi%' order by column_name;
