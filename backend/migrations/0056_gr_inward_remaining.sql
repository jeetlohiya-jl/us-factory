-- Goods Receipt: inward the rest of a short container later.
--
-- A container can arrive short (e.g. HA2: 40 of 44 pallets); the rest MAY
-- follow later -- or never. "Inward remaining" records each later delivery:
-- the container keeps ONE row and ONE RM QR batch (so every downstream link
-- stays as it is); its totals grow, the batch's quantity grows, and "Generate
-- QRs" then creates only the new pallets, numbered on from the existing ones.
-- Every delivery is kept in goods_receipt_inward_events (who / when / how
-- many). Additive and re-runnable.

create table if not exists goods_receipt_inward_events (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references goods_receipt_entries(id) on delete cascade,
  kind text not null check (kind in ('initial', 'remaining')),
  received_quantity numeric not null check (received_quantity > 0),
  unit text not null,
  pallet_count integer not null check (pallet_count >= 1),
  inwarded_at timestamptz not null default now(),
  inwarded_by uuid references app_users(id)
);
create index if not exists idx_gr_inward_events_entry on goods_receipt_inward_events (entry_id, inwarded_at);
alter table goods_receipt_inward_events enable row level security;
grant select on goods_receipt_inward_events to authenticated;
drop policy if exists goods_receipt_inward_events_select on goods_receipt_inward_events;
create policy goods_receipt_inward_events_select on goods_receipt_inward_events for select
  using (app_can('goods_receipt', 'view')
         and exists (select 1 from goods_receipt_entries e where e.id = goods_receipt_inward_events.entry_id));

-- History for containers inwarded before this: one "initial" delivery each.
insert into goods_receipt_inward_events (entry_id, kind, received_quantity, unit, pallet_count, inwarded_at, inwarded_by)
select e.id, 'initial', e.received_quantity, e.unit, e.pallet_count, coalesce(e.inwarded_at, now()), e.inwarded_by
from goods_receipt_entries e
where e.status = 'inwarded' and e.received_quantity > 0 and e.pallet_count >= 1
  and not exists (select 1 from goods_receipt_inward_events ev where ev.entry_id = e.id);

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
revoke all on function gr_detail_json(uuid) from public;

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
  insert into goods_receipt_inward_events (entry_id, kind, received_quantity, unit, pallet_count, inwarded_by)
    values (_entry_id, 'initial', _qty, _unit, _pallets::int, app_user_id());
  update goods_receipts set updated_at = now() where id = _gid;
  perform gr_recompute_status(_gid, false);
  return gr_detail_json(_gid);
end;
$$;
revoke all on function goods_receipt_inward(uuid, jsonb) from public;
grant execute on function goods_receipt_inward(uuid, jsonb) to authenticated;

-- Inward (more of) a container that arrived short. Optional -- never needed
-- if the rest doesn't come. Can't take the container past its PO quantity.
-- _payload: trays {pallet_count}; other materials {received_quantity, pallet_count}
create or replace function goods_receipt_inward_remaining(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _row goods_receipt_entries%rowtype; _gr goods_receipts%rowtype;
  _pallets numeric; _qty numeric; _tray boolean; _left numeric;
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

  update goods_receipt_entries set
    received_quantity = coalesce(received_quantity, 0) + _qty,
    pallet_count = coalesce(pallet_count, 0) + _pallets::int
  where id = _entry_id;
  insert into goods_receipt_inward_events (entry_id, kind, received_quantity, unit, pallet_count, inwarded_by)
    values (_entry_id, 'remaining', _qty, _row.unit, _pallets::int, app_user_id());
  -- The container's one RM QR batch grows; "Generate QRs" adds the new pallets.
  update qr_generation_records set quantity = quantity + _pallets::int, status = 'pending'
    where source_goods_receipt_entry_id = _entry_id;
  update goods_receipts set updated_at = now() where id = _row.goods_receipt_id;
  return gr_detail_json(_row.goods_receipt_id);
end;
$$;
revoke all on function goods_receipt_inward_remaining(uuid, jsonb) from public;
grant execute on function goods_receipt_inward_remaining(uuid, jsonb) to authenticated;

create or replace function goods_receipt_generate_pallets(_entry_id uuid) returns uuid
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _b qr_generation_records%rowtype;
  _country text; _category text; _base text; _yymm text; _did text; _pid uuid; _actor uuid := app_user_id();
  _have int := 0;
begin
  if not app_can('goods_receipt', 'fill_section') then
    raise exception using errcode = '42501', message = 'You do not have permission to generate pallet QRs.';
  end if;
  select * into _e from goods_receipt_entries where id = _entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Container entry not found.'; end if;
  if _e.status <> 'inwarded' then
    raise exception using errcode = '23503', message = 'Inward this container before generating its pallet QRs.';
  end if;
  select * into _b from qr_generation_records where source_goods_receipt_entry_id = _e.id;
  if found and _b.status = 'generated' then
    return _b.id;
  end if;

  select * into _gr from goods_receipts where id = _e.goods_receipt_id;
  _country := upper(coalesce(nullif(btrim((select country from vendors where id = _gr.vendor_id)), ''), 'US'));
  _category := coalesce(_e.category, _gr.category, (select category from sku_codes where id = _e.sku_code_id));

  if _b.id is null then
    insert into qr_generation_records (
      product, batch_display_id, qr_type, category, source_goods_receipt_entry_id, shipment_number,
      sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
      country_code, quantity, status, created_by
    ) values (
      'factory', 'RMQR-' || lpad(factory_next_seq('qr_batch:rm')::text, 4, '0'),
      'rm', _category, _e.id, _e.shipment_number,
      _e.sku_code_id, _e.sku_version_id, _e.sku_code_snapshot, _e.sku_version_snapshot,
      _country, _e.pallet_count, 'pending', _actor
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
