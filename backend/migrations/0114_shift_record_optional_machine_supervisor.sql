-- 0114 -- Shift Record: Machine becomes optional, and a Shift Supervisor is recorded.
--   * shift_records.shift_supervisor (text, optional; the form offers Joe Castano / Kevis Garcia).
--   * shift_record_save_impl() (used by save and by edit) no longer requires a Machine. With no machine the
--     record and its FG pallets simply carry no machine (pallets.source_machine_id is nullable; the FG QR
--     payload shows machine = null and the label line drops the machine part).
-- Additive and re-runnable. Run after 0113.

alter table shift_records add column if not exists shift_supervisor text;

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
  _cum_yes boolean; _cum_fg int; _cum_scrap int; _avail numeric;
begin
  if app_product() is distinct from 'factory' then
    raise exception 'Shift Record is only available in the Factory.';
  end if;

  _date := nullif(_payload->>'record_date', '')::date;
  _shift := nullif(btrim(coalesce(_payload->>'shift', '')), '');
  if _date is null then raise exception 'Select the Date.'; end if;
  if _shift is null then raise exception 'Select a Shift.'; end if;
  -- Machine is optional; when one is given it must be a Factory machine.
  if nullif(_payload->>'machine_id', '') is not null then
    select * into _machine from machines where id = (_payload->>'machine_id')::uuid and product = 'factory';
    if not found then raise exception 'Machine not found.'; end if;
  end if;
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

  -- Cumulative Hold record: Yes/No, and when Yes the held FG trays and scrap released this shift
  if nullif(_payload->>'cum_hold_yes', '') is not null then _cum_yes := (_payload->>'cum_hold_yes')::boolean; end if;
  if coalesce(nullif(_payload->>'cum_hold_fg_trays', '')::numeric, 0) <> trunc(coalesce(nullif(_payload->>'cum_hold_fg_trays', '')::numeric, 0))
     or coalesce(nullif(_payload->>'cum_hold_scrap_trays', '')::numeric, 0) <> trunc(coalesce(nullif(_payload->>'cum_hold_scrap_trays', '')::numeric, 0)) then
    raise exception 'Cumulative hold FG trays and scrap must be whole numbers.';
  end if;
  _cum_fg := case when coalesce(_cum_yes, false) then coalesce(nullif(_payload->>'cum_hold_fg_trays', '')::numeric, 0)::int else 0 end;
  _cum_scrap := case when coalesce(_cum_yes, false) then coalesce(nullif(_payload->>'cum_hold_scrap_trays', '')::numeric, 0)::int else 0 end;
  if _cum_fg < 0 or _cum_scrap < 0 then raise exception 'Cumulative hold FG trays and scrap cannot be negative.'; end if;

  _disp := coalesce(_keep_disp, 'SR-' || lpad(factory_next_seq('shift_record')::text, 4, '0'));
  insert into shift_records (id, product, display_id, record_date, shift, machine_id, shift_supervisor, trays_produced, scrap_trays, hold_trays, scrap_reason, notes,
                             recorded_by, recorded_at, client_time, cum_hold_yes, cum_hold_fg_trays, cum_hold_scrap_trays)
    values (_sr_id, 'factory', _disp, _date, _shift, _machine.id, nullif(btrim(coalesce(_payload->>'shift_supervisor', '')), ''), _trays, _scrap, _hold, _scrap_reason, nullif(btrim(coalesce(_payload->>'notes', '')), ''),
            coalesce(_keep_by, _by), coalesce(_keep_at, now()), nullif(btrim(coalesce(_payload->>'client_time', '')), ''), _cum_yes, _cum_fg, _cum_scrap);

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
      elsif _sk.category = any(_tray_cats) and _item.uom = 'Pcs' and _unit = 'Trays' then      -- trays are stored as a count of trays (Pcs)
        _delta := _qty;
      elsif _sk.category = any(_tray_cats) and _item.uom = 'Pcs' and _unit = 'Pallets' and coalesce(_src.trays_per_pallet, 0) > 0 then
        _delta := _qty * _src.trays_per_pallet;
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
    elsif _p.category = any(_tray_cats) and _item.uom = 'Pcs' and _unit = 'Trays' then          -- trays are stored as a count of trays (Pcs)
      _delta := _qty;
    elsif _p.category = any(_tray_cats) and _item.uom = 'Pcs' and _unit = 'Pallets' and coalesce(_src.trays_per_pallet, 0) > 0 then
      _delta := _qty * _src.trays_per_pallet;
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

  -- trays used = finished + scrap + hold   (hold is finished goods with quality in question; it is also material consumed)
  if _fg_sku_id is not null and not _used_unknown and _used_trays > 0 and (_trays + _scrap + _hold) <> _used_trays then
    raise exception 'Trays produced (%) + scrap trays (%) + hold trays (%) = %, but % trays were used. They must be equal.', _trays, _scrap, _hold, _trays + _scrap + _hold, _used_trays;
  end if;

  -- Cumulative Hold record: compulsory (Yes/No) once a tray SKU is used. It does not enter the formula above.
  if _fg_sku_id is not null and _cum_yes is null then
    raise exception 'Cumulative Hold record: select Yes or No.';
  end if;
  if _cum_fg + _cum_scrap > 0 then
    select coalesce(sum(hold_trays - cum_hold_fg_trays - cum_hold_scrap_trays), 0) into _avail
      from shift_records where product = 'factory' and fg_sku_code_id = _fg_sku_id and id <> _sr_id;
    _avail := _avail + _hold;
    if _cum_fg + _cum_scrap > _avail then
      raise exception 'Cumulative Hold record: FG trays (%) + scrap (%) is more than the % trays held so far for this SKU.', _cum_fg, _cum_scrap, _avail;
    end if;
  end if;

  -- FG trays produced: checked and recorded here; the FG pallets / QRs are made later by shift_record_generate_fg()
  -- (so loose trays left over from earlier shifts can be added in).
  if _trays + _cum_fg > 0 then
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
                           total_pcs_per_pallet = case when _trays + _cum_fg > 0 then _per end
    where id = _sr_id;

  return jsonb_build_object('id', _sr_id, 'display_id', _disp, 'fg_pallets', '[]'::jsonb, 'qr_generation_id', null);
end;
$$;
revoke all on function shift_record_save_impl(jsonb, text, uuid, timestamptz) from public;
