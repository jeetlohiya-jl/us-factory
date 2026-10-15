-- 0088: rename the internal unit key us_factory -> falcon (India Factory is now "Falcon")
--
-- Renames the internal unit key 'us_factory' to 'falcon' across the database:
--   * every `product` column's data           ('us_factory' -> 'falcon')
--   * every check constraint that lists the key (dropped, then re-added with the new key)
--   * column defaults that hard-code the key
--   * every function that mentions the key (app_request_product(), the Goods
--     Receipt functions, the Zoho PO upsert, app_bootstrap, ...) -- re-created from
--     their own current definition with the key replaced; grants/owner are kept
--   * the portfolio_access column access_us_factory -> access_falcon
--   * user-visible wording inside those functions' messages: 'US Factory' / 'India Factory' -> Falcon
-- The Gainesville key 'factory' is never touched.
--
-- ALL-OR-NOTHING: it is one transaction, and it ends with a check that raises (and
-- therefore rolls everything back) if ANY row, constraint, default, column or function
-- still mentions the old key. Run it at a quiet moment: it briefly locks each table.
-- Re-runnable: a second run finds nothing to change.
--
-- ORDER: run this in the SQL Editor, THEN deploy the new backend/frontend (see the
-- hand-over notes). The new code and the old code both keep working across the gap,
-- because the database treats any request that is not "factory" as this unit.

begin;

create temp table _rn_cons (tbl text, conname text, def text) on commit drop;
create temp table _rn_trg_tables (tbl text) on commit drop;

do $$
declare
  _old constant text := 'us_factory';
  _new constant text := 'falcon';
  _disp_from constant text[] := array['US Factory', 'India Factory'];
  _disp_to constant text := 'Falcon';
  r record; _def text; _d text; _n int := 0; _hit boolean;
begin
  -- Guard: never rewrite an object whose NAME contains the key.
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
             where ns.nspname = 'public' and p.proname like '%' || _old || '%') then
    raise exception 'A function name contains "%"; refusing to rewrite blindly.', _old;
  end if;

  -- 1. Drop the check constraints that list the old key (remember them to re-add).
  insert into _rn_cons
  select c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid)
  from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_namespace ns on ns.oid = cl.relnamespace
  where ns.nspname = 'public' and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%' || _old || '%';
  for r in select * from _rn_cons loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;

  -- 2. Tables with a product column: pause their user triggers while data moves.
  insert into _rn_trg_tables
  select format('%I.%I', c.table_schema, c.table_name)
  from information_schema.columns c join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.column_name = 'product';
  for r in select tbl from _rn_trg_tables loop
    execute format('alter table %s disable trigger user', r.tbl);
  end loop;

  -- 3. Rename columns that carry the key in their name (e.g. portfolio_access).
  for r in select table_schema, table_name, column_name from information_schema.columns
           where table_schema = 'public' and column_name like '%' || _old || '%' loop
    execute format('alter table %I.%I rename column %I to %I', r.table_schema, r.table_name,
                   r.column_name, replace(r.column_name, _old, _new));
  end loop;

  -- 4. Move the data.
  for r in select tbl from _rn_trg_tables loop
    execute format('update %s set product = %L where product = %L', r.tbl, _new, _old);
  end loop;

  -- 5. Column defaults that hard-code the key.
  for r in select table_schema, table_name, column_name, column_default from information_schema.columns
           where table_schema = 'public' and column_default like '%' || _old || '%' loop
    execute format('alter table %I.%I alter column %I set default %s', r.table_schema, r.table_name,
                   r.column_name, replace(r.column_default, _old, _new));
  end loop;

  -- 6. Re-add the constraints with the new key.
  for r in select * from _rn_cons loop
    execute format('alter table %s add constraint %I %s', r.tbl, r.conname, replace(r.def, _old, _new));
  end loop;

  -- 7. Resume triggers.
  for r in select tbl from _rn_trg_tables loop
    execute format('alter table %s enable trigger user', r.tbl);
  end loop;

  -- 8. Re-create every function that mentions the key (or the old display name).
  for r in
    select p.oid, p.oid::regprocedure::text as sig, p.prosrc
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.prokind = 'f'
      and (p.prosrc like '%' || _old || '%' or exists (select 1 from unnest(_disp_from) d where p.prosrc like '%' || d || '%'))
  loop
    _def := replace(pg_get_functiondef(r.oid), _old, _new);
    foreach _d in array _disp_from loop _def := replace(_def, _d, _disp_to); end loop;
    execute _def;
    _n := _n + 1;
  end loop;
  raise notice 'functions re-created: %', _n;

  -- 9. Final check: nothing may still mention the old key. Raising here rolls ALL of it back.
  if exists (select 1 from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_namespace ns on ns.oid = cl.relnamespace
             where ns.nspname = 'public' and pg_get_constraintdef(c.oid) like '%' || _old || '%') then
    raise exception 'A constraint still mentions %', _old; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and (column_default like '%' || _old || '%' or column_name like '%' || _old || '%')) then
    raise exception 'A column default or name still mentions %', _old; end if;
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
             where ns.nspname = 'public' and p.prosrc like '%' || _old || '%') then
    raise exception 'A function still mentions %', _old; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and coalesce(qual, '') || coalesce(with_check, '') like '%' || _old || '%') then
    raise exception 'A policy still mentions %', _old; end if;
  if exists (select 1 from pg_views where schemaname = 'public' and definition like '%' || _old || '%') then
    raise exception 'A view still mentions %', _old; end if;
  for r in select c.table_name, c.column_name from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
           where c.table_schema = 'public' and c.data_type in ('text', 'character varying') loop
    execute format('select exists (select 1 from public.%I where %I = %L)', r.table_name, r.column_name, _old) into _hit;
    if _hit then raise exception 'Row data still holds "%" in %.%', _old, r.table_name, r.column_name; end if;
  end loop;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only; run after the commit above).
-- ---------------------------------------------------------------------------
-- 1) Rows per unit for the main tables: 'us_factory' must be gone, 'falcon' present.
select 'machines' as tbl, product, count(*) from machines group by product
union all select 'production_runs', product, count(*) from production_runs group by product
union all select 'goods_receipts', product, count(*) from goods_receipts group by product
union all select 'sku_codes', product, count(*) from sku_codes group by product
order by 1, 2;
-- 2) What the unit function now returns for a non-Gainesville request (expect 'falcon'):
select app_request_product();
-- 3) The 11 machines are still there under the new key (expect 11):
select count(*) as machines_in_unit from machines
where product = 'falcon' and code in ('LM1','LM2','LM3','LM4','LM5 FILM','LM6 SALM','LM7 SALM','T1','T2','T3','P1');
-- 4) Gainesville untouched (expect the same counts as before the run):
select count(*) as gainesville_machines from machines where product = 'factory';
