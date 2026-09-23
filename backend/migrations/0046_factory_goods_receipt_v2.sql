-- Factory OS Module 1 -- Goods Receipt, round 2 (on top of 0045).
--
-- 1. Category on the receipt (Base Tray / FNP Tray / Film / Soaker Pad /
--    Polybag / CFB / Glue), chosen first -- same list as US Factory's Inward
--    Vehicle Inspection. Vendor and SKU dropdowns are filtered by it, and it
--    becomes the pallets' category.
-- 2. Each PO line's identifier IS the Shipment Number (HA1, V6, ...): the
--    column is renamed from container_name, and the separate optional
--    "container number" column is dropped (it was never needed).
-- 3. Factory numbering is its own sequence, independent of US Factory:
--    pallets and RM QR batches start at 0001. Both products share the
--    pallets / qr_generation_records tables, whose display ids must be
--    unique across the table, so every Factory id carries the mark returned
--    by factory_id_mark() ("F-") -- e.g. F-CN-PLT-2609-0001, F-RMQR-0001.
-- 4. Pallet QR generation is now ONE Postgres function
--    (goods_receipt_generate_pallets, Supabase RPC): it inserts the pallets
--    and their lifecycle events in a single transaction. No image upload --
--    the browser draws each QR from pallets.qr_payload -- which is what
--    made generation slow, and no FastAPI involvement at all.
--
-- Additive / idempotent, safe to re-run.

-- 1. Category -------------------------------------------------------------
alter table goods_receipts add column if not exists category text;
update goods_receipts g set category = v.category
  from vendors v where g.category is null and v.id = g.vendor_id;

-- 2. Shipment Number is the entry identifier --------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'goods_receipt_entries' and column_name = 'container_name') then
    alter table goods_receipt_entries rename column container_name to shipment_number;
  end if;
end $$;
alter table goods_receipt_entries drop column if exists container_number;
alter index if exists uq_goods_receipt_entries_container_sku rename to uq_goods_receipt_entries_shipment_sku;

-- 3. Factory-only numbering -------------------------------------------------
-- The one place the Factory id mark is defined.
create or replace function factory_id_mark() returns text
  language sql immutable as $$ select 'F-'::text $$;

-- Same atomic counter as US Factory's app/domain/id_counters.next_seq, in
-- its own "factory:" key namespace, so Factory sequences start at 1 and
-- never advance US Factory's (or vice versa).
create or replace function factory_next_seq(_key text) returns integer
  language sql security definer set search_path = public
as $$
  insert into display_id_counters (counter_key, next_value)
  values ('factory:' || _key, 2)
  on conflict (counter_key) do update set next_value = display_id_counters.next_value + 1
  returning next_value - 1;
$$;

-- Same category -> suffix map as pallet_service.CATEGORY_SUFFIX.
create or replace function factory_pallet_suffix(_category text) returns text
  language sql immutable as $$
  select case _category
    when 'pad' then 'PAD' when 'polybag' then 'PB' when 'cfb' then 'CFB' when 'glue' then 'GLUE'
    else 'PLT' end
$$;

-- 4. Functions updated for category + shipment_number -----------------------
create or replace function gr_detail_json(_id uuid) returns jsonb
  language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', g.id, 'po_number', g.po_number, 'category', g.category,
    'vendor_id', g.vendor_id, 'vendor_name', g.vendor_name,
    'status', g.status, 'created_at', g.created_at, 'updated_at', g.updated_at,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'shipment_number', e.shipment_number,
        'sku_code_id', e.sku_code_id, 'sku_version_id', e.sku_version_id,
        'sku_code', e.sku_code_snapshot, 'sku_version', e.sku_version_snapshot,
        'po_quantity', e.po_quantity, 'received_quantity', e.received_quantity, 'unit', e.unit,
        'pallet_count', e.pallet_count, 'status', e.status, 'inwarded_at', e.inwarded_at,
        'qr_batch', (
          select jsonb_build_object('id', q.id, 'batch_display_id', q.batch_display_id, 'status', q.status, 'quantity', q.quantity)
          from qr_generation_records q where q.source_goods_receipt_entry_id = e.id
        )
      ) order by e.sort_order, e.created_at)
      from goods_receipt_entries e where e.goods_receipt_id = g.id
    ), '[]'::jsonb)
  )
  from goods_receipts g where g.id = _id;
