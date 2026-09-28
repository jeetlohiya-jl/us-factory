-- 2026-09-28 -- Inventory module (SKU-centric raw-material stock).
--
-- SKU-centric, not vendor-centric: one row per SKU (inventory_items) with
-- the quantity clubbed across every supplier -- exactly what the
-- dashboard shows. The underlying per-source rows (inventory_sources)
-- keep supplier/country/PO traceability for QR generation and audits,
-- one row per Goods Receipt container (or one per manual entry), so
-- clubbing quantities on the dashboard never loses that detail.
--
-- Kept in sync automatically: inventory_apply_receipt() below is called
-- from goods_receipt_inward() and goods_receipt_inward_remaining() (both
-- redefined here, same bodies as migration 0056 plus one new line each)
-- every time a container is inwarded, so Inventory updates the moment
-- Goods Receipt does -- no separate step, no duplicate SKU master data,
-- no new inventory record just because the vendor differs. Manual
-- additions (a SKU with no PO behind it yet, or a correction) are
-- written directly by the backend (see app/domain/inventory_service.py)
-- as a plain is_manual=true source row, same table, same aggregation.
--
-- Additive / idempotent, safe to re-run.

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  product text not null,
  sku_code_id uuid not null references sku_codes(id) on delete cascade,
  uom text not null default 'Kgs',
  -- The tray SKU this material is compatible with/packed into (last
  -- column of the reference inventory sheet) -- nullable, only
  -- meaningful for materials that pair with one specific tray.
  compatible_tray_sku_code_id uuid references sku_codes(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product, sku_code_id)
);
create index if not exists idx_inventory_items_sku on inventory_items (sku_code_id);

create table if not exists inventory_sources (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references inventory_items(id) on delete cascade,
  -- One row per Goods Receipt container; unique so a later "inward
  -- remaining" delivery grows this same row instead of inserting a
  -- second source for the same container.
  source_goods_receipt_entry_id uuid references goods_receipt_entries(id) on delete set null,
  vendor_id uuid references vendors(id) on delete set null,
  vendor_name text,
  -- Snapshot, same "vendor.country, default US" rule QR generation uses
  -- (qr_generation_service._resolve_qc_country / goods_receipt_generate_pallets)
  -- -- retained here at the source level even though the dashboard clubs
  -- quantity by SKU, so country stays available for QR generation.
  country_code text,
  quantity numeric not null default 0,
  unit text not null default 'Kgs',
  is_manual boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_goods_receipt_entry_id)
);
create index if not exists idx_inventory_sources_item on inventory_sources (inventory_item_id);

-- FastAPI-only tables (see app/domain/inventory_service.py) -- RLS enabled
-- with no policies, matching every other backend-owned table (migration
-- 0009): the FastAPI service connection owns these and bypasses RLS
-- regardless; this just closes off any direct PostgREST/anon access.
alter table inventory_items enable row level security;
alter table inventory_sources enable row level security;

-- Applies a Goods Receipt inward (or later "remaining" top-up) onto the
-- SKU's clubbed inventory: upserts the one inventory_items row for this
-- SKU, then grows (or creates) the one inventory_sources row for this
-- container. _delta is the quantity received THIS call -- the full
-- amount on first inward, just the increment on a later "remaining" call
-- -- never the running total, so this is safe to call at either point.
create or replace function inventory_apply_receipt(_entry_id uuid, _delta numeric) returns void
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _item_id uuid; _country text;
begin
  if _delta is null or _delta = 0 then return; end if;
  select * into _e from goods_receipt_entries where id = _entry_id;
  if not found then return; end if;
  select * into _gr from goods_receipts where id = _e.goods_receipt_id;

  insert into inventory_items (product, sku_code_id, uom)
    values ('factory', _e.sku_code_id, _e.unit)
    on conflict (product, sku_code_id) do nothing;
  select id into _item_id from inventory_items where product = 'factory' and sku_code_id = _e.sku_code_id;

  _country := upper(coalesce(nullif(btrim((select country from vendors where id = _gr.vendor_id)), ''), 'US'));

  insert into inventory_sources (
    inventory_item_id, source_goods_receipt_entry_id, vendor_id, vendor_name, country_code, quantity, unit
  ) values (
    _item_id, _entry_id, _gr.vendor_id, _gr.vendor_name, _country, _delta, _e.unit
  )
  on conflict (source_goods_receipt_entry_id) do update
    set quantity = inventory_sources.quantity + excluded.quantity,
        vendor_id = excluded.vendor_id, vendor_name = excluded.vendor_name,
        country_code = excluded.country_code, updated_at = now();
end;
$$;
revoke all on function inventory_apply_receipt(uuid, numeric) from public;

-- Backfill: every already-inwarded container that predates this
-- migration gets its one inventory_sources row now, for its full
-- received_quantity (there's no per-event ledger to replay here --
-- goods_receipt_entries.received_quantity is already the running total,
-- exactly what a fresh call with the full amount should produce).
do $$
declare r record;
begin
  for r in
    select e.id, e.received_quantity
    from goods_receipt_entries e
    where e.status = 'inwarded' and e.received_quantity is not null and e.received_quantity > 0
      and not exists (select 1 from inventory_sources s where s.source_goods_receipt_entry_id = e.id)
  loop
    perform inventory_apply_receipt(r.id, r.received_quantity);
  end loop;
end $$;

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
  -- Inventory update (migration 0059): just the increment received on
  -- this later delivery grows the container's existing inventory_sources
  -- row (see inventory_apply_receipt's on-conflict-do-update).
  perform inventory_apply_receipt(_entry_id, _qty);
  -- The container's one RM QR batch grows; "Generate QRs" adds the new pallets.
  update qr_generation_records set quantity = quantity + _pallets::int, status = 'pending'
    where source_goods_receipt_entry_id = _entry_id;
  update goods_receipts set updated_at = now() where id = _row.goods_receipt_id;
  return gr_detail_json(_row.goods_receipt_id);
end;
$$;
revoke all on function goods_receipt_inward_remaining(uuid, jsonb) from public;
grant execute on function goods_receipt_inward_remaining(uuid, jsonb) to authenticated;
