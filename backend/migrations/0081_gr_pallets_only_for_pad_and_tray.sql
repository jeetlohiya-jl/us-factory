-- Goods Receipt Inward: Quantity (Pallets) is only meaningful for materials
-- that genuinely arrive on pallets -- trays (always via the full Inward
-- Vehicle Inspection wizard) and Soaker Pad (the one auto-shipment material
-- that does come on pallets, per spec 2026-09-30). Every other
-- auto-shipment material (Polybag/CFB/Glue/...) is now inwarded with an
-- actual Quantity Received + Unit instead (GrQuickInwardForm.tsx) and has
-- no pallet count at all -- previously goods_receipt_inward/_inward_remaining
-- required a pallet_count unconditionally, which would have rejected these
-- with "Number of Pallets must be a whole number of at least 1." the moment
-- the frontend stopped sending one.
--
-- Additive and re-runnable; only these two functions are redefined,
-- carrying forward 0080 unchanged apart from making pallet_count
-- conditionally required.

create or replace function goods_receipt_inward(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _gid uuid; _gr goods_receipts%rowtype; _row goods_receipt_entries%rowtype;
  _qty numeric; _pallets numeric; _unit text; _cat text; _sku sku_codes%rowtype;
  _qr_qty numeric; _pallets_required boolean;
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
  if _gr.zoho_cancelled then
    raise exception using errcode = '23503', message = 'This PO was cancelled in Zoho -- containers can''t be inwarded.';
  end if;
  select * into _row from goods_receipt_entries where id = _entry_id for update;
  if _row.status = 'inwarded' then
    return gr_detail_json(_gid);
  end if;
  if coalesce(btrim(_row.shipment_number), '') = '' then
    raise exception 'Fill in this container''s Shipment Number (Edit) before inwarding it.';
  end if;

  -- A tray row synced from Zoho has no stage yet: it is chosen here.
  _cat := _row.category;
  select * into _sku from sku_codes where id = _row.sku_code_id;
  if _cat is null and sku_family(_sku.category) = 'tray' then
    _cat := nullif(btrim(coalesce(_payload->>'category', '')), '');
    if _cat is null or _cat not in ('tray', 'fnp_tray') then
      raise exception 'Choose Base Tray or FNP Tray for %.', _row.shipment_number;
    end if;
  end if;

  _qty := nullif(_payload->>'received_quantity', '')::numeric;
  _pallets := nullif(_payload->>'pallet_count', '')::numeric;
  _unit := coalesce(_payload->>'unit', _row.unit);
  -- Only a Tray or Soaker Pad ("pad") genuinely arrives on pallets --
  -- everything else auto-shipment is received by Quantity + Unit instead,
  -- with no pallet count at all.
  _pallets_required := sku_family(_cat) = 'tray' or _cat = 'pad';
  if _pallets_required then
    if _pallets is null or _pallets < 1 or _pallets <> trunc(_pallets) then
      raise exception 'Number of Pallets must be a whole number of at least 1.';
    end if;
  elsif _pallets is not null and (_pallets < 1 or _pallets <> trunc(_pallets)) then
    raise exception 'Number of Pallets must be a whole number of at least 1.';
  end if;
  if _qty is null or _qty <= 0 then raise exception 'Quantity Received must be greater than 0.'; end if;
  if _unit not in ('Pallets', 'Kgs', 'Units', 'Bags', 'Rolls', 'Pairs', 'Sets', 'Pcs') then
    raise exception 'Unknown unit ''%''.', _unit;
  end if;

  _qr_qty := nullif(_payload->>'qr_quantity', '')::numeric;
  if _qr_qty is not null and (_qr_qty < 1 or _qr_qty <> trunc(_qr_qty)) then
    raise exception 'Number of QR codes to generate must be a whole number of at least 1.';
  end if;

  update goods_receipt_entries set
    category = _cat,
    received_quantity = _qty, unit = _unit, pallet_count = _pallets::int,
    qr_quantity = coalesce(_qr_qty::int, qr_quantity),
    status = 'inwarded', inwarded_at = now(), inwarded_by = app_user_id()
  where id = _entry_id;
  insert into goods_receipt_inward_events (entry_id, kind, received_quantity, unit, pallet_count, inwarded_by)
    values (_entry_id, 'initial', _qty, _unit, _pallets::int, app_user_id());
  -- Inventory update (migration 0059): the full quantity received on this
  -- first inward becomes this container's one inventory_sources row.
  perform inventory_apply_receipt(_entry_id, _qty);
  update goods_receipts set updated_at = now() where id = _gid;
  perform gr_recompute_status(_gid, false);
  return gr_detail_json(_gid);
end;
$$;
revoke all on function goods_receipt_inward(uuid, jsonb) from public;
grant execute on function goods_receipt_inward(uuid, jsonb) to authenticated;

create or replace function goods_receipt_inward_remaining(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _row goods_receipt_entries%rowtype; _gr goods_receipts%rowtype;
  _pallets numeric; _qty numeric; _tray boolean; _left numeric; _qr_qty numeric;
  _cat text; _pallets_required boolean;
begin
  if not app_can('goods_receipt', 'fill_section') then
    raise exception using errcode = '42501', message = 'You do not have permission to inward containers.';
  end if;
  select * into _row from goods_receipt_entries where id = _entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Container entry not found.'; end if;
  select * into _gr from goods_receipts where id = _row.goods_receipt_id for update;
  if _gr.zoho_cancelled then
    raise exception using errcode = '23503', message = 'This PO was cancelled in Zoho -- containers can''t be inwarded.';
  end if;
  if _row.status <> 'inwarded' then
    raise exception using errcode = '23503', message = 'Inward this container first.';
  end if;

  _cat := coalesce(_row.category, (select category from sku_codes where id = _row.sku_code_id));
  _tray := sku_family(_cat) = 'tray';
  _pallets_required := _tray or _cat = 'pad';
  _left := _row.po_quantity - coalesce(_row.received_quantity, 0);
  if _left <= 0 then
    raise exception using errcode = '23503', message = format('%s has already received its full PO quantity.', _row.shipment_number);
  end if;
  _pallets := nullif(_payload->>'pallet_count', '')::numeric;
  if _pallets_required then
    if _pallets is null or _pallets < 1 or _pallets <> trunc(_pallets) then
      raise exception 'Number of Pallets must be a whole number of at least 1.';
    end if;
  elsif _pallets is not null and (_pallets < 1 or _pallets <> trunc(_pallets)) then
    raise exception 'Number of Pallets must be a whole number of at least 1.';
  end if;
  -- Trays are counted in pallets; other materials in their PO unit.
  _qty := case when _tray then _pallets else nullif(_payload->>'received_quantity', '')::numeric end;
  if _qty is null or _qty <= 0 then raise exception 'Quantity Received must be greater than 0.'; end if;
  if _qty > _left then
    raise exception '% has only % % left to receive on this PO.', _row.shipment_number, trim(to_char(_left, 'FM999999999990.###')), _row.unit;
  end if;

  _qr_qty := nullif(_payload->>'qr_quantity', '')::numeric;
  if _qr_qty is not null and (_qr_qty < 1 or _qr_qty <> trunc(_qr_qty)) then
    raise exception 'Number of QR codes to generate must be a whole number of at least 1.';
  end if;

  update goods_receipt_entries set
    received_quantity = coalesce(received_quantity, 0) + _qty,
    pallet_count = case when _pallets is not null then coalesce(pallet_count, 0) + _pallets::int else pallet_count end,
    qr_quantity = case when _qr_qty is not null then coalesce(qr_quantity, 0) + _qr_qty::int else qr_quantity end
  where id = _entry_id;
  insert into goods_receipt_inward_events (entry_id, kind, received_quantity, unit, pallet_count, inwarded_by)
    values (_entry_id, 'remaining', _qty, _row.unit, _pallets::int, app_user_id());
  -- Inventory update (migration 0059): just the increment received on
  -- this later delivery grows the container's existing inventory_sources
  -- row (see inventory_apply_receipt's on-conflict-do-update).
  perform inventory_apply_receipt(_entry_id, _qty);
  -- The container's one RM QR batch grows; "Generate QRs" adds the new
  -- pallets -- by qr_quantity's delta when given, else by pallet count
  -- (unchanged default; null pallet count leaves the batch's quantity
  -- untouched here since there's nothing to add from this signal).
  update qr_generation_records set quantity = quantity + coalesce(_qr_qty::int, _pallets::int, 0), status = 'pending'
    where source_goods_receipt_entry_id = _entry_id;
  update goods_receipts set updated_at = now() where id = _row.goods_receipt_id;
  return gr_detail_json(_row.goods_receipt_id);
end;
$$;
revoke all on function goods_receipt_inward_remaining(uuid, jsonb) from public;
grant execute on function goods_receipt_inward_remaining(uuid, jsonb) to authenticated;
