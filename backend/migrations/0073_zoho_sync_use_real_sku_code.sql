-- Zoho PO sync: the "SKU" column on a synced Goods Receipt should show the
-- SKU CODE from the PO (Zoho's own "sku" field on the line item, e.g.
-- "PD077", "MG-201-CT"), not the SKU's descriptive name.
--
-- sku_codes has two separate text fields (see Setup -> SKUs, "SKU" vs "SKU
-- Code" columns):
--   code       -- the descriptive name, e.g. "PET Strap", "Padding glue
--                 (Jowat)", "Soaker Pad MG-201-CT"
--   sku_code   -- the real alphanumeric code, e.g. "PD077", "PD102",
--                 "MG-201-CT" -- this is exactly what Zoho's line item
--                 "sku" field carries, and what the match above (_item_code)
--                 is compared against.
--
-- goods_receipt_entries.sku_code_snapshot (displayed everywhere downstream
-- as "SKU") was always set to _sku.code -- the descriptive name -- instead
-- of _sku.sku_code. For the newer packaging/PPE/pallet secondary materials
-- this reads as e.g. "PET Strap" where the user expects "PD077" (what's
-- actually printed on the PO); for RM it reads as "Soaker Pad MG-201-CT"
-- instead of "MG-201-CT".
--
-- Fix: prefer sku_code (falling back to code only if a SKU has no sku_code
-- set at all, which can still happen for older/manually-entered SKUs).
--
-- Additive and re-runnable; only this one function is redefined.

create or replace function zoho_upsert_purchase_order(_po jsonb, _delivery_match text default 'gainesville factory')
returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _zid text := _po->>'purchaseorder_id';
  _po_number text := upper(btrim(coalesce(_po->>'purchaseorder_number', '')));
  _status text := lower(coalesce(_po->>'status', ''));
  _delivery text := lower(concat_ws(' ',
      _po->>'location_name', _po->>'warehouse_name', _po->>'branch_name', _po->>'delivery_address_name',
      (_po->'delivery_address')::text, _po->>'delivery_org_address_id'));
  _gr goods_receipts%rowtype;
  _vendor vendors%rowtype;
  _li jsonb; _desc text; _sku sku_codes%rowtype; _ver_id uuid; _ver_label text;
  _shipment text; _qty numeric; _per_box numeric; _po_qty numeric; _unit text; _cat text; _sku_label text;
  _row goods_receipt_entries%rowtype;
  _notes text[] := '{}';
  _seen_lines text[] := '{}';
  _i int := 0;
  _item_code text; _product text;
  _is_new boolean := false;
  _auto_generated boolean;
begin
  if _zid is null or _po_number = '' then
    raise exception 'Zoho purchase order is missing purchaseorder_id / purchaseorder_number.';
  end if;

  select * into _gr from goods_receipts
    where product = 'factory' and (zoho_purchaseorder_id = _zid or upper(btrim(po_number)) = _po_number)
    order by (zoho_purchaseorder_id = _zid) desc nulls last
    limit 1
    for update;

  -- Only POs delivered to Gainesville Factory are Factory's.
  if position(lower(_delivery_match) in _delivery) = 0 then
    return jsonb_build_object('action', 'ignored', 'reason', 'not delivered to Gainesville Factory');
  end if;

  -- Cancelled in Zoho: flag an existing receipt (never delete -- it may
  -- already have inwarded containers / pallets); ignore otherwise.
  if _status in ('cancelled', 'void') then
    if _gr.id is null then
      return jsonb_build_object('action', 'ignored', 'reason', 'cancelled');
    end if;
    update goods_receipts set zoho_cancelled = true, zoho_status = _status, zoho_synced_at = now(), updated_at = now()
      where id = _gr.id;
    return jsonb_build_object('action', 'cancelled', 'goods_receipt_id', _gr.id);
  end if;

  -- A new receipt is created only once the PO is Approved. Later edits of an
  -- already-synced PO (issued / partially billed ...) keep it up to date.
  if _gr.id is null and _status <> 'approved' then
    return jsonb_build_object('action', 'ignored', 'reason', 'status is ' || coalesce(nullif(_status, ''), 'unknown') || ', not approved');
  end if;

  -- Vendor: remembered Zoho vendor id, else the Factory vendor whose name
  -- matches or appears in Zoho's ("MIDA" in "TaiShan MIDA Eco-Friendly ...").
  select * into _vendor from vendors where product = 'factory' and zoho_vendor_id = _po->>'vendor_id' limit 1;
  if _vendor.id is null then
    select * into _vendor from vendors
      where product = 'factory' and is_active
        and (lower(name) = lower(_po->>'vendor_name') or position(lower(name) in lower(coalesce(_po->>'vendor_name', ''))) > 0)
      order by length(name) desc limit 1;
    if _vendor.id is not null and _po->>'vendor_id' is not null then
      update vendors set zoho_vendor_id = _po->>'vendor_id'
        where product = 'factory' and lower(name) = lower(_vendor.name) and zoho_vendor_id is null;
    end if;
  end if;
  if _vendor.id is null then
    _notes := _notes || format('Vendor "%s" is not in Setup -> Vendors; add it so pallet numbers use its country.', _po->>'vendor_name');
  end if;

  if _gr.id is null then
    insert into goods_receipts (product, po_number, vendor_id, vendor_name, status, zoho_purchaseorder_id, zoho_status, zoho_synced_at)
      values ('factory', _po_number, _vendor.id, coalesce(_vendor.name, _po->>'vendor_name', 'Unknown vendor'), 'pending', _zid, _status, now())
      returning * into _gr;
    _is_new := true;
  else
    update goods_receipts set
      zoho_purchaseorder_id = _zid, zoho_status = _status, zoho_cancelled = false, zoho_synced_at = now(), updated_at = now(),
      -- Header stays as it is once anything is inwarded (pallets reference it).
      vendor_id = case when exists (select 1 from goods_receipt_entries where goods_receipt_id = _gr.id and status = 'inwarded') then vendor_id else coalesce(_vendor.id, vendor_id) end,
      vendor_name = case when exists (select 1 from goods_receipt_entries where goods_receipt_id = _gr.id and status = 'inwarded') then vendor_name else coalesce(_vendor.name, vendor_name) end
    where id = _gr.id;
  end if;

  for _li in select * from jsonb_array_elements(coalesce(_po->'line_items', '[]'::jsonb)) loop
    _i := _i + 1;
    _desc := coalesce(_li->>'description', '');
    _item_code := upper(btrim(coalesce(nullif(_li->>'sku', ''), split_part(coalesce(_li->>'name', ''), ' ', 1))));
    _product := zoho_desc_value(_desc, 'Product');
    _sku := null;
    -- SKU: SKU Code (item code, or its part before "-": CMP0003P-P200 ->
    -- CMP0003P; or a sku_code that's the item code PLUS a suffix Zoho
    -- doesn't carry, e.g. item "MG-201" -> sku_code "MG-201-CT" -- an
    -- exact match wins over a suffix match when both exist), then the
    -- description's "Product:" value (3P).
    select * into _sku from sku_codes s
      where s.product = 'factory' and s.is_active and s.sku_code is not null and s.sku_code <> ''
        and (upper(s.sku_code) = _item_code
             or upper(s.sku_code) = split_part(_item_code, '-', 1)
             or upper(s.sku_code) like _item_code || '-%')
      order by (upper(s.sku_code) = _item_code) desc, length(s.sku_code) asc
      limit 1;
    if _sku.id is null and _product is not null then
      select * into _sku from sku_codes s where s.product = 'factory' and s.is_active and upper(s.code) = upper(_product) limit 1;
    end if;
    if _sku.id is null then
      -- Freight, duties and anything else that isn't a SKU.
      _notes := _notes || format('Skipped line %s "%s" (not a SKU).', _i, coalesce(nullif(_li->>'name', ''), _item_code));
      continue;
    end if;

    -- The label snapshotted onto the entry, and shown everywhere downstream
    -- as "SKU" -- the real alphanumeric SKU Code from the PO (what's
    -- actually printed on it, e.g. "PD077"), not the descriptive name
    -- ("PET Strap"). Falls back to the descriptive name only if a SKU was
    -- never given a real SKU Code in Setup.
    _sku_label := coalesce(nullif(btrim(_sku.sku_code), ''), _sku.code);

    _shipment := upper(coalesce(zoho_desc_value(_desc, 'Container'), zoho_desc_value(_desc, 'Container No'), ''));

    _qty := coalesce(nullif(_li->>'quantity', '')::numeric, 0);
    if sku_family(_sku.category) = 'tray' then
      -- Trays are counted in pallets: one pallet = one combo box.
      _per_box := nullif(regexp_replace(coalesce(zoho_desc_value(_desc, 'Trays/Combo Box'), ''), '[^0-9.]', '', 'g'), '')::numeric;
      if _per_box is not null and _per_box > 0 then
        _po_qty := ceil(_qty / _per_box);
      else
        _po_qty := _qty;
        _notes := _notes || format('Line %s (%s) has no "Trays/Combo Box" -- PO Quantity left as %s trays; check it.', _i, _sku.code, _qty);
      end if;
      _unit := 'Pallets';
      _cat := null;  -- Base Tray / FNP Tray is chosen at Goods Receipt.
    else
      _po_qty := _qty;
      _unit := zoho_unit(_li->>'unit');
      _cat := _sku.category;
    end if;
    if _po_qty <= 0 then
      _notes := _notes || format('Skipped line %s (%s): quantity is 0.', _i, _sku.code);
      continue;
    end if;

    -- Version: the SKU's only active version, else chosen at Goods Receipt.
    _ver_id := null; _ver_label := null;
    if (select count(*) from sku_versions where sku_code_id = _sku.id and is_active) = 1 then
      select id, version into _ver_id, _ver_label from sku_versions where sku_code_id = _sku.id and is_active;
    end if;

    _seen_lines := _seen_lines || coalesce(_li->>'line_item_id', 'line-' || _i);

    _row := null;
    select * into _row from goods_receipt_entries
      where goods_receipt_id = _gr.id
        and (zoho_line_item_id = coalesce(_li->>'line_item_id', 'line-' || _i)
             or (zoho_line_item_id is null and upper(btrim(shipment_number)) = _shipment and sku_code_id = _sku.id))
      limit 1;

    -- Trays still need the real container id -- nothing to auto-generate,
    -- keep asking. Everything else: Zoho gave no "Container:" this time,
    -- so keep whatever Shipment Number the line already has (auto-generated
    -- or typed in by hand) instead of wiping it back to blank; a line with
    -- nothing yet gets a fresh AUTO-#### now, generated once.
    _auto_generated := false;
    if _shipment = '' then
      if sku_family(_sku.category) = 'tray' then
        _notes := _notes || format('Line %s (%s) has no "Container:" -- fill in its Shipment Number.', _i, _sku.code);
      elsif _row.id is not null and coalesce(btrim(_row.shipment_number), '') <> '' then
        _shipment := _row.shipment_number;
      else
        _shipment := 'AUTO-' || lpad(factory_next_seq('zoho_auto_shipment')::text, 4, '0');
        _auto_generated := true;
      end if;
    end if;

    if _row.id is not null and _row.status = 'inwarded' then
      -- Received already: never changed by a later PO edit.
      update goods_receipt_entries set zoho_line_item_id = coalesce(_li->>'line_item_id', 'line-' || _i) where id = _row.id;
      continue;
    elsif _row.id is not null then
      update goods_receipt_entries set
        zoho_line_item_id = coalesce(_li->>'line_item_id', 'line-' || _i),
        shipment_number = _shipment,
        sku_code_id = _sku.id, sku_code_snapshot = _sku_label,
        sku_version_id = coalesce(sku_version_id, _ver_id),
        sku_version_snapshot = coalesce(sku_version_snapshot, _ver_label),
        category = case when sku_family(_sku.category) = 'tray' and category in ('tray', 'fnp_tray') then category else _cat end,
        po_quantity = _po_qty, unit = _unit, zoho_quantity = _qty, zoho_unit = _li->>'unit', sort_order = _i
      where id = _row.id;
    else
      begin
        insert into goods_receipt_entries (
          goods_receipt_id, shipment_number, category, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
          po_quantity, unit, sort_order, status, zoho_line_item_id, zoho_quantity, zoho_unit
        ) values (
          _gr.id, _shipment, _cat, _sku.id, _ver_id, _sku_label, _ver_label,
          _po_qty, _unit, _i, 'pending', coalesce(_li->>'line_item_id', 'line-' || _i), _qty, _li->>'unit'
        );
      exception when unique_violation then
        -- Same container + SKU listed twice on the PO: add the quantities.
        update goods_receipt_entries set po_quantity = po_quantity + _po_qty, zoho_quantity = coalesce(zoho_quantity, 0) + _qty
          where goods_receipt_id = _gr.id and upper(btrim(shipment_number)) = _shipment and sku_code_id = _sku.id
            and coalesce(sku_version_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(_ver_id, '00000000-0000-0000-0000-000000000000'::uuid)
            and status = 'pending';
        _notes := _notes || format('%s / %s appears more than once on the PO; quantities were added together.', _shipment, _sku.code);
      end;
    end if;

    if _auto_generated then
      _notes := _notes || format('Line %s (%s) has no "Container:" on the PO -- Shipment Number %s was auto-generated.', _i, _sku.code, _shipment);
    end if;
  end loop;

  -- Lines removed from the PO in Zoho: remove their still-pending rows
  -- (never inwarded ones, never rows typed in by hand).
  delete from goods_receipt_entries
    where goods_receipt_id = _gr.id and status = 'pending'
      and zoho_line_item_id is not null and not (zoho_line_item_id = any(_seen_lines));

  update goods_receipts set zoho_sync_notes = _notes where id = _gr.id;
  perform gr_recompute_status(_gr.id, false);
  return jsonb_build_object('action', case when _is_new then 'created' else 'updated' end, 'goods_receipt_id', _gr.id, 'notes', to_jsonb(_notes));
end;
$$;

revoke all on function zoho_upsert_purchase_order(jsonb, text) from public;
revoke all on function zoho_upsert_purchase_order(jsonb, text) from authenticated;

-- One-time backfill: fix the "SKU" label already snapshotted onto every
-- Zoho-synced Goods Receipt entry so far (both pending AND already-inwarded
-- rows -- this is a display label only, it never touches quantities,
-- pallets or anything else, so it's safe to correct everywhere at once
-- rather than waiting for a future resync that inwarded rows will never
-- get). Only touches entries that came from Zoho and whose current
-- snapshot doesn't already match the correct label.
update goods_receipt_entries e
set sku_code_snapshot = coalesce(nullif(btrim(s.sku_code), ''), s.code)
from sku_codes s
where e.sku_code_id = s.id
  and e.zoho_line_item_id is not null
  and e.sku_code_snapshot is distinct from coalesce(nullif(btrim(s.sku_code), ''), s.code);
