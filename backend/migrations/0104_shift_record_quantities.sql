-- 0104 -- Shift Record, round 2: per-material quantities (Pallets/Trays, Pcs, Boxes, Kgs), Production-style pallet
-- calculation (full pallets only; the rest are Loose Trays) and a scrap reason. Run after 0103. Re-runnable.
--   * a scanned pallet can be used in part: "Trays" for tray pallets, "Pcs" for pads, "Boxes"/"Kgs" for glue ...; using
--     as much as the pallet holds (when known) uses the pallet up, less leaves it in stock (off its shelf, as before),
--   * FG pallets = trays produced / Total Pcs per Pallet, whole pallets only; the remainder is recorded as Loose Trays
--     (no pallet / QR for them), exactly as the Production screen shows it,
--   * scrap trays stay a field of their own (with an optional reason), apart from produced and loose trays.
alter table shift_records add column if not exists loose_trays integer not null default 0;
alter table shift_records add column if not exists scrap_reason text;

-- Looks a scanned RM pallet up and says whether it can go on a Shift Record.
create or replace function shift_record_scan_preview(_scan text, _sku_code_id uuid) returns jsonb
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
revoke all on function shift_record_scan_preview(text, uuid) from public;
grant execute on function shift_record_scan_preview(text, uuid) to authenticated;


create or replace function shift_record_save(_payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _date date; _shift text; _machine machines%rowtype; _line jsonb; _ord int := 0; _code text;
  _p pallets%rowtype; _e goods_receipt_entries%rowtype; _src inventory_sources%rowtype; _item inventory_items%rowtype;
  _unit text; _qty numeric; _full boolean; _delta numeric; _boxes numeric; _trays_delta numeric; _cap numeric; _adj uuid; _boxes2 numeric; _loose int; _scrap_reason text; _loc uuid;
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
  _scrap_reason := nullif(btrim(coalesce(_payload->>'scrap_reason', '')), '');
  _scrap := coalesce(nullif(_payload->>'scrap_trays', '')::numeric, 0)::int;
  if _trays < 0 or _scrap < 0 then raise exception 'Trays produced and scrap trays cannot be negative.'; end if;

  _disp := 'SR-' || lpad(factory_next_seq('shift_record')::text, 4, '0');
  insert into shift_records (id, product, display_id, record_date, shift, machine_id, trays_produced, scrap_trays, scrap_reason, notes,
                             recorded_by, client_time)
    values (_sr_id, 'factory', _disp, _date, _shift, _machine.id, _trays, _scrap, _scrap_reason, nullif(btrim(coalesce(_payload->>'notes', '')), ''),
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
    _n := _trays / _per;                    -- full pallets only (as Production does)
    _loose := _trays - _n * _per;           -- trays that do not make a full pallet
    if _n > 0 then
      insert into qr_generation_records (product, batch_display_id, qr_type, category, shipment_number, sku_code_id, sku_version_id,
                                         sku_code_snapshot, sku_version_snapshot, country_code, quantity, status, generated_at)
        values ('factory', 'FGQR-' || lpad(factory_next_seq('qr_batch:fg')::text, 4, '0'), 'fg', 'fgtray', _shipment, _fg_sku.id, _fg_ver_id,
                coalesce(nullif(btrim(_fg_sku.sku_code), ''), _fg_sku.code), _fg_ver.version, 'US', _n, 'generated', now())
        returning * into _b;
      for _k in 1.._n loop
        _did := 'US-PLT-' || _yymm || '-' || lpad(factory_next_seq('pallet:US-PLT')::text, 4, '0');
        insert into pallets (product, display_id, pallet_type, category, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
                             shipment_number, source_qr_generation_id, source_machine_id, lifecycle_status, qr_payload)
          values ('factory', _did, 'fg', 'fgtray', _fg_sku.id, _fg_ver_id, coalesce(nullif(btrim(_fg_sku.sku_code), ''), _fg_sku.code), _fg_ver.version,
                  _shipment, _b.id, _machine.id, 'generated',
                  json_build_object('t', 'fg_pallet', 'id', _did, 'run', _disp, 'sku', _fg_sku.code)::text)
          returning id into _pid;
        insert into pallet_lifecycle_events (pallet_id, stage, metadata, actor_user_id, occurred_at)
          values (_pid, 'generated', jsonb_build_object('shift_record', _disp, 'batch', _b.batch_display_id, 'trays', _per,
                                                         'machine', _machine.code, 'shift', _shift), _by, now());
        _pallets := _pallets || jsonb_build_object('id', _pid, 'display_id', _did, 'trays', _per);
      end loop;
    end if;
    update shift_records set fg_sku_code_id = _fg_sku.id, fg_sku_version_id = _fg_ver_id, fg_sku_code_snapshot = _fg_sku.code,
                             fg_sku_version_snapshot = _fg_ver.version, total_pcs_per_pallet = _per, fg_pallets = _n, loose_trays = _loose,
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

