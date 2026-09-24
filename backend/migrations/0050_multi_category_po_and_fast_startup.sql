-- 1. A PO can hold several categories: category moves from the Goods
--    Receipt header to each container entry. Only a Tray SKU needs its stage
--    chosen (Base Tray / FNP Tray); any other SKU's material IS its
--    category. The header keeps one Vendor (by name).
-- 2. Fast startup: app_bootstrap() returns, in ONE Supabase call, what the
--    app needs before it can draw anything -- the signed-in person's
--    product access (Factory / US Factory) and their user + permissions --
--    replacing three sequential calls to the FastAPI server
--    (/portfolio-access/me and /me, the latter made twice).
-- Additive and re-runnable.

alter table goods_receipt_entries add column if not exists category text;
update goods_receipt_entries e set category = coalesce(g.category, (select category from sku_codes s where s.id = e.sku_code_id))
  from goods_receipts g where e.goods_receipt_id = g.id and e.category is null;

create or replace function gr_detail_json(_id uuid) returns jsonb
  language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', g.id, 'po_number', g.po_number, 'category', g.category,
    'vendor_id', g.vendor_id, 'vendor_name', g.vendor_name,
    'status', g.status, 'created_at', g.created_at, 'updated_at', g.updated_at,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'shipment_number', e.shipment_number, 'category', e.category,
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


