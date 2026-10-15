-- 0085: India Factory -- Number of Pallets is asked for trays only.
--
-- Only goods_receipt_inward changes (copied verbatim from 0082 except the
-- _pallets_required rule below). For the Factory product the rule is
-- unchanged. A pad's pallet count, when supplied, is still validated and
-- stored; it is just no longer required for India Factory.
-- Re-runnable (create or replace).

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
    if _cat is null or _cat not in ('tray', 'fnp_tray', 'lnp_tray') then
      raise exception 'Choose RM Tray or LNP Tray for %.', _row.shipment_number;
    end if;
  end if;

  -- US Factory: Inward Vehicle Inspection is compulsory for RM / LNP Trays
  -- (optional for every other material) -- enforced here, not just in the UI.
  if app_request_product() = 'us_factory' and sku_family(_cat) = 'tray'
     and not exists (select 1 from inward_vehicle_inspections
                     where source_goods_receipt_entry_id = _entry_id and status = 'approved') then
    raise exception using errcode = '23503',
      message = 'Complete the Inward Vehicle Inspection for ' || _row.shipment_number || ' before inwarding a tray.';
  end if;

  _qty := nullif(_payload->>'received_quantity', '')::numeric;
  _pallets := nullif(_payload->>'pallet_count', '')::numeric;
  _unit := coalesce(_payload->>'unit', _row.unit);
  -- Only a Tray or Soaker Pad ("pad") genuinely arrives on pallets --
  -- everything else auto-shipment is received by Quantity + Unit instead,
  -- with no pallet count at all.
  -- India Factory (us_factory): ONLY trays are counted in pallets; every other
  -- material (Soaker Pad included) is received by Quantity + Unit alone.
  -- Factory keeps its original rule (tray or Soaker Pad needs a pallet count).
  _pallets_required := sku_family(_cat) = 'tray'
    or (_cat = 'pad' and app_request_product() <> 'us_factory');
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
  -- Inventory is a Factory-only module (the US Factory sidebar has none).
  if app_request_product() = 'factory' then
    perform inventory_apply_receipt(_entry_id, _qty);
  end if;
  update goods_receipts set updated_at = now() where id = _gid;
  perform gr_recompute_status(_gid, false);
  -- US Factory: every non-tray entry goes straight to Inward QC as Pending
  -- once inwarded. A tray's QC waits for its per-pallet Batch Numbers
  -- (goods_receipt_save_batch_numbers), the last step of its inward.
  if app_request_product() = 'us_factory' and sku_family(_cat) <> 'tray' then
    perform gr_ensure_qc(_entry_id);
  end if;
  return gr_detail_json(_gid);
end;
$$;
revoke all on function goods_receipt_inward(uuid, jsonb) from public;
grant execute on function goods_receipt_inward(uuid, jsonb) to authenticated;
