-- 0103 -- Shift Record (Factory / Gainesville only): one entry per shift and machine that records, together,
-- what was consumed (trays, pads, glue ... scanned by RM pallet QR), the FG trays produced, and the scrap.
-- Saving it, in ONE transaction:
--   * marks every fully-used RM pallet consumed (partly-used ones stay in stock), frees their storage locations,
--   * takes the quantities used off Inventory (a negative Inventory line per material, tagged with the record),
--   * works out the FG pallets from the trays produced (trays / Total Pcs per Pallet, as Production does; the last
--     pallet carries any remainder), creates the FG QR batch and the FG pallets (status "generated", ready to print
--     and to be put away in FG Storage),
--   * records who saved it and when.
-- It is standalone: it does not create RM Requisition or Production records.
-- shift_record_delete() reverses a record that has not been used further (its FG pallets still only "generated").
-- Additive and re-runnable. Run after 0102.

-- 1. tables -------------------------------------------------------------------
create table if not exists shift_records (
  id uuid primary key default gen_random_uuid(),
  product text not null default app_request_product(),
  display_id text not null,
  record_date date not null,
  shift text not null,
  machine_id uuid references machines(id),
  shipment_number text,
  fg_sku_code_id uuid references sku_codes(id),
  fg_sku_version_id uuid references sku_versions(id),
  fg_sku_code_snapshot text,
  fg_sku_version_snapshot text,
  trays_produced integer not null default 0,
  total_pcs_per_pallet integer,
  fg_pallets integer not null default 0,
  scrap_trays integer not null default 0,
  notes text,
  qr_generation_id uuid references qr_generation_records(id) on delete set null,
  recorded_by uuid references app_users(id) default app_user_id(),
  recorded_at timestamptz not null default now(),
  client_time text,
  created_at timestamptz not null default now(),
  unique (product, display_id)
);
create index if not exists idx_shift_records_date on shift_records (record_date desc, created_at desc);

create table if not exists shift_record_materials (
  id uuid primary key default gen_random_uuid(),
  shift_record_id uuid not null references shift_records(id) on delete cascade,
  sort_order integer not null default 0,
  sku_code_id uuid references sku_codes(id),
  sku_code_snapshot text,
  category text,
  pallet_id uuid references pallets(id),
  pallet_display_id text,
  quantity numeric not null default 1,
  unit text not null default 'Pallets',
  fully_consumed boolean not null default true,
  inventory_source_id uuid,          -- the negative Inventory line this material created
  inventory_quantity numeric,        -- ... and its size in the item's own unit
  released_location_id uuid
);
create index if not exists idx_shift_record_materials_sr on shift_record_materials (shift_record_id);

alter table shift_records enable row level security;
alter table shift_record_materials enable row level security;
drop policy if exists shift_records_product_scope on shift_records;
create policy shift_records_product_scope on shift_records as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
drop policy if exists shift_records_select on shift_records;
create policy shift_records_select on shift_records for select using (app_can('shift_record', 'view'));
drop policy if exists shift_record_materials_select on shift_record_materials;
create policy shift_record_materials_select on shift_record_materials for select
  using (exists (select 1 from shift_records s where s.id = shift_record_materials.shift_record_id) and app_can('shift_record', 'view'));
grant select on shift_records, shift_record_materials to authenticated;

-- 2. permissions: a new module, "shift_record" -------------------------------------
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
    foreach _m in array array['inward_vehicle_inspection', 'inward_qc', 'rm_qr_generation', 'rm_storage', 'material_consumption', 'production', 'ipqc', 'rqc', 'fg_qr_generation', 'fg_storage', 'customer_shipment', 'shipment_picking', 'outward_vehicle_inspection', 'machine_downtime', 'goods_receipt', 'factory_rm_storage', 'factory_material_consumption', 'factory_production', 'factory_rqc_fg_qr', 'factory_fg_storage', 'factory_goods_outward', 'inventory', 'shift_record']::text[] loop
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

-- Everyone who could use RM Requisition or Production keeps working: they get the union of those two rows.
-- Admins get everything. "Do nothing" on conflict, so re-running never overwrites a permission set later.
insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
select mp.user_id, 'shift_record', bool_or(mp.can_view), bool_or(mp.can_create), bool_or(mp.can_edit),
       bool_or(mp.can_delete), bool_or(mp.can_approve), bool_or(mp.can_fill_section)
