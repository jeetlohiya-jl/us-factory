-- Factory OS -- Goods Receipt created automatically from Zoho Books POs.
--
-- Every Zoho Books Purchase Order that is Approved and delivered to
-- Gainesville Factory becomes a Factory Goods Receipt, filled in:
--   PO Number, Vendor, and one container row per PO line that is a real SKU
--   (freight and other non-SKU lines are skipped), with
--   Shipment Number = the line's "Container:" value (HA1, V6, ...),
--   SKU from the line's item code / "Product:" value, and PO Quantity --
--   trays in pallets (Zoho counts trays each; "Trays/Combo Box" gives trays
--   per pallet), any other material in its own quantity + unit.
-- A tray row's stage (Base Tray / FNP Tray) is left blank -- chosen when the
-- container is inwarded.
--
-- Zoho calls a Supabase Edge Function (supabase/functions/zoho-po-sync),
-- which fetches the full PO from the Zoho Books API and calls
-- zoho_upsert_purchase_order() below with the service role.
-- Idempotent: the Zoho purchaseorder_id / line_item_id link means re-sends
-- and edits never duplicate. Inwarded containers are never changed.
-- Additive and re-runnable.

-- 1. Links --------------------------------------------------------------------
alter table goods_receipts add column if not exists zoho_purchaseorder_id text;
alter table goods_receipts add column if not exists zoho_status text;
alter table goods_receipts add column if not exists zoho_cancelled boolean not null default false;
alter table goods_receipts add column if not exists zoho_synced_at timestamptz;
-- Human-readable notes from the last sync (skipped lines, unmatched vendor...).
alter table goods_receipts add column if not exists zoho_sync_notes text[] not null default '{}';
create unique index if not exists uq_goods_receipts_zoho_po
  on goods_receipts (product, zoho_purchaseorder_id) where zoho_purchaseorder_id is not null;

alter table goods_receipt_entries add column if not exists zoho_line_item_id text;
-- What Zoho ordered, as Zoho counts it (e.g. 531960 ea), next to po_quantity
-- (e.g. 44 Pallets) -- kept for reference / audit.
alter table goods_receipt_entries add column if not exists zoho_quantity numeric;
alter table goods_receipt_entries add column if not exists zoho_unit text;
create index if not exists idx_gr_entries_zoho_line on goods_receipt_entries (zoho_line_item_id) where zoho_line_item_id is not null;

alter table vendors add column if not exists zoho_vendor_id text;
create index if not exists idx_vendors_zoho_vendor_id on vendors (product, zoho_vendor_id) where zoho_vendor_id is not null;

-- 2. Helpers --------------------------------------------------------------------
-- "Label: value" from a Zoho line description ("Container: HA1" -> HA1).
create or replace function zoho_desc_value(_desc text, _label text) returns text
  language sql immutable as $$
  select nullif(btrim((regexp_match(coalesce(_desc, ''), '(?im)^\s*' || _label || '\s*:\s*([^\r\n]+)'))[1]), '')
$$;

-- Zoho unit -> Goods Receipt unit.
create or replace function zoho_unit(_u text) returns text
  language sql immutable as $$
  select case
    when lower(coalesce(_u, '')) in ('kg', 'kgs', 'kilogram', 'kilograms') then 'Kgs'
    when lower(coalesce(_u, '')) in ('bag', 'bags') then 'Bags'
    when lower(coalesce(_u, '')) in ('pallet', 'pallets', 'plt') then 'Pallets'
    else 'Units' end
$$;

