-- Goods Receipt: new Inward/QR-generation rules (2026-09-30).
--
--   1. Inward Vehicle Inspection is only required for a container with a
--      real Container/Shipment Number from Zoho (or entered by hand) --
--      never for one whose shipment number was auto-generated because Zoho
--      sent no container (an AUTO-#### row). That part is a frontend-only
--      change (GoodsReceiptDetailPanel.tsx / GrQuickInwardForm.tsx): an
--      auto-shipment entry never creates an inward_vehicle_inspections
--      record at all, so there's nothing to change here for it.
--   2. Polybag / Soaker Pad / CFB entries require a COA upload (PDF, Word
--      doc, or image -- see goods_receipt_coa.py) before their QR codes can
--      be generated, regardless of shipment-number type.
--   3. An auto-shipment entry can't know its real "boxes" configuration
--      from Quantity (Pallets) alone, so it separately asks "how many QR
--      codes to generate" -- qr_quantity -- which QR generation uses
--      INSTEAD of pallet_count when it's set. Quantity (Pallets) is still
--      collected and still drives received_quantity/inventory as before;
--      only the number of QR codes/pallets created changes.
--
-- This migration is the DB half of that: new columns, the (1) unit
-- whitelist gap that migration 0076/0077/0078 exposed (Rolls/Pairs/Sets/Pcs
-- were never added to goods_receipt_save's or goods_receipt_inward's unit
-- checks, so a SKU using any of those units would fail to save/inward with
-- "unknown unit"), qr_quantity plumbing through the inward RPCs, and the
-- COA-required guard in goods_receipt_generate_pallets.

alter table goods_receipt_entries add column if not exists qr_quantity integer null;
alter table goods_receipt_entries add column if not exists coa_storage_path text null;
alter table goods_receipt_entries add column if not exists coa_filename text null;

-- goods_receipt_save (latest: 0057) -- unit whitelist only; nothing else changes.
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

-- goods_receipt_inward (latest: 0059) -- unit whitelist, plus optional
-- qr_quantity (an auto-shipment entry's "how many QR codes to generate",
-- collected by GrQuickInwardForm.tsx -- see its own comment for why this
-- is separate from pallet_count).
create or replace function goods_receipt_inward(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _gid uuid; _gr goods_receipts%rowtype; _row goods_receipt_entries%rowtype;
  _qty numeric; _pallets numeric; _unit text; _cat text; _sku sku_codes%rowtype;
  _qr_qty numeric;
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

-- goods_receipt_inward_remaining (latest: 0059) -- an optional qr_quantity
-- delta, added to the entry's running qr_quantity and to its QR batch's
-- quantity the same way pallet_count already is. In practice a non-tray
-- material (the only kind that can carry qr_quantity) always receives its
-- full PO quantity on the FIRST delivery, so this branch is a safety net
-- rather than an expected path.
create or replace function goods_receipt_inward_remaining(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _row goods_receipt_entries%rowtype; _gr goods_receipts%rowtype;
  _pallets numeric; _qty numeric; _tray boolean; _left numeric; _qr_qty numeric;
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

  _tray := sku_family(coalesce(_row.category, (select category from sku_codes where id = _row.sku_code_id))) = 'tray';
  _left := _row.po_quantity - coalesce(_row.received_quantity, 0);
  if _left <= 0 then
    raise exception using errcode = '23503', message = format('%s has already received its full PO quantity.', _row.shipment_number);
  end if;
  _pallets := nullif(_payload->>'pallet_count', '')::numeric;
  if _pallets is null or _pallets < 1 or _pallets <> trunc(_pallets) then
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
    pallet_count = coalesce(pallet_count, 0) + _pallets::int,
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
  -- (unchanged default).
  update qr_generation_records set quantity = quantity + coalesce(_qr_qty::int, _pallets::int), status = 'pending'
    where source_goods_receipt_entry_id = _entry_id;
  update goods_receipts set updated_at = now() where id = _row.goods_receipt_id;
  return gr_detail_json(_row.goods_receipt_id);
end;
$$;
revoke all on function goods_receipt_inward_remaining(uuid, jsonb) from public;
grant execute on function goods_receipt_inward_remaining(uuid, jsonb) to authenticated;

-- goods_receipt_generate_pallets (latest: 0056) -- uses qr_quantity instead
-- of pallet_count when it's set (auto-shipment entries), and refuses to
-- generate at all for a Polybag/Soaker Pad/CFB entry with no COA uploaded
-- yet (defense in depth -- the frontend already blocks this in the Inward
-- flow, but this is the one choke point every QR-generation path goes
-- through, Supabase-direct or not).
create or replace function goods_receipt_generate_pallets(_entry_id uuid) returns uuid
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _b qr_generation_records%rowtype;
  _country text; _category text; _base text; _yymm text; _did text; _pid uuid; _actor uuid := app_user_id();
  _have int := 0; _qty int;
begin
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
