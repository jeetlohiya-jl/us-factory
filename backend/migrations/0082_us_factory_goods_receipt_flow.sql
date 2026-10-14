-- US Factory: Goods Receipt becomes the first module (2026-10-14).
--
--   Zoho PO -> Goods Receipt -> Inward (Inward Vehicle Inspection, mandatory
--   for RM / LNP Trays only) -> per-pallet Batch Numbers (trays only) ->
--   Inward QC (+ COA) -> RM QR Generation -> RM Storage.
--
-- This migration is the database half:
--   * zoho_upsert_purchase_order gets a third argument, the unit the PO
--     belongs to ('factory' | 'us_factory'); Factory's calls are unchanged.
--     For US Factory it also reads "Pcs/Combo" as the pallet size and splits a
--     tray line covering several containers ("Container: H5 & H6") into one
--     entry per container.
--   * goods_receipt_save / _inward / _inward_remaining / _generate_pallets
--     work for either unit (they used to hard-code 'factory').
--   * inward: no QR generation in US Factory; inventory is Factory-only; a
--     non-tray entry gets its Pending Inward QC record immediately, a tray
--     entry once its Batch Numbers are saved.
--   * new: goods_receipt_pallet_batches, inward_qc_records.source_goods_
--     receipt_entry_id, gr_ensure_qc(), goods_receipt_save_batch_numbers().
--   * fixes a latent bug: migration 0059 (copied into 0080/0081) only
--     accepted 'tray'/'fnp_tray' when a Zoho tray row picks its stage at
--     inward, so choosing LNP Tray was rejected.
--
-- Additive and re-runnable. Run it BEFORE deploying the matching frontend.


-- 0. Bug fix for migration 0081. 0081 made pallet_count optional in
--    goods_receipt_inward / _inward_remaining (only Tray and Soaker Pad are
--    counted in pallets), but two table constraints from 0045/0056 still
--    demanded one, so inwarding glue / polybag / CFB by Quantity + Unit failed
--    with a constraint violation. Relax both: an inwarded row needs a received
--    quantity, and a pallet count only when one was given.
alter table goods_receipt_entries drop constraint if exists goods_receipt_entries_inwarded_complete;
alter table goods_receipt_entries add constraint goods_receipt_entries_inwarded_complete
  check (status <> 'inwarded' or (received_quantity is not null and (pallet_count is null or pallet_count > 0)));
alter table goods_receipt_inward_events alter column pallet_count drop not null;

-- 1. Inward QC <- Goods Receipt link. One QC record per Goods Receipt entry,
--    enforced by a partial unique index (the idempotency backstop for
--    gr_ensure_qc). The old global unique index on shipment_number would
--    reject two entries of one container (two SKUs on the same container)
--    and the same container number appearing again later, so it now only
--    applies to QC records that are NOT Goods Receipt entries.
alter table inward_qc_records
  add column if not exists source_goods_receipt_entry_id uuid references goods_receipt_entries(id);
create unique index if not exists uq_qc_source_goods_receipt_entry
  on inward_qc_records (source_goods_receipt_entry_id) where source_goods_receipt_entry_id is not null;
drop index if exists uq_qc_shipment_number;
create unique index if not exists uq_qc_shipment_number
  on inward_qc_records (shipment_number) where shipment_number != '' and source_goods_receipt_entry_id is null;

-- 2. One Batch Number per received pallet of an RM / LNP Tray entry. Linked
--    to the entry (and through it to PO, SKU and shipment), and to the
--    Inward Vehicle Inspection it was entered against. Unique per entry both
--    by pallet position and by (case-insensitive) batch number. Written only
--    through goods_receipt_save_batch_numbers(); the browser may read.
create table if not exists goods_receipt_pallet_batches (
  id uuid primary key default gen_random_uuid(),
  product text not null default app_request_product(),
  goods_receipt_entry_id uuid not null references goods_receipt_entries(id) on delete cascade,
  inspection_id uuid references inward_vehicle_inspections(id) on delete set null,
  sku_code_id uuid references sku_codes(id),
  shipment_number text,
  pallet_index integer not null check (pallet_index >= 1),
  batch_number text not null check (btrim(batch_number) <> ''),
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  unique (goods_receipt_entry_id, pallet_index)
);
create unique index if not exists uq_gr_pallet_batches_entry_batch
  on goods_receipt_pallet_batches (goods_receipt_entry_id, lower(btrim(batch_number)));