-- 3. Sync one Zoho PO ------------------------------------------------------------
-- _po: the Zoho Books "purchaseorder" object (GET /purchaseorders/{id}).
-- _delivery_match: text identifying the Gainesville Factory delivery location.
-- Returns {action, goods_receipt_id, notes}.
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
  _shipment text; _qty numeric; _per_box numeric; _po_qty numeric; _unit text; _cat text;
  _row goods_receipt_entries%rowtype;
  _notes text[] := '{}';
  _seen_lines text[] := '{}';
  _i int := 0;
  _item_code text; _product text;
  _is_new boolean := false;
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
    -- CMP0003P), then the description's "Product:" value (3P).
    select * into _sku from sku_codes s
      where s.product = 'factory' and s.is_active and s.sku_code is not null and s.sku_code <> ''
        and (upper(s.sku_code) = _item_code or upper(s.sku_code) = split_part(_item_code, '-', 1))
      limit 1;
    if _sku.id is null and _product is not null then
      select * into _sku from sku_codes s where s.product = 'factory' and s.is_active and upper(s.code) = upper(_product) limit 1;
    end if;
    if _sku.id is null then
      -- Freight, duties and anything else that isn't a SKU.
      _notes := _notes || format('Skipped line %s "%s" (not a SKU).', _i, coalesce(nullif(_li->>'name', ''), _item_code));
      continue;
    end if;

    _shipment := upper(coalesce(zoho_desc_value(_desc, 'Container'), zoho_desc_value(_desc, 'Container No'), ''));
    if _shipment = '' then
      _notes := _notes || format('Line %s (%s) has no "Container:" -- fill in its Shipment Number.', _i, _sku.code);
    end if;

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

    if _row.id is not null and _row.status = 'inwarded' then
      -- Received already: never changed by a later PO edit.
      update goods_receipt_entries set zoho_line_item_id = coalesce(_li->>'line_item_id', 'line-' || _i) where id = _row.id;
      continue;
    elsif _row.id is not null then
      update goods_receipt_entries set
        zoho_line_item_id = coalesce(_li->>'line_item_id', 'line-' || _i),
        shipment_number = _shipment,
        sku_code_id = _sku.id, sku_code_snapshot = _sku.code,
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
          _gr.id, _shipment, _cat, _sku.id, _ver_id, _sku.code, _ver_label,
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
-- Only the Edge Function (service role) may sync.
grant execute on function zoho_upsert_purchase_order(jsonb, text) to service_role;

-- 4. Detail JSON + Inward: tray stage chosen at inward when the PO left it blank.
create or replace function gr_detail_json(_id uuid) returns jsonb
  language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', g.id, 'po_number', g.po_number, 'category', g.category,
    'vendor_id', g.vendor_id, 'vendor_name', g.vendor_name,
    'status', g.status, 'created_at', g.created_at, 'updated_at', g.updated_at,
    'zoho_purchaseorder_id', g.zoho_purchaseorder_id, 'zoho_cancelled', g.zoho_cancelled,
    'zoho_synced_at', g.zoho_synced_at, 'zoho_sync_notes', to_jsonb(g.zoho_sync_notes),
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
revoke all on function gr_detail_json(uuid) from public;

-- _payload: {received_quantity, unit, pallet_count, category?}
create or replace function goods_receipt_inward(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _gid uuid; _gr goods_receipts%rowtype; _row goods_receipt_entries%rowtype;
  _qty numeric; _pallets numeric; _unit text; _cat text; _sku sku_codes%rowtype;
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
  if _pallets is null or _pallets < 1 or _pallets <> trunc(_pallets) then
    raise exception 'Number of Pallets must be a whole number of at least 1.';
  end if;
  if _qty is null or _qty <= 0 then raise exception 'Quantity Received must be greater than 0.'; end if;
  if _unit not in ('Pallets', 'Kgs', 'Units', 'Bags') then raise exception 'Unknown unit ''%''.', _unit; end if;

  update goods_receipt_entries set
    category = _cat,
    received_quantity = _qty, unit = _unit, pallet_count = _pallets::int,
    status = 'inwarded', inwarded_at = now(), inwarded_by = app_user_id()
  where id = _entry_id;
  update goods_receipts set updated_at = now() where id = _gid;
  perform gr_recompute_status(_gid, false);
  return gr_detail_json(_gid);
end;
$$;
revoke all on function goods_receipt_inward(uuid, jsonb) from public;
grant execute on function goods_receipt_inward(uuid, jsonb) to authenticated;

-- 5. Edit form: a tray row's stage may stay blank until inward.
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
    -- A tray row's stage may be left blank (e.g. synced from Zoho): it is
    -- chosen when the container is inwarded (goods_receipt_inward).
    if _ecat is not null and _ecat not in ('tray', 'fnp_tray', 'film', 'pad', 'polybag', 'cfb', 'glue') then
      raise exception '%: unknown category ''%''.', _label, _ecat;
    end if;
    if _ecat is not null and sku_family(_sku.category) <> sku_family(_ecat) then
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
      _ecat := case when sku_family(_sku.category) = 'tray' then nullif(btrim(coalesce(_e->>'category', '')), '') else _sku.category end;
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




revoke all on function goods_receipt_save(uuid, jsonb) from public;
grant execute on function goods_receipt_save(uuid, jsonb) to authenticated;
