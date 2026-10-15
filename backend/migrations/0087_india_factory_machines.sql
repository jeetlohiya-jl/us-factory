-- 0087: add the 11 India Factory machines.
--
-- REQUIRES 0086 (machines.machine_type / machines.target_shots) to be run first.
--
-- Unit: India Factory's internal unit name is 'us_factory' (display name
-- "India Factory"; 'factory' is Gainesville). That is what machines.product
-- holds -- see migration 0048 (check constraint: product in ('factory',
-- 'us_factory')) and the unique index machines_code_key on (product, code).
-- Every row below is inserted with product = 'us_factory' EXPLICITLY, so the
-- result never depends on which unit the SQL Editor session defaults to, and
-- no 'factory' (Gainesville) machine is inserted or touched.
--
-- Idempotent: running it again changes nothing. If a machine with the same
-- code already exists in India Factory, its id, is_active and batch_number
-- are kept as they are; only machine_type / target_shots are set.
-- P1 (Padding) has no target shots specified, so target_shots stays NULL.

insert into machines (product, code, machine_type, target_shots, is_active) values
  ('us_factory', 'LM1',      'lamination',  580, true),
  ('us_factory', 'LM2',      'lamination',  580, true),
  ('us_factory', 'LM3',      'lamination',  580, true),
  ('us_factory', 'LM4',      'lamination',  580, true),
  ('us_factory', 'LM5 FILM', 'lamination',  600, true),
  ('us_factory', 'LM6 SALM', 'lamination',  600, true),
  ('us_factory', 'LM7 SALM', 'lamination',  600, true),
  ('us_factory', 'T1',       'trimming',   1200, true),
  ('us_factory', 'T2',       'trimming',   1200, true),
  ('us_factory', 'T3',       'trimming',   1200, true),
  ('us_factory', 'P1',       'padding',    null, true)
on conflict (product, code) do update
  set machine_type = excluded.machine_type,
      target_shots = excluded.target_shots;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only) -- run after the insert.
-- Expected: 11 rows, each exactly once, with the type / target shown below.
--   LM1-LM4 lamination 580 | LM5 FILM, LM6 SALM, LM7 SALM lamination 600
--   T1-T3 trimming 1200    | P1 padding (target_shots NULL)
-- ---------------------------------------------------------------------------
select code, machine_type, target_shots, is_active, product
from machines
where product = 'us_factory'
  and code in ('LM1','LM2','LM3','LM4','LM5 FILM','LM6 SALM','LM7 SALM','T1','T2','T3','P1')
order by case machine_type when 'lamination' then 1 when 'trimming' then 2 else 3 end, code;

-- Each code exactly once in India Factory (should return 0 rows):
select code, count(*) from machines
where product = 'us_factory'
  and code in ('LM1','LM2','LM3','LM4','LM5 FILM','LM6 SALM','LM7 SALM','T1','T2','T3','P1')
group by code having count(*) <> 1;

-- Gainesville untouched (should return 0 rows -- none of these codes typed/targeted there):
select code, machine_type, target_shots from machines
where product = 'factory' and (machine_type is not null or target_shots is not null);
