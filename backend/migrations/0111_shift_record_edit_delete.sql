-- 0111 -- Shift Record: Edit, and Delete that works for generated records. Run after 0109 (and 0107). Re-runnable.
--   * shift_record_update(id, payload): reverses the old record (stock back on Inventory, pallets back in stock, FG pallets removed,
--     earlier loose trays freed) and saves the new one under the same SR number, all in one step -- if anything fails, nothing changes.
--     It is refused in the same cases as Delete. An edited record has no FG QRs yet: press Generate FG QRs again.
--   * Delete used to refuse any record whose FG pallets were "stored"; with the floor auto-store that is every generated record.
--     Now it only refuses when a pallet was picked, shipped or otherwise used.
--   * the Shift Record scan preview takes an optional record id, so the edit form can re-read the pallets that record used.
alter table shift_records add column if not exists edited_at timestamptz;
alter table shift_records add column if not exists edited_by uuid references app_users(id);

drop function if exists shift_record_scan_preview(text, uuid);
create or replace function shift_record_scan_preview(_scan text, _sku_code_id uuid, _record_id uuid default null) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare _code text; _p pallets%rowtype; _e goods_receipt_entries%rowtype; _src inventory_sources%rowtype; _boxes numeric;
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
  if _p.lifecycle_status = 'consumed' and _record_id is not null
     and exists (select 1 from shift_record_materials m where m.shift_record_id = _record_id and m.pallet_id = _p.id) then
    null;   -- editing a record: the pallet this very record used counts as available again
  elsif _p.lifecycle_status = 'consumed' then
    raise exception 'Pallet % has already been consumed and is not available.', _p.display_id;
  elsif _p.lifecycle_status in ('picked', 'shipped') then
    raise exception 'Pallet % has already been % and is not available.', _p.display_id, _p.lifecycle_status;
  elsif _p.lifecycle_status <> 'stored' then
    raise exception 'Pallet % is not currently available in RM Storage (status: %).', _p.display_id, _p.lifecycle_status;
  end if;
  if _sku_code_id is not null and _p.sku_code_id is distinct from _sku_code_id then
    raise exception 'Pallet % is %, which does not match the SKU selected for this line.', _p.display_id, coalesce(_p.sku_code_snapshot, 'another SKU');
  end if;
  select * into _e from goods_receipt_entries where id = _p.source_goods_receipt_entry_id;
  select * into _src from inventory_sources where source_goods_receipt_entry_id = _p.source_goods_receipt_entry_id;
  select coalesce((select (metadata->>'boxes')::numeric from pallet_lifecycle_events
                    where pallet_id = _p.id and metadata ? 'boxes' order by occurred_at limit 1), _src.boxes_per_pallet, _e.boxes_per_pallet) into _boxes;
  return jsonb_build_object(
    'trays_per_pallet', _src.trays_per_pallet,
    'pcs_per_pallet', case when coalesce(_e.pcs_per_box, 0) > 0 and coalesce(_e.boxes_per_pallet, 0) > 0 then _e.pcs_per_box * _e.boxes_per_pallet end,
    'boxes_per_pallet', _boxes, 'kg_per_box', _src.kg_per_box,
    'pallet_id', _p.id, 'display_id', _p.display_id, 'category', _p.category, 'sku_code_id', _p.sku_code_id,
    'sku_code', _p.sku_code_snapshot, 'sku_version_id', _p.sku_version_id, 'sku_version', _p.sku_version_snapshot,
    'shipment_number', _p.shipment_number);
end;
$$;
revoke all on function shift_record_scan_preview(text, uuid, uuid) from public;
grant execute on function shift_record_scan_preview(text, uuid, uuid) to authenticated;

create or replace function shift_record_delete_impl(_id uuid) returns void
  language plpgsql security definer set search_path = public