$$;

-- _payload: {po_number, category, vendor_id, as_draft, entries: [{id?,
--   shipment_number, sku_code_id, sku_version_id?, po_quantity, unit}]}
create or replace function goods_receipt_save(_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _po text := upper(btrim(coalesce(_payload->>'po_number', '')));
  _category text := nullif(btrim(coalesce(_payload->>'category', '')), '');
  _vendor_id uuid := nullif(_payload->>'vendor_id', '')::uuid;
  _as_draft boolean := coalesce((_payload->>'as_draft')::boolean, false);
  _entries jsonb := coalesce(_payload->'entries', '[]'::jsonb);
  _vendor vendors%rowtype;
  _gr goods_receipts%rowtype;
  _any_inwarded boolean := false;
  _e jsonb; _i int := 0; _label text; _name text;
  _sku sku_codes%rowtype; _ver_id uuid; _ver_label text;
  _qty numeric; _unit text; _eid uuid; _row goods_receipt_entries%rowtype;
  _keys text[] := '{}'; _key text; _constraint text;
begin
  if _id is null then
    if not app_can('goods_receipt', 'create') then
      raise exception using errcode = '42501', message = 'You do not have permission to create Goods Receipts.';
    end if;
  else
    if not app_can('goods_receipt', 'edit') then
      raise exception using errcode = '42501', message = 'You do not have permission to edit Goods Receipts.';
    end if;
    select * into _gr from goods_receipts where id = _id for update;
    if not found then raise exception using errcode = 'P0002', message = 'Goods Receipt not found'; end if;
    _any_inwarded := exists (select 1 from goods_receipt_entries where goods_receipt_id = _id and status = 'inwarded');
    select coalesce(array_agg(upper(btrim(shipment_number)) || '|' || sku_code_id || '|' || coalesce(sku_version_id::text, '')), '{}')
      into _keys from goods_receipt_entries where goods_receipt_id = _id and status = 'inwarded';
  end if;

  if _po = '' then raise exception 'PO Number is required.'; end if;
  if _category is null or _category not in ('tray', 'fnp_tray', 'film', 'pad', 'polybag', 'cfb', 'glue') then
    raise exception 'Select a Category.';
  end if;
  select * into _vendor from vendors where id = _vendor_id;
  if not found then raise exception 'Select a valid Vendor.'; end if;
  if _vendor.category <> _category then raise exception 'The selected Vendor is not set up for this Category.'; end if;
  if not _as_draft and jsonb_array_length(_entries) = 0 then
    raise exception 'Add at least one container before saving.';
  end if;
  if _any_inwarded then
    if _po <> _gr.po_number or _vendor_id is distinct from _gr.vendor_id or _category is distinct from _gr.category then
      raise exception using errcode = '23503', message = 'PO Number, Category and Vendor can''t be changed once a container has been inwarded.';
    end if;
    if _as_draft then
      raise exception using errcode = '23503', message = 'A Goods Receipt with inwarded containers can''t go back to Draft.';
    end if;
  end if;

  -- Validate every entry before writing anything.
  for _e in select * from jsonb_array_elements(_entries) loop
    _i := _i + 1;
    _eid := nullif(_e->>'id', '')::uuid;
    if _eid is not null then
      select * into _row from goods_receipt_entries where id = _eid and goods_receipt_id = _id;
      if not found then raise exception 'An entry in this request doesn''t belong to this Goods Receipt.'; end if;
      if _row.status = 'inwarded' then continue; end if;
    end if;
    _name := upper(btrim(coalesce(_e->>'shipment_number', '')));
    _label := case when _name = '' then 'Row ' || _i else _name end;
    if _name = '' then raise exception '%: Shipment Number is required.', _label; end if;
    select * into _sku from sku_codes where id = nullif(_e->>'sku_code_id', '')::uuid;
    if not found then raise exception '%: select a valid SKU.', _label; end if;
    if _sku.category <> _category then raise exception '%: SKU % is not a % SKU.', _label, _sku.code, _category; end if;
    _ver_id := nullif(_e->>'sku_version_id', '')::uuid;
    if _ver_id is not null then
      if not exists (select 1 from sku_versions where id = _ver_id and sku_code_id = _sku.id) then
        raise exception '%: the SKU Version doesn''t belong to %.', _label, _sku.code;
      end if;
    elsif not _as_draft and exists (select 1 from sku_versions where sku_code_id = _sku.id and is_active) then
      raise exception '%: select a SKU Version for %.', _label, _sku.code;
    end if;
    _qty := nullif(_e->>'po_quantity', '')::numeric;
    if _qty is null or _qty <= 0 then raise exception '%: PO Quantity must be greater than 0.', _label; end if;
    _unit := coalesce(_e->>'unit', 'Units');
    if _unit not in ('Pallets', 'Kgs', 'Units', 'Bags') then raise exception '%: unknown unit ''%''.', _label, _unit; end if;
    _key := _name || '|' || _sku.id || '|' || coalesce(_ver_id::text, '');
    if _key = any(_keys) then raise exception '% with SKU % is listed more than once.', _label, _sku.code; end if;
    _keys := _keys || _key;
  end loop;

  if _id is null then
    insert into goods_receipts (po_number, category, vendor_id, vendor_name, status, created_by)
      values (_po, _category, _vendor.id, _vendor.name, 'draft', app_user_id())
      returning * into _gr;
  else
    update goods_receipts set po_number = _po, category = _category, vendor_id = _vendor.id,
      vendor_name = _vendor.name, updated_at = now()
      where id = _id;
    -- Drop removed pending entries first, so a re-used shipment+SKU on
    -- another row can't trip the unique index mid-save.
    delete from goods_receipt_entries
      where goods_receipt_id = _id and status <> 'inwarded'
        and id not in (
          select nullif(x->>'id', '')::uuid from jsonb_array_elements(_entries) x where nullif(x->>'id', '') is not null
        );
  end if;

  _i := 0;
  for _e in select * from jsonb_array_elements(_entries) loop
    _eid := nullif(_e->>'id', '')::uuid;
    _ver_id := nullif(_e->>'sku_version_id', '')::uuid;
    if _eid is not null and exists (select 1 from goods_receipt_entries where id = _eid and status = 'inwarded') then
      update goods_receipt_entries set sort_order = _i where id = _eid;
    else
      select * into _sku from sku_codes where id = (_e->>'sku_code_id')::uuid;
      select version into _ver_label from sku_versions where id = _ver_id;
      if _eid is not null then
        update goods_receipt_entries set
          shipment_number = upper(btrim(_e->>'shipment_number')),
          sku_code_id = _sku.id, sku_version_id = _ver_id,
          sku_code_snapshot = _sku.code, sku_version_snapshot = case when _ver_id is null then null else _ver_label end,
          po_quantity = (_e->>'po_quantity')::numeric, unit = coalesce(_e->>'unit', 'Units'), sort_order = _i
        where id = _eid;
      else
        insert into goods_receipt_entries (
          goods_receipt_id, shipment_number, sku_code_id, sku_version_id,
          sku_code_snapshot, sku_version_snapshot, po_quantity, unit, sort_order, status
        ) values (
          _gr.id, upper(btrim(_e->>'shipment_number')),
          _sku.id, _ver_id, _sku.code, case when _ver_id is null then null else _ver_label end,
          (_e->>'po_quantity')::numeric, coalesce(_e->>'unit', 'Units'), _i, 'pending'
        );
      end if;
    end if;
    _i := _i + 1;
  end loop;

  perform gr_recompute_status(_gr.id, _as_draft);
  return gr_detail_json(_gr.id);
exception when unique_violation then
  get stacked diagnostics _constraint = constraint_name;
  if _constraint = 'uq_goods_receipts_po_number' then
    raise exception using errcode = '23505', message = 'A Goods Receipt for this PO Number already exists. Open it from the dashboard instead.';
  elsif _constraint in ('uq_goods_receipt_entries_shipment_sku', 'uq_goods_receipt_entries_container_sku') then
    raise exception using errcode = '23505', message = 'The same Shipment Number and SKU is listed more than once.';
  end if;
  raise;
end;
$$;

-- Inward ONE shipment: received quantity / unit / pallets only.
-- _payload: {received_quantity, unit, pallet_count}
create or replace function goods_receipt_inward(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _gid uuid; _gr goods_receipts%rowtype; _row goods_receipt_entries%rowtype;
  _qty numeric; _pallets numeric; _unit text;
begin
  if not app_can('goods_receipt', 'fill_section') then
    raise exception using errcode = '42501', message = 'You do not have permission to inward containers.';
  end if;
  select goods_receipt_id into _gid from goods_receipt_entries where id = _entry_id;
  if not found then raise exception using errcode = 'P0002', message = 'Container entry not found.'; end if;
  select * into _gr from goods_receipts where id = _gid for update;
  if _gr.status = 'draft' then
    raise exception using errcode = '23503', message = 'Save the Goods Receipt (not as a draft) before inwarding containers.';
  end if;
  select * into _row from goods_receipt_entries where id = _entry_id for update;
  if _row.status = 'inwarded' then
    return gr_detail_json(_gid);
  end if;

  _qty := nullif(_payload->>'received_quantity', '')::numeric;
  _pallets := nullif(_payload->>'pallet_count', '')::numeric;
  _unit := coalesce(_payload->>'unit', _row.unit);
  if _pallets is null or _pallets < 1 or _pallets <> trunc(_pallets) then
    raise exception 'Number of Pallets must be a whole number of at least 1.';
  end if;
  if _qty is null or _qty <= 0 then raise exception 'Quantity Received must be greater than 0.'; end if;
  if _unit not in ('Pallets', 'Kgs', 'Units', 'Bags') then raise exception 'Unknown unit ''%''.', _unit; end if;

  update goods_receipt_entries set
    received_quantity = _qty, unit = _unit, pallet_count = _pallets::int,
    status = 'inwarded', inwarded_at = now(), inwarded_by = app_user_id()
  where id = _entry_id;
  update goods_receipts set updated_at = now() where id = _gid;
  perform gr_recompute_status(_gid, false);
  return gr_detail_json(_gid);
end;
$$;

-- Delete -- same rules as 0045, updated for the renamed column.
create or replace function goods_receipt_delete(_id uuid) returns void
  language plpgsql security definer set search_path = public
as $$
declare _names text;
begin
  if not app_can('goods_receipt', 'delete') then
    raise exception using errcode = '42501', message = 'You do not have permission to delete Goods Receipts.';
  end if;
  perform 1 from goods_receipts where id = _id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Goods Receipt not found'; end if;
  select string_agg(shipment_number, ', ' order by sort_order) into _names
    from goods_receipt_entries where goods_receipt_id = _id and status = 'inwarded';
  if _names is not null then
    raise exception using errcode = '23503',
      message = 'This Goods Receipt can''t be deleted: ' || _names || ' already inwarded and linked to RM pallets.';
  end if;
  delete from goods_receipts where id = _id;
end;
$$;

-- 5. Pallet QR generation -- one transaction, milliseconds -----------------
-- Creates (once) the entry's RM QR batch and one pallet per received
-- pallet, each straight into pending_storage with the same lifecycle
-- events and QR payload format as every other RM pallet
-- ({"t":"rm_pallet","id":...,"shipment":...,"sku":...}, which RM Storage /
-- Material Consumption scanning already parse). Idempotent: the entry row
-- lock serializes double clicks, and an already-generated batch is
-- returned as-is. Returns the batch id.
create or replace function goods_receipt_generate_pallets(_entry_id uuid) returns uuid
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _b qr_generation_records%rowtype;
  _country text; _category text; _base text; _yymm text; _did text; _pid uuid; _actor uuid := app_user_id();
begin
  if not app_can('goods_receipt', 'fill_section') then
    raise exception using errcode = '42501', message = 'You do not have permission to generate pallet QRs.';
  end if;
  select * into _e from goods_receipt_entries where id = _entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Container entry not found.'; end if;
  if _e.status <> 'inwarded' then
    raise exception using errcode = '23503', message = 'Inward this container before generating its pallet QRs.';
  end if;
  select * into _b from qr_generation_records where source_goods_receipt_entry_id = _e.id;
  if found and _b.status = 'generated' then
    return _b.id;
  end if;

  select * into _gr from goods_receipts where id = _e.goods_receipt_id;
  _country := upper(coalesce(nullif(btrim((select country from vendors where id = _gr.vendor_id)), ''), 'US'));
  _category := coalesce(_gr.category, (select category from sku_codes where id = _e.sku_code_id));

  if _b.id is null then
    insert into qr_generation_records (
      batch_display_id, qr_type, category, source_goods_receipt_entry_id, shipment_number,
      sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
      country_code, quantity, status, created_by
    ) values (
      factory_id_mark() || 'RMQR-' || lpad(factory_next_seq('qr_batch:rm')::text, 4, '0'),
      'rm', _category, _e.id, _e.shipment_number,
      _e.sku_code_id, _e.sku_version_id, _e.sku_code_snapshot, _e.sku_version_snapshot,
      _country, _e.pallet_count, 'pending', _actor
    ) returning * into _b;
  end if;

  _base := _country || '-' || factory_pallet_suffix(_category);
  _yymm := to_char(now() at time zone 'utc', 'YYMM');
  for _i in 1.._b.quantity loop
    _did := factory_id_mark() || _base || '-' || _yymm || '-' || lpad(factory_next_seq('pallet:' || _base)::text, 4, '0');
    insert into pallets (
      display_id, pallet_type, category, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
      shipment_number, source_qr_generation_id, source_goods_receipt_entry_id, lifecycle_status, qr_payload
    ) values (
      _did, 'rm', _category, _b.sku_code_id, _b.sku_version_id, _b.sku_code_snapshot, _b.sku_version_snapshot,
      _b.shipment_number, _b.id, _e.id, 'pending_storage',
      json_build_object('t', 'rm_pallet', 'id', _did, 'shipment', _b.shipment_number, 'sku', _b.sku_code_snapshot)::text
    ) returning id into _pid;
    insert into pallet_lifecycle_events (pallet_id, stage, metadata, actor_user_id, occurred_at) values
      (_pid, 'generated', jsonb_build_object('source_batch', _b.batch_display_id, 'sku', _b.sku_code_snapshot, 'version', _b.sku_version_snapshot), _actor, now()),
      (_pid, 'pending_storage', jsonb_build_object('sku', _b.sku_code_snapshot), _actor, now() + interval '1 microsecond');
  end loop;

  update qr_generation_records set status = 'generated', generated_at = now() where id = _b.id;
  return _b.id;
end;
$$;

revoke all on function gr_detail_json(uuid) from public;
revoke all on function factory_next_seq(text) from public;
revoke all on function goods_receipt_save(uuid, jsonb) from public;
revoke all on function goods_receipt_inward(uuid, jsonb) from public;
revoke all on function goods_receipt_delete(uuid) from public;
revoke all on function goods_receipt_generate_pallets(uuid) from public;
grant execute on function goods_receipt_save(uuid, jsonb) to authenticated;
grant execute on function goods_receipt_inward(uuid, jsonb) to authenticated;
grant execute on function goods_receipt_delete(uuid) to authenticated;
grant execute on function goods_receipt_generate_pallets(uuid) to authenticated;