create index if not exists idx_gr_pallet_batches_sku on goods_receipt_pallet_batches (sku_code_id);

alter table goods_receipt_pallet_batches enable row level security;
grant select on goods_receipt_pallet_batches to authenticated;
drop policy if exists goods_receipt_pallet_batches_select on goods_receipt_pallet_batches;
create policy goods_receipt_pallet_batches_select on goods_receipt_pallet_batches for select
  using (app_can('goods_receipt', 'view'));
drop policy if exists goods_receipt_pallet_batches_product_scope on goods_receipt_pallet_batches;
create policy goods_receipt_pallet_batches_product_scope on goods_receipt_pallet_batches as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());


-- gr_detail_json: adds the fields the new flow reads straight after an RPC.
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
        'qr_quantity', e.qr_quantity, 'coa_storage_path', e.coa_storage_path, 'coa_filename', e.coa_filename,
        'batch_count', (select count(*) from goods_receipt_pallet_batches b where b.goods_receipt_entry_id = e.id),
        'qc', (
          select jsonb_build_object('id', q.id, 'status', q.status)
          from inward_qc_records q where q.source_goods_receipt_entry_id = e.id
        ),
        'inward_events', coalesce((
          select jsonb_agg(jsonb_build_object('received_quantity', ev.received_quantity, 'pallet_count', ev.pallet_count,
                                              'unit', ev.unit, 'kind', ev.kind, 'inwarded_at', ev.inwarded_at) order by ev.inwarded_at)
          from goods_receipt_inward_events ev where ev.entry_id = e.id), '[]'::jsonb),
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

-- Creates (once) the Inward QC record for an inwarded Goods Receipt entry.
-- Idempotent: a second call returns the existing record's id. Only the
-- materials that actually have a QC form get one (RM / LNP Tray and Soaker
-- Pad / Polybag / CFB / Glue); anything else returns null.
create or replace function gr_ensure_qc(_entry_id uuid) returns uuid
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _qid uuid; _cat text; _tray boolean;
  _vi uuid; _label text; _qty numeric; _unit text; _ver_label text;
begin
  select * into _e from goods_receipt_entries where id = _entry_id;
  if not found or _e.status <> 'inwarded' then return null; end if;

  select id into _qid from inward_qc_records where source_goods_receipt_entry_id = _entry_id;
  if found then return _qid; end if;

  _cat := case when _e.category = 'fnp_tray' then 'lnp_tray' else _e.category end;
  if _cat is null or _cat not in ('tray', 'lnp_tray', 'pad', 'polybag', 'cfb', 'glue') then
    return null;
  end if;
  _tray := sku_family(_cat) = 'tray';
  select * into _gr from goods_receipts where id = _e.goods_receipt_id;

  select id into _vi from inward_vehicle_inspections
    where source_goods_receipt_entry_id = _entry_id and status = 'approved'
    order by created_at desc limit 1;
  if _vi is not null and exists (select 1 from inward_qc_records where linked_vehicle_inspection_id = _vi) then
    _vi := null;
  end if;

  if _tray then
    _qty := _e.pallet_count; _unit := 'Pallets'; _label := 'No. of Pallets';
  else
    _qty := _e.received_quantity; _unit := _e.unit;
    select qty_label into _label from inward_qc_sampling_plan_tiers where category = _cat order by sort_order limit 1;
    _label := coalesce(_label, 'Quantity');
  end if;
  select version into _ver_label from sku_versions where id = _e.sku_version_id;

  insert into inward_qc_records (
    shipment_number, is_auto_shipment_number, category, status, linked_vehicle_inspection_id,
    vendor_name, vendor_id, quantity, quantity_label, quantity_unit,
    sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
    source_goods_receipt_entry_id, created_by, updated_by
  ) values (
    _e.shipment_number, coalesce(_e.shipment_number, '') like 'AUTO-%', _cat, 'pending', _vi,
    _gr.vendor_name, _gr.vendor_id, _qty, _label, _unit,
    _e.sku_code_id, _e.sku_version_id, _e.sku_code_snapshot, _e.sku_version_snapshot,
    _e.id, app_user_id(), app_user_id()
  ) returning id into _qid;

  if _tray then
    insert into inward_qc_line_item_snapshots (
      inward_qc_id, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot, quantity, sort_order
    ) values (_qid, _e.sku_code_id, _e.sku_version_id, _e.sku_code_snapshot, _ver_label, _e.pallet_count, 0);
  end if;
  return _qid;