as $$
declare _s shift_records%rowtype; _m record; _n int;
begin
  select * into _s from shift_records where id = _id and product = 'factory' for update;
  if not found then raise exception using errcode = 'P0002', message = 'Shift Record not found.'; end if;
  if _s.loose_carried_to is not null then
    raise exception 'Cannot delete %: its loose trays were carried into a later record. Delete that record first.', _s.display_id;
  end if;
  if _s.qr_generation_id is not null then
    -- a pallet that is only sitting where it was auto-stored (Floor FG) is untouched; one that was picked, shipped or
    -- otherwise used is not
    select count(*) into _n from pallets p
      where p.source_qr_generation_id = _s.qr_generation_id
        and (p.lifecycle_status not in ('generated', 'stored')
             or exists (select 1 from pallet_lifecycle_events ev where ev.pallet_id = p.id and ev.stage not in ('generated', 'stored', 'pending_storage')));
    if _n > 0 then
      raise exception 'Cannot delete %: % of its FG pallets have already been picked, shipped or used. Undo that first.', _s.display_id, _n;
    end if;
    delete from storage_records where pallet_id in (select id from pallets where source_qr_generation_id = _s.qr_generation_id);
    delete from pallets where source_qr_generation_id = _s.qr_generation_id;       -- lifecycle events go with them
    update shift_records set qr_generation_id = null where id = _id;
    delete from qr_generation_records where id = _s.qr_generation_id;
  end if;
  update shift_records set loose_carried_to = null where loose_carried_to = _id;    -- earlier loose trays wait again
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
revoke all on function shift_record_delete_impl(uuid) from public;


create or replace function shift_record_save_impl(_payload jsonb, _keep_disp text default null, _keep_by uuid default null, _keep_at timestamptz default null) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _date date; _shift text; _machine machines%rowtype; _line jsonb; _ord int := 0; _code text;
  _p pallets%rowtype; _e goods_receipt_entries%rowtype; _src inventory_sources%rowtype; _item inventory_items%rowtype;
  _unit text; _qty numeric; _full boolean; _delta numeric; _boxes numeric; _trays_delta numeric; _cap numeric; _adj uuid; _boxes2 numeric; _loose int; _scrap_reason text; _used_trays numeric := 0; _used_unknown boolean := false; _loc uuid;
  _fg_sku_id uuid; _fg_ver_id uuid; _fg_sku sku_codes%rowtype; _sk sku_codes%rowtype; _fg_ver sku_versions%rowtype; _shipment text;
  _sr_id uuid := gen_random_uuid(); _disp text; _trays int; _scrap int; _hold int; _per int; _n int; _k int; _each int; _b qr_generation_records%rowtype;
  _pid uuid; _did text; _yymm text := to_char(now() at time zone 'utc', 'YYMM'); _seen uuid[] := '{}'; _pallets jsonb := '[]'::jsonb;
  _tray_cats text[] := array['tray', 'lnp_tray', 'fgtray']; _by uuid := app_user_id();
