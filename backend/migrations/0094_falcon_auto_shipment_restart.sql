-- 0094 -- Falcon AUTO shipment numbers restart at AUTO-0001 (independent of Factory).
--
-- The two units already use separate counters (factory: zoho_auto_shipment,
-- falcon: zoho_auto_shipment_us), so this is not a code bug: Falcon's counter
-- had simply been advanced by earlier/test Zoho syncs. This one-off script
--   1. renumbers the existing Falcon AUTO-#### shipment numbers 0001.. in the
--      order they were created (in every table that stores them, Falcon rows
--      only -- Factory is never touched), and
--   2. resets Falcon's counter so the next one is count+1.
-- Atomic: any error rolls the whole thing back. Safe to re-run (no-op when the
-- numbers are already 0001..N).
--
-- Preview first (read-only):
--   select e.shipment_number, min(e.created_at) from goods_receipt_entries e
--   join goods_receipts g on g.id = e.goods_receipt_id
--   where g.product = 'falcon' and e.shipment_number ~ '^AUTO-[0-9]+$'
--   group by 1 order by 2;
--   select counter_key, next_value from display_id_counters where counter_key like 'factory:zoho_auto_shipment%';

do $$
declare
  _r record;
  _t record;
  _n int := 0;
begin
  create temp table _auto_map on commit drop as
    select old_no,
           'AUTO-' || lpad((row_number() over (order by first_seen, old_no))::text, 4, '0') as new_no
      from (select e.shipment_number as old_no, min(e.created_at) as first_seen
              from goods_receipt_entries e
              join goods_receipts g on g.id = e.goods_receipt_id
             where g.product = 'falcon' and e.shipment_number ~ '^AUTO-[0-9]+$'
             group by e.shipment_number) s;

  select count(*) into _n from _auto_map;

  if exists (select 1 from _auto_map where old_no <> new_no) then
    -- Phase 1: park on a temporary value (avoids unique-index collisions mid-way).
    -- Phase 2: write the final value.
    for _r in select g as phase from generate_series(1,2) g order by g loop
      -- every Falcon-scoped table with a shipment_number column
      for _t in
        select c.table_name from information_schema.columns c
          join information_schema.columns p on p.table_schema = c.table_schema and p.table_name = c.table_name and p.column_name = 'product'
         where c.table_schema = 'public' and c.column_name = 'shipment_number'
           and c.table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
      loop
        if _r.phase = 1 then
          execute format('update %I t set shipment_number = %L || m.old_no from _auto_map m where t.product = ''falcon'' and t.shipment_number = m.old_no and m.old_no <> m.new_no', _t.table_name, 'TMP~');
        else
          execute format('update %I t set shipment_number = m.new_no from _auto_map m where t.product = ''falcon'' and t.shipment_number = %L || m.old_no', _t.table_name, 'TMP~');
        end if;
      end loop;
      -- goods_receipt_entries / inward_qc_records have no product column: go through the Falcon goods receipt
      if _r.phase = 1 then
        update goods_receipt_entries e set shipment_number = 'TMP~' || m.old_no
          from _auto_map m, goods_receipts g
         where g.id = e.goods_receipt_id and g.product = 'falcon' and e.shipment_number = m.old_no and m.old_no <> m.new_no;
        update inward_qc_records q set shipment_number = 'TMP~' || m.old_no
          from _auto_map m, goods_receipt_entries e, goods_receipts g
         where e.id = q.source_goods_receipt_entry_id and g.id = e.goods_receipt_id and g.product = 'falcon'
           and q.shipment_number = m.old_no and m.old_no <> m.new_no;
      else
        update inward_qc_records q set shipment_number = m.new_no
          from _auto_map m, goods_receipt_entries e, goods_receipts g
         where e.id = q.source_goods_receipt_entry_id and g.id = e.goods_receipt_id and g.product = 'falcon'
           and q.shipment_number = 'TMP~' || m.old_no;
        update goods_receipt_entries e set shipment_number = m.new_no
          from _auto_map m, goods_receipts g
         where g.id = e.goods_receipt_id and g.product = 'falcon' and e.shipment_number = 'TMP~' || m.old_no;
      end if;
    end loop;
  end if;

  -- the next Falcon AUTO number will be count + 1 (0001 when there are none)
  insert into display_id_counters (counter_key, next_value)
    values ('factory:zoho_auto_shipment_us', _n + 1)
  on conflict (counter_key) do update set next_value = excluded.next_value;

  raise notice 'Falcon AUTO shipment numbers renumbered: % ; next will be AUTO-%', _n, lpad((_n + 1)::text, 4, '0');
end $$;