end;
$$;
revoke all on function gr_ensure_qc(uuid) from public;
revoke all on function gr_ensure_qc(uuid) from authenticated;

-- Saves the per-pallet Batch Numbers for an inwarded RM / LNP Tray entry and
-- completes its inward by creating the Pending Inward QC record. `_payload`
-- is {"batch_numbers": ["B-001", "B-002", ...]}: array position = pallet
-- number. Exactly one non-blank, unique (case-insensitive) value per pallet
-- received. Re-saving replaces the list (so entries can be corrected) until
-- the entry's RM QR codes have been generated, after which it is locked.
create or replace function goods_receipt_save_batch_numbers(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _vals text[]; _v text; _i int; _seen text[] := '{}'; _key text; _vi uuid;
begin
  if app_request_product() <> 'us_factory' then
    raise exception 'Batch Numbers are only collected in US Factory.';
  end if;
  if not app_can('goods_receipt', 'fill_section') then
    raise exception using errcode = '42501', message = 'You do not have permission to enter Batch Numbers.';
  end if;
  select * into _e from goods_receipt_entries where id = _entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Container entry not found.'; end if;
  if _e.status <> 'inwarded' then
    raise exception using errcode = '23503', message = 'Inward this container before entering its Batch Numbers.';
  end if;
  if sku_family(_e.category) <> 'tray' then
    raise exception 'Batch Numbers are only entered for RM / LNP Tray containers.';
  end if;
  if coalesce(_e.pallet_count, 0) < 1 then
    raise exception 'This container has no pallet count to enter Batch Numbers for.';
  end if;
  if exists (select 1 from qr_generation_records where source_goods_receipt_entry_id = _entry_id and status = 'generated')
     or exists (select 1 from qr_generation_records q join inward_qc_records c on c.id = q.source_inward_qc_id
                where c.source_goods_receipt_entry_id = _entry_id and q.status = 'generated') then
    raise exception using errcode = '23503', message = 'QR codes were already generated for this container, so its Batch Numbers are locked.';
  end if;

  select coalesce(array_agg(x), '{}') into _vals from jsonb_array_elements_text(coalesce(_payload->'batch_numbers', '[]'::jsonb)) as x;
  if coalesce(array_length(_vals, 1), 0) <> _e.pallet_count then
    raise exception 'Enter one Batch Number for each of the % pallets received (got %).', _e.pallet_count, coalesce(array_length(_vals, 1), 0);
  end if;
  for _i in 1.._e.pallet_count loop
    _v := btrim(coalesce(_vals[_i], ''));
    if _v = '' then raise exception 'Pallet % has no Batch Number.', _i; end if;
    _key := lower(_v);
    if _key = any(_seen) then raise exception 'Batch Number "%" is entered more than once.', _v; end if;
    _seen := _seen || _key;
    _vals[_i] := _v;
  end loop;

  select id into _vi from inward_vehicle_inspections
    where source_goods_receipt_entry_id = _entry_id and status = 'approved'
    order by created_at desc limit 1;

  delete from goods_receipt_pallet_batches where goods_receipt_entry_id = _entry_id;
  for _i in 1.._e.pallet_count loop
    insert into goods_receipt_pallet_batches (goods_receipt_entry_id, inspection_id, sku_code_id, shipment_number, pallet_index, batch_number, created_by)
      values (_entry_id, _vi, _e.sku_code_id, _e.shipment_number, _i, _vals[_i], app_user_id());
  end loop;

  perform gr_ensure_qc(_entry_id);
  update goods_receipts set updated_at = now() where id = _e.goods_receipt_id;
  return gr_detail_json(_e.goods_receipt_id);
end;
$$;
revoke all on function goods_receipt_save_batch_numbers(uuid, jsonb) from public;
grant execute on function goods_receipt_save_batch_numbers(uuid, jsonb) to authenticated;


-- Zoho sync, now unit-aware.
drop function if exists zoho_upsert_purchase_order(jsonb, text);
create or replace function zoho_upsert_purchase_order(_po jsonb, _delivery_match text default 'gainesville factory', _unit_product text default 'factory')
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
  _shipment_raw text; _containers text[]; _splits numeric[]; _n int; _c int; _k int;
  _per_cont numeric; _left numeric; _share numeric; _lkey text; _entry_po_qty numeric; _entry_qty numeric;
begin
  if _unit_product not in ('factory', 'us_factory') then
    raise exception 'Unknown unit %.', _unit_product;
  end if;
  if _zid is null or _po_number = '' then
    raise exception 'Zoho purchase order is missing purchaseorder_id / purchaseorder_number.';
  end if;

  select * into _gr from goods_receipts
    where product = _unit_product and (zoho_purchaseorder_id = _zid or upper(btrim(po_number)) = _po_number)
    order by (zoho_purchaseorder_id = _zid) desc nulls last
    limit 1
    for update;

  if position(lower(_delivery_match) in _delivery) = 0 then
    return jsonb_build_object('action', 'ignored', 'reason', 'not delivered to ' || _delivery_match);
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

  select * into _vendor from vendors where product = _unit_product and zoho_vendor_id = _po->>'vendor_id' limit 1;
  if _vendor.id is null then
    select * into _vendor from vendors
      where product = _unit_product and is_active
        and (lower(name) = lower(_po->>'vendor_name') or position(lower(name) in lower(coalesce(_po->>'vendor_name', ''))) > 0)
      order by length(name) desc limit 1;
    if _vendor.id is not null and _po->>'vendor_id' is not null then
      update vendors set zoho_vendor_id = _po->>'vendor_id'
        where product = _unit_product and lower(name) = lower(_vendor.name) and zoho_vendor_id is null;
    end if;
  end if;
  -- (Vendor-not-found note removed 2026-09-30 -- was purely informational
  -- and never blocked anything; the fallback lookup above is unchanged.)

  if _gr.id is null then
    insert into goods_receipts (product, po_number, vendor_id, vendor_name, status, zoho_purchaseorder_id, zoho_status, zoho_synced_at)
      values (_unit_product, _po_number, _vendor.id, coalesce(_vendor.name, _po->>'vendor_name', 'Unknown vendor'), 'pending', _zid, _status, now())
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
      where s.product = _unit_product and s.is_active and s.sku_code is not null and s.sku_code <> ''
        and (upper(s.sku_code) = _item_code
             or upper(s.sku_code) = split_part(_item_code, '-', 1)
             or upper(s.sku_code) like _item_code || '-%')
      order by (upper(s.sku_code) = _item_code) desc, length(s.sku_code) asc
      limit 1;
    if _sku.id is null and _product is not null then
      select * into _sku from sku_codes s where s.product = _unit_product and s.is_active and upper(s.code) = upper(_product) limit 1;
    end if;
    if _sku.id is null then
      _notes := _notes || format('Skipped line %s "%s" (not a SKU) -- Zoho sku="%s", name="%s".',
        _i, coalesce(nullif(_li->>'name', ''), _item_code), coalesce(_li->>'sku', ''), coalesce(_li->>'name', ''));
      continue;
    end if;

    _sku_label := coalesce(nullif(btrim(_sku.sku_code), ''), _sku.code);

    _shipment_raw := upper(coalesce(zoho_desc_value(_desc, 'Container'), zoho_desc_value(_desc, 'Container No'), ''));

    _qty := coalesce(nullif(_li->>'quantity', '')::numeric, 0);
    if sku_family(_sku.category) = 'tray' then
      _per_box := nullif(regexp_replace(coalesce(zoho_desc_value(_desc, 'Trays/Combo Box'), ''), '[^0-9.]', '', 'g'), '')::numeric;
      -- US Factory POs carry the pallet size as "Pcs/Combo" instead.
      if (_per_box is null or _per_box <= 0) and _unit_product = 'us_factory' then
        _per_box := nullif(regexp_replace(coalesce(zoho_desc_value(_desc, 'Pcs/Combo'), ''), '[^0-9.]', '', 'g'), '')::numeric;
      end if;
      if _per_box is not null and _per_box > 0 then
        _po_qty := ceil(_qty / _per_box);
      else
        _po_qty := _qty;
        _notes := _notes || format('Line %s (%s) has no "Trays/Combo Box" or "Pcs/Combo" -- PO Quantity left as %s trays; check it.', _i, _sku.code, _qty);
      end if;
      _unit := 'Pallets';
      _cat := null;
    else
      _po_qty := _qty;
      _unit := coalesce(_sku.default_unit, zoho_unit(_li->>'unit'));
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

    -- US Factory: one tray line can cover several containers
    -- ("Container: H5 & H6"). Each container becomes its own entry so it
    -- can be inwarded, inspected and QC'd independently. Pallets are split
    -- by "Combo/40HQ" (pallets per container) when the PO gives it, else
    -- evenly; the last container takes the remainder. Factory is untouched.
    _containers := array[_shipment_raw];
    _splits := array[_po_qty];
    if _unit_product = 'us_factory' and sku_family(_sku.category) = 'tray' and _shipment_raw <> '' then
      _containers := array(
        select upper(btrim(x)) from regexp_split_to_table(_shipment_raw, '\s*(?:&|,|;|\+|\sAND\s)\s*') as x where btrim(x) <> ''
      );
      if coalesce(array_length(_containers, 1), 0) < 2 then
        _containers := array[_shipment_raw];
      else
        _n := array_length(_containers, 1);
        -- Pallets in one container: "Pcs/40HQ" / pallet size when the PO gives
        -- both (the PO's own "Combo/40HQ" is a nominal capacity and can differ
        -- from what was actually loaded), else "Combo/40HQ", else an even split.
        _per_cont := nullif(regexp_replace(coalesce(zoho_desc_value(_desc, 'Pcs/40HQ'), ''), '[^0-9.]', '', 'g'), '')::numeric;
        if _per_cont is not null and _per_box is not null and _per_box > 0 then
          _per_cont := round(_per_cont / _per_box);
        else
          _per_cont := nullif(regexp_replace(coalesce(zoho_desc_value(_desc, 'Combo/40HQ'), ''), '[^0-9.]', '', 'g'), '')::numeric;
        end if;
        _splits := '{}';
        _left := _po_qty;
        for _k in 1.._n loop
          if _k = _n then
            _share := _left;
          else
            _share := least(_left, coalesce(nullif(_per_cont, 0), ceil(_po_qty / _n)));
          end if;
          _splits := _splits || _share;
          _left := _left - _share;
        end loop;
      end if;
    end if;

    for _c in 1..coalesce(array_length(_containers, 1), 1) loop
      _shipment := _containers[_c];
      _entry_po_qty := _splits[_c];
      if _entry_po_qty is null or _entry_po_qty <= 0 then continue; end if;
      _entry_qty := case when array_length(_containers, 1) > 1 and _po_qty > 0 then round(_qty * _entry_po_qty / _po_qty) else _qty end;
      _lkey := coalesce(_li->>'line_item_id', 'line-' || _i)
               || case when array_length(_containers, 1) > 1 then '#' || _c else '' end;

      _seen_lines := _seen_lines || _lkey;

      _row := null;
      select * into _row from goods_receipt_entries
        where goods_receipt_id = _gr.id
          and (zoho_line_item_id = _lkey
               or (zoho_line_item_id is null and upper(btrim(shipment_number)) = _shipment and sku_code_id = _sku.id))
        limit 1;

      _auto_generated := false;
      if _shipment = '' then
        if sku_family(_sku.category) = 'tray' then
          _notes := _notes || format('Line %s (%s) has no "Container:" -- fill in its Shipment Number.', _i, _sku.code);
        elsif _row.id is not null and coalesce(btrim(_row.shipment_number), '') <> '' then
          _shipment := _row.shipment_number;
        else
          _shipment := 'AUTO-' || lpad(factory_next_seq(case when _unit_product = 'factory' then 'zoho_auto_shipment' else 'zoho_auto_shipment_us' end)::text, 4, '0');
          _auto_generated := true;
        end if;
      end if;

      if _row.id is not null and _row.status = 'inwarded' then
        update goods_receipt_entries set zoho_line_item_id = _lkey where id = _row.id;
        continue;
      elsif _row.id is not null then
        update goods_receipt_entries set
          zoho_line_item_id = _lkey,
          shipment_number = _shipment,
          sku_code_id = _sku.id, sku_code_snapshot = _sku_label,
          sku_version_id = coalesce(sku_version_id, _ver_id),
          sku_version_snapshot = coalesce(sku_version_snapshot, _ver_label),
          category = case when sku_family(_sku.category) = 'tray' and category in ('tray', 'fnp_tray', 'lnp_tray') then category else _cat end,
          po_quantity = _entry_po_qty, unit = _unit, zoho_quantity = _entry_qty, zoho_unit = _li->>'unit', sort_order = _i
        where id = _row.id;
      else
        begin
          insert into goods_receipt_entries (
            goods_receipt_id, shipment_number, category, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
            po_quantity, unit, sort_order, status, zoho_line_item_id, zoho_quantity, zoho_unit
          ) values (
            _gr.id, _shipment, _cat, _sku.id, _ver_id, _sku_label, _ver_label,
            _entry_po_qty, _unit, _i, 'pending', _lkey, _entry_qty, _li->>'unit'
          );
        exception when unique_violation then
          update goods_receipt_entries set po_quantity = po_quantity + _entry_po_qty, zoho_quantity = coalesce(zoho_quantity, 0) + _entry_qty
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

revoke all on function zoho_upsert_purchase_order(jsonb, text, text) from public;
revoke all on function zoho_upsert_purchase_order(jsonb, text, text) from authenticated;

-- goods_receipt_save (latest: 0080), unit-aware.
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
  select * into _vendor from vendors where id = _vendor_id and product = app_request_product();
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
    select * into _sku from sku_codes where id = nullif(_e->>'sku_code_id', '')::uuid and product = app_request_product();
    if not found then raise exception '%: select a valid SKU.', _label; end if;
    -- Category per container: a PO can mix materials. Only a Tray SKU
    -- needs its stage chosen (Base Tray / LNP Tray); every other SKU's
    -- material IS its category.
    _ecat := nullif(btrim(coalesce(_e->>'category', '')), '');
    if sku_family(_sku.category) <> 'tray' then _ecat := _sku.category; end if;
    -- A tray row's stage may be left blank (e.g. synced from Zoho): it is
    -- chosen when the container is inwarded (goods_receipt_inward).
    if _ecat is not null and _ecat not in ('tray', 'fnp_tray', 'lnp_tray', 'film', 'pad', 'polybag', 'cfb', 'glue') then
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
    if _unit not in ('Pallets', 'Kgs', 'Units', 'Bags', 'Rolls', 'Pairs', 'Sets', 'Pcs') then
      raise exception '%: unknown unit ''%''.', _label, _unit;
    end if;
    _key := _name || '|' || _sku.id || '|' || coalesce(_ver_id::text, '');
    if _key = any(_keys) then raise exception '% with SKU % is listed more than once.', _label, _sku.code; end if;
    _keys := _keys || _key;
  end loop;

  if _id is null then
    insert into goods_receipts (product, po_number, vendor_id, vendor_name, status, created_by)
      values (app_request_product(), _po, _vendor.id, _vendor.name, 'draft', app_user_id())
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
revoke all on function goods_receipt_save(uuid, jsonb) from public;


-- goods_receipt_inward (latest: 0081).
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

-- goods_receipt_inward_remaining (latest: 0081).
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
  if app_request_product() = 'us_factory' then
    raise exception using errcode = '23503', message = 'A later delivery on an already-inwarded container isn''t supported in US Factory yet.';
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
  perform inventory_apply_receipt(_entry_id, _qty);  -- (Factory only: US Factory is blocked above)
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

-- goods_receipt_generate_pallets (latest: 0080): Factory only.
create or replace function goods_receipt_generate_pallets(_entry_id uuid) returns uuid
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _b qr_generation_records%rowtype;
  _country text; _category text; _base text; _yymm text; _did text; _pid uuid; _actor uuid := app_user_id();
  _have int := 0; _qty int;
begin
  if app_request_product() = 'us_factory' then
    raise exception using errcode = '23503', message = 'In US Factory, QR codes are generated from RM QR Generation after Inward QC is approved.';
  end if;
  if not app_can('goods_receipt', 'fill_section') then
    raise exception using errcode = '42501', message = 'You do not have permission to generate pallet QRs.';
  end if;
  select * into _e from goods_receipt_entries where id = _entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Container entry not found.'; end if;
  if _e.status <> 'inwarded' then
    raise exception using errcode = '23503', message = 'Inward this container before generating its pallet QRs.';
  end if;
  if _e.category in ('pad', 'polybag', 'cfb') and _e.coa_storage_path is null then
    raise exception using errcode = '23503', message = 'Upload the COA (PDF, Word doc, or image) for this container before generating its QR codes.';
  end if;
  select * into _b from qr_generation_records where source_goods_receipt_entry_id = _e.id;
  if found and _b.status = 'generated' then
    return _b.id;
  end if;

  select * into _gr from goods_receipts where id = _e.goods_receipt_id;
  _country := upper(coalesce(nullif(btrim((select country from vendors where id = _gr.vendor_id)), ''), 'US'));
  _category := coalesce(_e.category, _gr.category, (select category from sku_codes where id = _e.sku_code_id));
  _qty := coalesce(_e.qr_quantity, _e.pallet_count);

  if _b.id is null then
    insert into qr_generation_records (
      product, batch_display_id, qr_type, category, source_goods_receipt_entry_id, shipment_number,
      sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
      country_code, quantity, status, created_by
    ) values (
      'factory', 'RMQR-' || lpad(factory_next_seq('qr_batch:rm')::text, 4, '0'),
      'rm', _category, _e.id, _e.shipment_number,
      _e.sku_code_id, _e.sku_version_id, _e.sku_code_snapshot, _e.sku_version_snapshot,
      _country, _qty, 'pending', _actor
    ) returning * into _b;
  end if;

  _base := _country || '-' || factory_pallet_suffix(_category);
  _yymm := to_char(now() at time zone 'utc', 'YYMM');
  -- Only the pallets this batch doesn't have yet: after an "Inward
  -- remaining", the batch grows and just the new pallets are generated,
  -- numbered on from the existing ones. Existing pallets are never touched.
  select count(*) into _have from pallets where source_qr_generation_id = _b.id;
  for _i in (_have + 1).._b.quantity loop
    _did := _base || '-' || _yymm || '-' || lpad(factory_next_seq('pallet:' || _base)::text, 4, '0');
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
revoke all on function goods_receipt_generate_pallets(uuid) from public;
grant execute on function goods_receipt_generate_pallets(uuid) to authenticated;