begin
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
     or coalesce(nullif(_payload->>'scrap_trays', '')::numeric, 0) <> trunc(coalesce(nullif(_payload->>'scrap_trays', '')::numeric, 0))
     or coalesce(nullif(_payload->>'hold_trays', '')::numeric, 0) <> trunc(coalesce(nullif(_payload->>'hold_trays', '')::numeric, 0)) then
    raise exception 'Trays produced, scrap trays and hold trays must be whole numbers.';
  end if;
  _trays := coalesce(nullif(_payload->>'trays_produced', '')::numeric, 0)::int;
  _scrap_reason := nullif(btrim(coalesce(_payload->>'scrap_reason', '')), '');
  _scrap := coalesce(nullif(_payload->>'scrap_trays', '')::numeric, 0)::int;
  _hold := coalesce(nullif(_payload->>'hold_trays', '')::numeric, 0)::int;
  if _trays < 0 or _scrap < 0 or _hold < 0 then raise exception 'Trays produced, scrap trays and hold trays cannot be negative.'; end if;

  _disp := coalesce(_keep_disp, 'SR-' || lpad(factory_next_seq('shift_record')::text, 4, '0'));
  insert into shift_records (id, product, display_id, record_date, shift, machine_id, trays_produced, scrap_trays, hold_trays, scrap_reason, notes,
                             recorded_by, recorded_at, client_time)
    values (_sr_id, 'factory', _disp, _date, _shift, _machine.id, _trays, _scrap, _hold, _scrap_reason, nullif(btrim(coalesce(_payload->>'notes', '')), ''),
            coalesce(_keep_by, _by), coalesce(_keep_at, now()), nullif(btrim(coalesce(_payload->>'client_time', '')), ''));

  -- materials used ------------------------------------------------------------------
  for _line in select * from jsonb_array_elements(_payload->'materials') loop
    _ord := _ord + 1;
    _code := shift_record_pallet_code(_line->>'scan');
    if _code is null then
      -- No QR scanned: the SKU and the quantity are enough. Stock comes off Inventory by SKU; no pallet is touched.
      if nullif(_line->>'sku_code_id', '') is null then
        raise exception 'Line %: select the SKU (or scan the RM pallet QR).', _ord;
      end if;
      select * into _sk from sku_codes where id = (_line->>'sku_code_id')::uuid;
      if not found then raise exception 'Line %: SKU not found.', _ord; end if;
      _unit := coalesce(nullif(btrim(coalesce(_line->>'unit', '')), ''), 'Pallets');
      _qty := coalesce(nullif(_line->>'quantity', '')::numeric, 1);
      if _qty <= 0 then raise exception 'Line % (%): quantity must be more than 0.', _ord, _sk.code; end if;
      if _unit not in ('Pallets', 'Trays', 'Boxes', 'Pcs', 'Kgs', 'Units') then raise exception 'Line %: unknown unit "%".', _ord, _unit; end if;
      if _unit in ('Pallets', 'Trays') and _qty <> trunc(_qty) then raise exception 'Line % (%): Pallets and Trays must be whole numbers.', _ord, _sk.code; end if;
      if _sk.category = any(_tray_cats) and _unit not in ('Pallets', 'Trays') then
        raise exception 'Line % (%): trays are entered as Pallets or Trays.', _ord, _sk.code;
      end if;
      if _sk.category = any(_tray_cats) then
        if _fg_sku_id is null then
          _fg_sku_id := _sk.id;
          select id into _fg_ver_id from sku_versions where sku_code_id = _sk.id
            order by (prod_total_pcs_per_pallet is null), version limit 1;
        elsif _fg_sku_id <> _sk.id then
          raise exception 'One Shift Record makes one FG tray SKU. % is a different tray SKU -- record it on its own Shift Record.', _sk.code;
        end if;
      end if;
      _item := null; _src := null; _e := null;
      select * into _item from inventory_items where product = 'factory' and sku_code_id = _sk.id;
      if _item.id is null then
        insert into inventory_items (product, sku_code_id, uom)
          values ('factory', _sk.id, coalesce((select nullif(btrim(default_unit), '') from sku_codes where id = _sk.id), _unit))
          returning * into _item;
      end if;
      -- per-pallet figures come from the item's latest receipt that has them
      select * into _src from inventory_sources where inventory_item_id = _item.id and (trays_per_pallet is not null or kg_per_box is not null)
        order by created_at desc limit 1;
      if _unit = _item.uom then
        _delta := _qty;
      elsif _unit = 'Trays' and _item.uom = 'Pallets' and coalesce(_src.trays_per_pallet, 0) > 0 then
        _delta := _qty / _src.trays_per_pallet;
      elsif _unit = 'Boxes' and _item.uom = 'Kgs' and coalesce(_src.kg_per_box, 0) > 0 then
        _delta := _qty * _src.kg_per_box;
      else
        raise exception 'Line % (%): "%" cannot be taken off Inventory without a pallet QR, which counts % for this SKU. Use % or scan the pallet QR.',
          _ord, _sk.code, _unit, _item.uom, _item.uom;
      end if;
      _trays_delta := case when _unit = 'Trays' then -_qty when _src.trays_per_pallet is not null and _unit = 'Pallets' then -(_qty * _src.trays_per_pallet) end;
      if _sk.category = any(_tray_cats) then
        if _unit = 'Trays' then _used_trays := _used_trays + _qty;
        elsif _unit = 'Pallets' and coalesce(_src.trays_per_pallet, 0) > 0 then _used_trays := _used_trays + _qty * _src.trays_per_pallet;
        else _used_unknown := true; end if;
      end if;
      insert into inventory_sources (inventory_item_id, quantity, unit, trays, kg_per_box, is_manual, note)
        values (_item.id, -_delta, _item.uom, _trays_delta, _src.kg_per_box, true,
                'Shift Record ' || _disp || ': ' || _sk.code || ' (' || _qty || ' ' || _unit || ', no pallet QR)')
        returning id into _adj;
      insert into shift_record_materials (shift_record_id, sort_order, sku_code_id, sku_code_snapshot, category, pallet_id, pallet_display_id,
                                          quantity, unit, fully_consumed, inventory_source_id, inventory_quantity, released_location_id)
        values (_sr_id, _ord, _sk.id, _sk.code, _sk.category, null, null, _qty, _unit, false, _adj, _delta, null);
      continue;
    end if;
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
    if _unit not in ('Pallets', 'Trays', 'Boxes', 'Pcs', 'Kgs', 'Units') then raise exception 'Line %: unknown unit "%".', _ord, _unit; end if;
    if _unit in ('Pallets', 'Trays') and _qty <> trunc(_qty) then raise exception 'Line % (%): Pallets and Trays must be whole numbers.', _ord, _p.display_id; end if;

    if _p.category = any(_tray_cats) then
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
    select coalesce((select (metadata->>'boxes')::numeric from pallet_lifecycle_events
                      where pallet_id = _p.id and metadata ? 'boxes' order by occurred_at limit 1), _src.boxes_per_pallet, _e.boxes_per_pallet) into _boxes2;
    -- how much of this unit one whole pallet holds, when known: using that much (or more) uses the pallet up
    _cap := case _unit
      when 'Pallets' then 1
      when 'Trays' then _src.trays_per_pallet
      when 'Pcs' then case when coalesce(_e.pcs_per_box, 0) > 0 and coalesce(_e.boxes_per_pallet, 0) > 0 then _e.pcs_per_box * _e.boxes_per_pallet end
      when 'Boxes' then _boxes2
      when 'Kgs' then case when coalesce(_boxes2, 0) > 0 and coalesce(_src.kg_per_box, 0) > 0 then _boxes2 * _src.kg_per_box end
    end;
    if _cap is not null and _cap > 0 then _full := _qty >= _cap; end if;
    if _p.category = any(_tray_cats) and _unit not in ('Pallets', 'Trays') then
      raise exception 'Line % (%): trays are entered as Pallets or Trays.', _ord, _p.display_id;
    end if;
    if _unit = _item.uom then
      _delta := _qty;
    elsif _unit = 'Trays' and _item.uom = 'Pallets' and coalesce(_src.trays_per_pallet, 0) > 0 then
      _delta := _qty / _src.trays_per_pallet;
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
    _trays_delta := case when _unit = 'Trays' then -_qty when _src.trays_per_pallet is not null and _unit = 'Pallets' then -(_qty * _src.trays_per_pallet) end;
    if _p.category = any(_tray_cats) then      -- trays used on this record, for the balance check below
      if _unit = 'Trays' then _used_trays := _used_trays + _qty;
      elsif _unit = 'Pallets' and coalesce(_src.trays_per_pallet, 0) > 0 then _used_trays := _used_trays + _qty * _src.trays_per_pallet;
      else _used_unknown := true; end if;
    end if;
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

  -- trays used = finished + scrap - hold
  if _fg_sku_id is not null and not _used_unknown and _used_trays > 0 and (_trays + _scrap - _hold) <> _used_trays then
    raise exception 'Trays produced (%) + scrap trays (%) - hold trays (%) = %, but % trays were used. They must be equal.', _trays, _scrap, _hold, _trays + _scrap - _hold, _used_trays;
  end if;

  -- FG trays produced: checked and recorded here; the FG pallets / QRs are made later by shift_record_generate_fg()
  -- (so loose trays left over from earlier shifts can be added in).
  if _trays > 0 then
    if _fg_sku_id is null then
      raise exception 'FG trays were produced, but no tray was used. Add the tray pallet(s) that were consumed.';
    end if;
    select * into _fg_sku from sku_codes where id = _fg_sku_id;
    select * into _fg_ver from sku_versions where id = _fg_ver_id;
    _per := nullif(_payload->>'total_pcs_per_pallet', '')::numeric::int;
    if _per is null or _per <= 0 then _per := _fg_ver.prod_total_pcs_per_pallet; end if;
    if _per is null or _per <= 0 then
      raise exception 'Trays per Pallet is not set for % -- enter it, so the pallets can be worked out from the trays.', _fg_sku.code;
    end if;
  end if;
  update shift_records set shipment_number = _shipment, fg_sku_code_id = _fg_sku_id, fg_sku_version_id = _fg_ver_id,
                           fg_sku_code_snapshot = (select code from sku_codes where id = _fg_sku_id),
                           fg_sku_version_snapshot = (select version from sku_versions where id = _fg_ver_id),
                           total_pcs_per_pallet = case when _trays > 0 then _per end
    where id = _sr_id;

  return jsonb_build_object('id', _sr_id, 'display_id', _disp, 'fg_pallets', '[]'::jsonb, 'qr_generation_id', null);
