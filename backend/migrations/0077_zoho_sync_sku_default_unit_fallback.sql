-- Zoho PO sync: fall back to a per-SKU default unit when Zoho sends none.
--
-- CIPO-00537's PET Strap/Corner Protector/Stretch wrap lines all have an
-- EMPTY "unit" field in the actual Zoho payload (confirmed by querying
-- goods_receipt_entries.zoho_unit -- it's '', not just unmapped text). No
-- amount of extending zoho_unit()'s text mapping (migration 0076) can turn
-- nothing into "Rolls" -- the raw value simply isn't there. This is Zoho's
-- Item master for these SKUs never having a Unit set, and it will keep
-- happening for any SKU whose Zoho Item is set up the same way.
--
-- Fix: give sku_codes a per-SKU default_unit (editable in Setup -> SKUs,
-- same place sku_code already is), and use it whenever Zoho's own line
-- doesn't carry a usable unit. Zoho's unit still wins when it sends one --
-- this is only a fallback for exactly the case that broke CIPO-00537.
--
-- Backfills default_unit for the specific SKUs already known to need it
-- (from the reference sheet given for these secondary materials) and
-- recomputes the unit already stored on existing entries for them.
--
-- Additive and re-runnable; only this one function is redefined.

alter table sku_codes add column if not exists default_unit text null;

update sku_codes set default_unit = v.unit
from (values
  ('PD077', 'Rolls'),   -- PET Strap
  ('PD078', 'Pcs'),     -- Corner Protector
  ('PD079', 'Rolls'),   -- Stretch wrap
  ('PD098', 'Pcs'),     -- Pallets
  ('PD099', 'Pcs'),     -- Combo boxes
  ('PEB0001', 'Pcs'),   -- Polybag 1300*900mm
  ('PD100', 'Pcs'),     -- Polybags 1800*900mm (3P & 3D)
  ('PD101', 'Pcs'),     -- Polybags 1800*900mm (7S & 8P)
  ('PD081', 'Kgs'),     -- Padding glue (Biobond)
  ('PD102', 'Kgs'),     -- Padding glue (Jowat)
  ('PD070', 'Pairs'),   -- Shoe Cover
  ('PD225', 'Pcs'),     -- Hairnets
  ('PD293', 'Pcs'),     -- Face Mask
  ('PD481', 'Pcs'),     -- Beard Mask
  ('PD147', 'Pairs'),   -- Hand Gloves
  ('PD483', 'Pcs'),     -- Disposable Apron
  ('PD550', 'Pcs')      -- Glue sticks
) as v(sku_code, unit)
where sku_codes.product = 'factory' and sku_codes.sku_code = v.sku_code and sku_codes.default_unit is null;

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
  _line_count int := 0;
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

  if position(lower(_delivery_match) in _delivery) = 0 then
    return jsonb_build_object('action', 'ignored', 'reason', 'not delivered to Gainesville Factory');
  end if;

  if _status in ('cancelled', 'void') then
    if _gr.id is null then
      return jsonb_build_object('action', 'ignored', 'reason', 'cancelled');
    end if;
    update goods_receipts set zoho_cancelled = true, zoho_status = _status, zoho_synced_at = now(), updated_at = now()
      where id = _gr.id;
    return jsonb_build_object('action', 'cancelled', 'goods_receipt_id', _gr.id);
  end if;

  if _gr.id is null and _status <> 'approved' then
    return jsonb_build_object('action', 'ignored', 'reason', 'status is ' || coalesce(nullif(_status, ''), 'unknown') || ', not approved');
  end if;

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
      vendor_id = case when exists (select 1 from goods_receipt_entries where goods_receipt_id = _gr.id and status = 'inwarded') then vendor_id else coalesce(_vendor.id, vendor_id) end,
      vendor_name = case when exists (select 1 from goods_receipt_entries where goods_receipt_id = _gr.id and status = 'inwarded') then vendor_name else coalesce(_vendor.name, vendor_name) end
    where id = _gr.id;
  end if;

  _line_count := jsonb_array_length(coalesce(_po->'line_items', '[]'::jsonb));

  for _li in select * from jsonb_array_elements(coalesce(_po->'line_items', '[]'::jsonb)) loop
    _i := _i + 1;
    _desc := coalesce(_li->>'description', '');
    _item_code := upper(btrim(coalesce(nullif(_li->>'sku', ''), split_part(coalesce(_li->>'name', ''), ' ', 1))));
    _product := zoho_desc_value(_desc, 'Product');
    _sku := null;
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
      _notes := _notes || format('Skipped line %s "%s" (not a SKU) -- Zoho sku="%s", name="%s".',
        _i, coalesce(nullif(_li->>'name', ''), _item_code), coalesce(_li->>'sku', ''), coalesce(_li->>'name', ''));
      continue;
    end if;

    _sku_label := coalesce(nullif(btrim(_sku.sku_code), ''), _sku.code);

    _shipment := upper(coalesce(zoho_desc_value(_desc, 'Container'), zoho_desc_value(_desc, 'Container No'), ''));

    _qty := coalesce(nullif(_li->>'quantity', '')::numeric, 0);
    if sku_family(_sku.category) = 'tray' then
      _per_box := nullif(regexp_replace(coalesce(zoho_desc_value(_desc, 'Trays/Combo Box'), ''), '[^0-9.]', '', 'g'), '')::numeric;
      if _per_box is not null and _per_box > 0 then
        _po_qty := ceil(_qty / _per_box);
      else
        _po_qty := _qty;
        _notes := _notes || format('Line %s (%s) has no "Trays/Combo Box" -- PO Quantity left as %s trays; check it.', _i, _sku.code, _qty);
      end if;
      _unit := 'Pallets';
      _cat := null;
    else
      _po_qty := _qty;
      -- Zoho's own unit wins when it sent one; otherwise fall back to this
      -- SKU's own default (Setup -> SKUs), and only then to generic "Units".
      _unit := case when nullif(btrim(_li->>'unit'), '') is not null then zoho_unit(_li->>'unit') else coalesce(_sku.default_unit, 'Units') end;
      _cat := _sku.category;
    end if;
    if _po_qty <= 0 then
      _notes := _notes || format('Skipped line %s (%s): quantity is 0.', _i, _sku.code);
      continue;
    end if;

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

  if _line_count = 0 or array_length(_seen_lines, 1) > 0 then
    delete from goods_receipt_entries
      where goods_receipt_id = _gr.id and status = 'pending'
        and zoho_line_item_id is not null and not (zoho_line_item_id = any(_seen_lines));
  elsif exists (select 1 from goods_receipt_entries where goods_receipt_id = _gr.id) then
    _notes := array_prepend(
      format('This sync matched NONE of this PO''s %s line item(s) to a SKU -- existing containers were left untouched rather than removed. Check that each line is picked from the SKU catalog in Zoho (see the "not a SKU" notes below for which lines failed).', _line_count),
      _notes
    );
  end if;

  update goods_receipts set zoho_sync_notes = _notes where id = _gr.id;
  perform gr_recompute_status(_gr.id, false);
  return jsonb_build_object('action', case when _is_new then 'created' else 'updated' end, 'goods_receipt_id', _gr.id, 'notes', to_jsonb(_notes));
end;
$$;

revoke all on function zoho_upsert_purchase_order(jsonb, text) from public;
revoke all on function zoho_upsert_purchase_order(jsonb, text) from authenticated;

-- One-time backfill: recompute the unit on every existing Zoho-synced entry
-- whose SKU now has a default_unit and whose own raw zoho_unit was blank
-- (this is exactly CIPO-00537's AUTO-0009/10/11 rows, and any other PO in
-- the same situation). Display-only, safe for inwarded rows too.
update goods_receipt_entries e
set unit = s.default_unit
from sku_codes s
where e.sku_code_id = s.id
  and e.zoho_line_item_id is not null
  and coalesce(nullif(btrim(e.zoho_unit), ''), '') = ''
  and s.default_unit is not null
  and e.unit is distinct from s.default_unit;