create or replace function goods_receipt_save(_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _po text := upper(btrim(coalesce(_payload->>'po_number', '')));
  _ecat text;
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
  select * into _vendor from vendors where id = _vendor_id and product = 'factory';
  if not found then raise exception 'Select a valid Vendor.'; end if;
  if not _as_draft and jsonb_array_length(_entries) = 0 then
    raise exception 'Add at least one container before saving.';
  end if;
  if _any_inwarded then
    if _po <> _gr.po_number or _vendor.name is distinct from _gr.vendor_name then
      raise exception using errcode = '23503', message = 'PO Number and Vendor can''t be changed once a container has been inwarded.';
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
    select * into _sku from sku_codes where id = nullif(_e->>'sku_code_id', '')::uuid and product = 'factory';
    if not found then raise exception '%: select a valid SKU.', _label; end if;
    -- Category per container: a PO can mix materials. Only a Tray SKU
    -- needs its stage chosen (Base Tray / FNP Tray); every other SKU's
    -- material IS its category.
    _ecat := nullif(btrim(coalesce(_e->>'category', '')), '');
    if sku_family(_sku.category) <> 'tray' then _ecat := _sku.category; end if;
    if _ecat is null or _ecat not in ('tray', 'fnp_tray', 'film', 'pad', 'polybag', 'cfb', 'glue') then
      raise exception '%: select Base Tray or FNP Tray for %.', _label, _sku.code;
    end if;
    if sku_family(_sku.category) <> sku_family(_ecat) then
      raise exception '%: SKU % is not a % SKU.', _label, _sku.code, sku_family_label(_ecat);
    end if;
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
    insert into goods_receipts (product, po_number, vendor_id, vendor_name, status, created_by)
      values ('factory', _po, _vendor.id, _vendor.name, 'draft', app_user_id())
      returning * into _gr;
  else
    update goods_receipts set po_number = _po, vendor_id = _vendor.id,
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
      _ecat := case when sku_family(_sku.category) = 'tray' then btrim(_e->>'category') else _sku.category end;
      if _eid is not null then
        update goods_receipt_entries set
          shipment_number = upper(btrim(_e->>'shipment_number')),
          category = _ecat, sku_code_id = _sku.id, sku_version_id = _ver_id,
          sku_code_snapshot = _sku.code, sku_version_snapshot = case when _ver_id is null then null else _ver_label end,
          po_quantity = (_e->>'po_quantity')::numeric, unit = coalesce(_e->>'unit', 'Units'), sort_order = _i
        where id = _eid;
      else
        insert into goods_receipt_entries (
          goods_receipt_id, shipment_number, category, sku_code_id, sku_version_id,
          sku_code_snapshot, sku_version_snapshot, po_quantity, unit, sort_order, status
        ) values (
          _gr.id, upper(btrim(_e->>'shipment_number')), _ecat,
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
  _category := coalesce(_e.category, _gr.category, (select category from sku_codes where id = _e.sku_code_id));

  if _b.id is null then
    insert into qr_generation_records (
      product, batch_display_id, qr_type, category, source_goods_receipt_entry_id, shipment_number,
      sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
      country_code, quantity, status, created_by
    ) values (
      'factory', factory_id_mark() || 'RMQR-' || lpad(factory_next_seq('qr_batch:rm')::text, 4, '0'),
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
      product, display_id, pallet_type, category, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
      shipment_number, source_qr_generation_id, source_goods_receipt_entry_id, lifecycle_status, qr_payload
    ) values (
      'factory', _did, 'rm', _category, _b.sku_code_id, _b.sku_version_id, _b.sku_code_snapshot, _b.sku_version_snapshot,
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



revoke all on function goods_receipt_save(uuid, jsonb) from public;
revoke all on function goods_receipt_generate_pallets(uuid) from public;
grant execute on function goods_receipt_save(uuid, jsonb) to authenticated;
grant execute on function goods_receipt_generate_pallets(uuid) to authenticated;

-- 2. Startup in one call. Same rules as FastAPI's /me (permission row, or
-- view-only when none; keep the module list in sync with app/api/me.py
-- MODULES) and /portfolio-access/me, plus the same self-healing
-- auth_user_id link SupabaseAuthAdapter performs, so RLS keeps working
-- for someone whose first request is this one.
create or replace function app_bootstrap() returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  _sub uuid := nullif(_claims->>'sub', '')::uuid;
  _email text := lower(btrim(coalesce(_claims->>'email', '')));
  _u app_users%rowtype;
  _pa portfolio_access%rowtype;
  _perms jsonb := '{}'::jsonb;
  _m text;
  _p module_permissions%rowtype;
begin
  if _sub is null or _email = '' then
    raise exception using errcode = '42501', message = 'Not signed in.';
  end if;
  select * into _pa from portfolio_access where lower(email) = _email;
  select * into _u from app_users where lower(email) = _email and is_active;
  if _u.id is not null then
    if _u.auth_user_id is distinct from _sub then
      begin
        update app_users set auth_user_id = _sub where id = _u.id;
      exception when unique_violation then
        null;  -- another row already claims this auth user; email matching still works
      end;
    end if;
    foreach _m in array array['inward_vehicle_inspection', 'inward_qc', 'rm_qr_generation', 'rm_storage', 'material_consumption', 'production', 'ipqc', 'rqc', 'fg_qr_generation', 'fg_storage', 'customer_shipment', 'shipment_picking', 'outward_vehicle_inspection', 'machine_downtime', 'goods_receipt', 'factory_rm_storage', 'factory_material_consumption', 'factory_production', 'factory_rqc_fg_qr', 'factory_fg_storage', 'factory_goods_outward']::text[] loop
      select * into _p from module_permissions where user_id = _u.id and module = _m;
      _perms := _perms || jsonb_build_object(_m, case when _p.id is null then
        jsonb_build_object('can_view', true, 'can_create', false, 'can_edit', false, 'can_delete', false, 'can_approve', false, 'can_fill_section', false)
      else
        jsonb_build_object('can_view', _p.can_view, 'can_create', _p.can_create, 'can_edit', _p.can_edit,
                           'can_delete', _p.can_delete, 'can_approve', _p.can_approve, 'can_fill_section', _p.can_fill_section)
      end);
      _p := null;
    end loop;
  end if;
  return jsonb_build_object(
    'portfolio', jsonb_build_object('access_factory', coalesce(_pa.access_factory, false), 'access_us_factory', coalesce(_pa.access_us_factory, false)),
    'me', case when _u.id is null then null else jsonb_build_object(
      'user_id', _u.id, 'email', _u.email, 'full_name', _u.full_name, 'is_admin', coalesce(_u.is_admin, false), 'permissions', _perms) end
  );
end;
$$;
revoke all on function app_bootstrap() from public;
grant execute on function app_bootstrap() to authenticated;