end;
$$;
revoke all on function shift_record_save_impl(jsonb, text, uuid, timestamptz) from public;


create or replace function shift_record_save(_payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
begin
  if not app_can('shift_record', 'create') then
    raise exception using errcode = '42501', message = 'You do not have permission to create Shift Records.';
  end if;
  return shift_record_save_impl(_payload);
end;
$$;
revoke all on function shift_record_save(jsonb) from public;
grant execute on function shift_record_save(jsonb) to authenticated;

create or replace function shift_record_delete(_id uuid) returns void
  language plpgsql security definer set search_path = public
as $$
begin
  if not app_can('shift_record', 'delete') then
    raise exception using errcode = '42501', message = 'You do not have permission to delete Shift Records.';
  end if;
  perform shift_record_delete_impl(_id);
end;
$$;
revoke all on function shift_record_delete(uuid) from public;
grant execute on function shift_record_delete(uuid) to authenticated;

create or replace function shift_record_update(_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare _s shift_records%rowtype; _res jsonb;
begin
  if not app_can('shift_record', 'edit') then
    raise exception using errcode = '42501', message = 'You do not have permission to edit Shift Records.';
  end if;
  if app_product() is distinct from 'factory' then
    raise exception 'Shift Record is only available in the Factory.';
  end if;
  select * into _s from shift_records where id = _id and product = 'factory' for update;
  if not found then raise exception using errcode = 'P0002', message = 'Shift Record not found.'; end if;
  perform shift_record_delete_impl(_id);                                            -- same refusals as Delete
  _res := shift_record_save_impl(_payload, _s.display_id, _s.recorded_by, _s.recorded_at);
  update shift_records set edited_at = now(), edited_by = app_user_id() where id = (_res->>'id')::uuid;
  return _res;
end;
$$;
revoke all on function shift_record_update(uuid, jsonb) from public;
grant execute on function shift_record_update(uuid, jsonb) to authenticated;