from module_permissions mp
where mp.module in ('factory_material_consumption', 'factory_production')
group by mp.user_id
on conflict (user_id, module) do nothing;
insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
select u.id, 'shift_record', true, true, true, true, true, true from app_users u where u.is_admin
on conflict (user_id, module) do update
  set can_view = true, can_create = true, can_edit = true, can_delete = true, can_approve = true, can_fill_section = true;

-- 3. helpers -----------------------------------------------------------------------
-- The pallet code inside whatever was scanned: the QR's JSON {"t":..,"id":..}, mangled JSON, or a plain typed code.
create or replace function shift_record_pallet_code(_scan text) returns text
  language plpgsql immutable
as $$
declare _s text := btrim(coalesce(_scan, '')); _j jsonb; _k text; _m text[];
begin
  if _s = '' then return null; end if;
  -- smart quotes some scanners / keyboards put in
  _s := replace(replace(replace(replace(_s, chr(8220), '"'), chr(8221), '"'), chr(8216), ''''), chr(8217), '''');
  begin _j := _s::jsonb; exception when others then _j := null; end;
  if _j is not null and jsonb_typeof(_j) = 'object' then
    select value #>> '{}' into _k from jsonb_each(_j) where lower(key) = 'id' limit 1;
    if _k is not null and btrim(_k) <> '' then return btrim(_k); end if;
  end if;
  _m := regexp_match(_s, '["'']?id["'']?\s*:\s*["'']([^"'']+)["'']', 'i');
  if _m is not null then return btrim(_m[1]); end if;
  return _s;
end;
$$;

-- Looks a scanned RM pallet up and says whether it can go on a Shift Record.
create or replace function shift_record_scan_preview(_scan text, _sku_code_id uuid) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare _code text; _p pallets%rowtype;
begin
  if not app_can('shift_record', 'view') then
    raise exception using errcode = '42501', message = 'You do not have permission to use Shift Record.';
  end if;
  if app_product() is distinct from 'factory' then
    raise exception 'Shift Record is only available in the Factory.';
  end if;
  _code := shift_record_pallet_code(_scan);
  if _code is null then raise exception 'Scan or type the RM pallet QR value.'; end if;
  select * into _p from pallets where product = 'factory' and pallet_type = 'rm' and lower(display_id) = lower(_code);
  if not found then
    if exists (select 1 from pallets where product = 'factory' and pallet_type = 'fg' and lower(display_id) = lower(_code)) then
      raise exception 'Invalid QR. Please scan an RM pallet QR.';
    elsif exists (select 1 from locations where product = 'factory' and lower(display_id) = lower(_code)) then
      raise exception 'Invalid scan. Please scan an RM pallet QR, not a storage location.';
    end if;
    raise exception 'Unrecognized QR. Please scan a valid RM pallet QR.';
  end if;
  if _p.lifecycle_status = 'consumed' then
    raise exception 'Pallet % has already been consumed and is not available.', _p.display_id;
  elsif _p.lifecycle_status in ('picked', 'shipped') then
    raise exception 'Pallet % has already been % and is not available.', _p.display_id, _p.lifecycle_status;
  elsif _p.lifecycle_status <> 'stored' then
    raise exception 'Pallet % is not currently available in RM Storage (status: %).', _p.display_id, _p.lifecycle_status;
  end if;
  if _sku_code_id is not null and _p.sku_code_id is distinct from _sku_code_id then
    raise exception 'Pallet % is %, which does not match the SKU selected for this line.', _p.display_id, coalesce(_p.sku_code_snapshot, 'another SKU');
  end if;
  return jsonb_build_object(
    'pallet_id', _p.id, 'display_id', _p.display_id, 'category', _p.category, 'sku_code_id', _p.sku_code_id,
    'sku_code', _p.sku_code_snapshot, 'sku_version_id', _p.sku_version_id, 'sku_version', _p.sku_version_snapshot,
    'shipment_number', _p.shipment_number);
end;
$$;
revoke all on function shift_record_scan_preview(text, uuid) from public;
grant execute on function shift_record_scan_preview(text, uuid) to authenticated;

-- 4. save --------------------------------------------------------------------------
-- _payload: { record_date, shift, machine_id, client_time, notes, trays_produced, scrap_trays, total_pcs_per_pallet?,
--             materials: [ { sku_code_id, scan, quantity, unit, fully_consumed } ] }
create or replace function shift_record_save(_payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _date date; _shift text; _machine machines%rowtype; _line jsonb; _ord int := 0; _code text;
  _p pallets%rowtype; _e goods_receipt_entries%rowtype; _src inventory_sources%rowtype; _item inventory_items%rowtype;
  _unit text; _qty numeric; _full boolean; _delta numeric; _boxes numeric; _trays_delta numeric; _adj uuid; _loc uuid;
  _fg_sku_id uuid; _fg_ver_id uuid; _fg_sku sku_codes%rowtype; _fg_ver sku_versions%rowtype; _shipment text;
  _sr_id uuid := gen_random_uuid(); _disp text; _trays int; _scrap int; _per int; _n int; _k int; _each int; _b qr_generation_records%rowtype;
  _pid uuid; _did text; _yymm text := to_char(now() at time zone 'utc', 'YYMM'); _seen uuid[] := '{}'; _pallets jsonb := '[]'::jsonb;
  _tray_cats text[] := array['tray', 'lnp_tray', 'fgtray']; _by uuid := app_user_id();
begin
  if not app_can('shift_record', 'create') then
    raise exception using errcode = '42501', message = 'You do not have permission to create Shift Records.';
  end if;
  if app_product() is distinct from 'factory' then
    raise exception 'Shift Record is only available in the Factory.';
  end if;

  _date := nullif(_payload->>'record_date', '')::date;
  _shift := nullif(btrim(coalesce(_payload->>'shift', '')), '');
  if _date is null then raise exception 'Select the Date.'; end if;
  if _shift is null then raise exception 'Select a Shift.'; end if;
  select * into _machine from machines where id = nullif(_payload->>'machine_id', '')::uuid and product = 'factory';
  if not found then raise exception 'Select a Machine.'; end if;
  if jsonb_typeof(_payload->'materials') is distinct from 'array' or jsonb_array_length(_payload->'materials') = 0 then
    raise exception 'Add at least one material used (trays, pads ...).';
  end if;
  if coalesce(nullif(_payload->>'trays_produced', '')::numeric, 0) <> trunc(coalesce(nullif(_payload->>'trays_produced', '')::numeric, 0))
     or coalesce(nullif(_payload->>'scrap_trays', '')::numeric, 0) <> trunc(coalesce(nullif(_payload->>'scrap_trays', '')::numeric, 0)) then
    raise exception 'Trays produced and scrap trays must be whole numbers.';
  end if;
  _trays := coalesce(nullif(_payload->>'trays_produced', '')::numeric, 0)::int;
  _scrap := coalesce(nullif(_payload->>'scrap_trays', '')::numeric, 0)::int;
  if _trays < 0 or _scrap < 0 then raise exception 'Trays produced and scrap trays cannot be negative.'; end if;

  _disp := 'SR-' || lpad(factory_next_seq('shift_record')::text, 4, '0');
  insert into shift_records (id, product, display_id, record_date, shift, machine_id, trays_produced, scrap_trays, notes,
                             recorded_by, client_time)
    values (_sr_id, 'factory', _disp, _date, _shift, _machine.id, _trays, _scrap, nullif(btrim(coalesce(_payload->>'notes', '')), ''),
            _by, nullif(btrim(coalesce(_payload->>'client_time', '')), ''));

  -- materials used ------------------------------------------------------------------
  for _line in select * from jsonb_array_elements(_payload->'materials') loop
    _ord := _ord + 1;
    _code := shift_record_pallet_code(_line->>'scan');
    if _code is null then raise exception 'Line %: scan or type the RM pallet QR value.', _ord; end if;
    select * into _p from pallets where product = 'factory' and pallet_type = 'rm' and lower(display_id) = lower(_code) for update;
    if not found then raise exception 'Line %: "%" is not a known RM pallet.', _ord, _code; end if;
    if _p.lifecycle_status <> 'stored' then
      raise exception 'Line %: pallet % is not available (status: %).', _ord, _p.display_id, _p.lifecycle_status;
    end if;
    if _p.id = any(_seen) then raise exception 'Pallet % is on this record twice.', _p.display_id; end if;
    _seen := _seen || _p.id;
    if nullif(_line->>'sku_code_id', '') is not null and _p.sku_code_id is distinct from (_line->>'sku_code_id')::uuid then
      raise exception 'Line %: pallet % is % -- it does not match the SKU chosen for this line.', _ord, _p.display_id, coalesce(_p.sku_code_snapshot, 'another SKU');
    end if;
    _unit := coalesce(nullif(btrim(coalesce(_line->>'unit', '')), ''), 'Pallets');
    _qty := coalesce(nullif(_line->>'quantity', '')::numeric, 1);
    _full := coalesce((_line->>'fully_consumed')::boolean, true);
    if _qty <= 0 then raise exception 'Line % (%): quantity must be more than 0.', _ord, _p.display_id; end if;
    if _unit not in ('Pallets', 'Boxes', 'Pcs', 'Kgs', 'Units') then raise exception 'Line %: unknown unit "%".', _ord, _unit; end if;
    if _unit = 'Pallets' and _qty <> trunc(_qty) then raise exception 'Line % (%): Pallets must be a whole number.', _ord, _p.display_id; end if;

    if _p.category = any(_tray_cats) then
      if _unit <> 'Pallets' or _qty <> 1 or not _full then
        raise exception 'Line % (%): a tray pallet is used whole -- 1 Pallets, fully consumed.', _ord, _p.display_id;
      end if;
      if _fg_sku_id is null then
        _fg_sku_id := _p.sku_code_id; _fg_ver_id := _p.sku_version_id; _shipment := _p.shipment_number;
      elsif _fg_sku_id <> _p.sku_code_id then
        raise exception 'One Shift Record makes one FG tray SKU. Pallet % is %, a different tray SKU -- record it on its own Shift Record.', _p.display_id, coalesce(_p.sku_code_snapshot, 'another SKU');
      end if;
    end if;

    -- Inventory: how much of the item's own unit this use takes off
    _e := null; _src := null; _item := null;
    select * into _e from goods_receipt_entries where id = _p.source_goods_receipt_entry_id;
    select * into _src from inventory_sources where source_goods_receipt_entry_id = _p.source_goods_receipt_entry_id;
    select * into _item from inventory_items where product = 'factory' and sku_code_id = _p.sku_code_id;
    if _item.id is null then
      insert into inventory_items (product, sku_code_id, uom)
        values ('factory', _p.sku_code_id,
                coalesce((select nullif(btrim(default_unit), '') from sku_codes where id = _p.sku_code_id), _unit))
        returning * into _item;
    end if;
    if _unit = _item.uom then
      _delta := _qty;
    elsif _unit = 'Pallets' and _item.uom = 'Pcs' and coalesce(_e.pcs_per_box, 0) > 0 and coalesce(_e.boxes_per_pallet, 0) > 0 then
      _delta := _qty * _e.pcs_per_box * _e.boxes_per_pallet;
    elsif _unit = 'Boxes' and _item.uom = 'Pcs' and coalesce(_e.pcs_per_box, 0) > 0 then
      _delta := _qty * _e.pcs_per_box;
    elsif _unit = 'Boxes' and _item.uom = 'Kgs' and coalesce(_src.kg_per_box, 0) > 0 then
      _delta := _qty * _src.kg_per_box;
    elsif _unit = 'Pallets' and _item.uom = 'Kgs' and coalesce(_src.kg_per_box, 0) > 0 then
      select coalesce((select (metadata->>'boxes')::numeric from pallet_lifecycle_events
                        where pallet_id = _p.id and metadata ? 'boxes' order by occurred_at limit 1), _src.boxes_per_pallet) into _boxes;
      if coalesce(_boxes, 0) <= 0 then
        raise exception 'Line % (%): the boxes on this pallet are not known, so Pallets cannot be turned into Kgs. Enter the Boxes or Kgs used.', _ord, _p.display_id;
      end if;
      _delta := _qty * _boxes * _src.kg_per_box;
    else
      raise exception 'Line % (%): "%" cannot be taken off Inventory, which counts % for this SKU. Use % instead.',
        _ord, _p.display_id, _unit, _item.uom, _item.uom;
    end if;
    _trays_delta := case when _src.trays_per_pallet is not null and _unit = 'Pallets' then -(_qty * _src.trays_per_pallet) end;
    insert into inventory_sources (inventory_item_id, quantity, unit, trays, kg_per_box, is_manual, note)
      values (_item.id, -_delta, _item.uom, _trays_delta, _src.kg_per_box, true,
              'Shift Record ' || _disp || ': ' || _p.display_id || ' (' || _qty || ' ' || _unit || ')')
      returning id into _adj;

    -- the pallet leaves its shelf the moment it is used; fully-used pallets are consumed
    _loc := null;
    select location_id into _loc from storage_records where pallet_id = _p.id limit 1;
    delete from storage_records where pallet_id = _p.id;
    if _full then
      update pallets set lifecycle_status = 'consumed', current_location_id = null, updated_at = now() where id = _p.id;
      insert into pallet_lifecycle_events (pallet_id, stage, metadata, actor_user_id, occurred_at)
        values (_p.id, 'consumed', jsonb_build_object('consumed_by_module', 'shift_record', 'shift_record', _disp,
                                                       'quantity', _qty, 'unit', _unit), _by, now());
    else
      insert into pallet_lifecycle_events (pallet_id, stage, metadata, actor_user_id, occurred_at)
        values (_p.id, 'partial_consumption', jsonb_build_object('consumed_by_module', 'shift_record', 'shift_record', _disp,
                                                                  'quantity', _qty, 'unit', _unit), _by, now());
    end if;

    insert into shift_record_materials (shift_record_id, sort_order, sku_code_id, sku_code_snapshot, category, pallet_id, pallet_display_id,
                                        quantity, unit, fully_consumed, inventory_source_id, inventory_quantity, released_location_id)
      values (_sr_id, _ord, _p.sku_code_id, _p.sku_code_snapshot, _p.category, _p.id, _p.display_id,
              _qty, _unit, _full, _adj, _delta, _loc);
  end loop;

  -- FG trays produced -> FG pallets ------------------------------------------------------
  if _trays > 0 then
    if _fg_sku_id is null then
      raise exception 'FG trays were produced, but no tray was used. Add the tray pallet(s) that were consumed.';
    end if;
    select * into _fg_sku from sku_codes where id = _fg_sku_id;
    select * into _fg_ver from sku_versions where id = _fg_ver_id;
    _per := nullif(_payload->>'total_pcs_per_pallet', '')::numeric::int;
    if _per is null or _per <= 0 then _per := _fg_ver.prod_total_pcs_per_pallet; end if;
    if _per is null or _per <= 0 then
      raise exception 'Total Pcs per Pallet is not set for % -- enter it, so the pallets can be worked out from the trays.', _fg_sku.code;
    end if;
    _n := greatest(_trays / _per, 1);
    insert into qr_generation_records (product, batch_display_id, qr_type, category, shipment_number, sku_code_id, sku_version_id,
                                       sku_code_snapshot, sku_version_snapshot, country_code, quantity, status, generated_at)
      values ('factory', 'FGQR-' || lpad(factory_next_seq('qr_batch:fg')::text, 4, '0'), 'fg', 'fgtray', _shipment, _fg_sku.id, _fg_ver_id,
              coalesce(nullif(btrim(_fg_sku.sku_code), ''), _fg_sku.code), _fg_ver.version, 'US', _n, 'generated', now())
      returning * into _b;
    for _k in 1.._n loop
      _each := case when _n = 1 then _trays when _k = _n then _trays - _per * (_n - 1) else _per end;
      _did := 'US-PLT-' || _yymm || '-' || lpad(factory_next_seq('pallet:US-PLT')::text, 4, '0');
      insert into pallets (product, display_id, pallet_type, category, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
                           shipment_number, source_qr_generation_id, source_machine_id, lifecycle_status, qr_payload)
        values ('factory', _did, 'fg', 'fgtray', _fg_sku.id, _fg_ver_id, coalesce(nullif(btrim(_fg_sku.sku_code), ''), _fg_sku.code), _fg_ver.version,
                _shipment, _b.id, _machine.id, 'generated',
                json_build_object('t', 'fg_pallet', 'id', _did, 'run', _disp, 'sku', _fg_sku.code)::text)
        returning id into _pid;
      insert into pallet_lifecycle_events (pallet_id, stage, metadata, actor_user_id, occurred_at)
        values (_pid, 'generated', jsonb_build_object('shift_record', _disp, 'batch', _b.batch_display_id, 'trays', _each,
                                                       'machine', _machine.code, 'shift', _shift), _by, now());
      _pallets := _pallets || jsonb_build_object('id', _pid, 'display_id', _did, 'trays', _each);
    end loop;
    update shift_records set fg_sku_code_id = _fg_sku.id, fg_sku_version_id = _fg_ver_id, fg_sku_code_snapshot = _fg_sku.code,
                             fg_sku_version_snapshot = _fg_ver.version, total_pcs_per_pallet = _per, fg_pallets = _n,
                             qr_generation_id = _b.id, shipment_number = _shipment where id = _sr_id;
  else
    update shift_records set shipment_number = _shipment, fg_sku_code_id = _fg_sku_id, fg_sku_version_id = _fg_ver_id,
                             fg_sku_code_snapshot = (select code from sku_codes where id = _fg_sku_id),
                             fg_sku_version_snapshot = (select version from sku_versions where id = _fg_ver_id)
      where id = _sr_id;
  end if;

  return jsonb_build_object('id', _sr_id, 'display_id', _disp, 'fg_pallets', _pallets, 'qr_generation_id', _b.id);
end;
$$;
revoke all on function shift_record_save(jsonb) from public;
grant execute on function shift_record_save(jsonb) to authenticated;

-- 5. delete (undo) -------------------------------------------------------------------
create or replace function shift_record_delete(_id uuid) returns void
  language plpgsql security definer set search_path = public
as $$
declare _s shift_records%rowtype; _m record; _n int;
begin
  if not app_can('shift_record', 'delete') then
    raise exception using errcode = '42501', message = 'You do not have permission to delete Shift Records.';
  end if;
  select * into _s from shift_records where id = _id and product = 'factory' for update;
  if not found then raise exception using errcode = 'P0002', message = 'Shift Record not found.'; end if;
  if _s.qr_generation_id is not null then
    select count(*) into _n from pallets p
      where p.source_qr_generation_id = _s.qr_generation_id
        and (p.lifecycle_status <> 'generated' or exists (select 1 from storage_records r where r.pallet_id = p.id));
    if _n > 0 then
      raise exception 'Cannot delete %: % of its FG pallets have already been stored or used. Undo that first.', _s.display_id, _n;
    end if;
    delete from pallets where source_qr_generation_id = _s.qr_generation_id;       -- lifecycle events go with them
    update shift_records set qr_generation_id = null where id = _id;
    delete from qr_generation_records where id = _s.qr_generation_id;
  end if;
  for _m in select * from shift_record_materials where shift_record_id = _id order by sort_order loop
    delete from inventory_sources where id = _m.inventory_source_id;
    delete from pallet_lifecycle_events
      where pallet_id = _m.pallet_id and metadata->>'shift_record' = _s.display_id and stage in ('consumed', 'partial_consumption');
    if _m.fully_consumed then
      update pallets set lifecycle_status = 'stored', updated_at = now() where id = _m.pallet_id and lifecycle_status = 'consumed';
    end if;
    if _m.released_location_id is not null
       and exists (select 1 from pallets where id = _m.pallet_id and lifecycle_status = 'stored')
       and not exists (select 1 from storage_records where pallet_id = _m.pallet_id) then
      insert into storage_records (product, storage_type, pallet_id, location_id, source_qr_generation_id, source_goods_receipt_entry_id)
        select 'factory', 'rm', p.id, _m.released_location_id, p.source_qr_generation_id, p.source_goods_receipt_entry_id
        from pallets p where p.id = _m.pallet_id;
      update pallets set current_location_id = _m.released_location_id where id = _m.pallet_id;
    end if;
  end loop;
  delete from shift_records where id = _id;                                         -- materials go with it
end;
$$;
revoke all on function shift_record_delete(uuid) from public;
grant execute on function shift_record_delete(uuid) to authenticated;
