-- Factory OS Module 1 -- Goods Receipt (PO -> per-container receiving -> RM QR).
--
-- Reuses the existing tables for everything downstream of "this container
-- arrived": vendors / sku_codes / sku_versions (master data),
-- qr_generation_records + pallets + pallet_lifecycle_events (RM QR
-- Generation, same numbering + country-code logic), storage_records +
-- locations (RM Storage). The only genuinely new concepts are the PO-level
-- receipt header and its per-container/per-SKU receiving entries; each
-- existing table only gets one nullable FK back to the entry, mirroring the
-- existing source_inward_qc_id columns exactly.
--
-- Additive and idempotent (if not exists / on conflict), safe to re-run.

-- 1. Goods Receipt header -- one per PO Number.
create table if not exists goods_receipts (
  id uuid primary key default gen_random_uuid(),
  po_number text not null,
  vendor_id uuid references vendors(id) on delete set null,
  -- Display snapshot, same convention as inward_qc_records.vendor_name:
  -- a later vendor rename must not rewrite a historical receipt.
  vendor_name text not null,
  -- 'draft'    -- explicitly saved as draft; entries cannot be inwarded yet
  -- 'pending'  -- saved; no entry inwarded yet
  -- 'partial'  -- some entries inwarded
  -- 'received' -- every entry inwarded
  -- Maintained by app/api/goods_receipt.py on every write so the dashboard
  -- can filter server-side without aggregating entries.
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'partial', 'received')),
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One Goods Receipt per PO. Case/space-insensitive so "cipo-00570 " can't
-- sneak in as a second receipt for CIPO-00570.
create unique index if not exists uq_goods_receipts_po_number
  on goods_receipts (upper(btrim(po_number)));
create index if not exists idx_goods_receipts_created_at on goods_receipts (created_at desc);
create index if not exists idx_goods_receipts_status on goods_receipts (status);
create index if not exists idx_goods_receipts_vendor_id on goods_receipts (vendor_id);

-- 2. Receiving entries -- one per container x SKU on the PO. Each is
-- independently receivable: its own status, its own received quantity,
-- its own pallet count, and (once inwarded) its own RM QR batch.
create table if not exists goods_receipt_entries (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null references goods_receipts(id) on delete cascade,
  container_name text not null,          -- PO's own label, e.g. HA1 / V6
  container_number text,                 -- physical container no., often only known on arrival
  sku_code_id uuid not null references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  po_quantity numeric not null check (po_quantity > 0),
  -- Ordered and received are deliberately separate columns: a short
  -- delivery (received < ordered) is recorded as-is, never "corrected".
  received_quantity numeric check (received_quantity is null or received_quantity >= 0),
  unit text not null default 'Units',
  pallet_count integer check (pallet_count is null or pallet_count >= 0),
  status text not null default 'pending' check (status in ('pending', 'inwarded')),
  inwarded_at timestamptz,
  inwarded_by uuid references app_users(id),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  -- An inwarded entry must carry what was actually received.
  constraint goods_receipt_entries_inwarded_complete check (
    status <> 'inwarded' or (received_quantity is not null and pallet_count is not null and pallet_count > 0)
  )
);

-- No duplicate receiving entry: the same container + SKU + version can
-- appear only once on a receipt. coalesce() so a null version still
-- participates in the uniqueness check.
create unique index if not exists uq_goods_receipt_entries_container_sku
  on goods_receipt_entries (
    goods_receipt_id, upper(btrim(container_name)), sku_code_id,
    coalesce(sku_version_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index if not exists idx_gr_entries_goods_receipt_id on goods_receipt_entries (goods_receipt_id, sort_order);
create index if not exists idx_gr_entries_sku_code_id on goods_receipt_entries (sku_code_id);
create index if not exists idx_gr_entries_sku_version_id on goods_receipt_entries (sku_version_id);

-- 3. Link the existing RM QR / pallet / storage tables back to the entry.
alter table qr_generation_records
  add column if not exists source_goods_receipt_entry_id uuid references goods_receipt_entries(id);
-- Exactly one RM QR batch per inwarded entry -- the hard backstop behind
-- qr_generation_service.get_or_create_rm_qr_for_goods_receipt_entry's
-- find-first, same shape as the existing source_inward_qc_id index.
create unique index if not exists uq_qr_source_goods_receipt_entry
  on qr_generation_records (source_goods_receipt_entry_id)
  where source_goods_receipt_entry_id is not null;

alter table pallets
  add column if not exists source_goods_receipt_entry_id uuid references goods_receipt_entries(id);
create index if not exists idx_pallets_source_goods_receipt_entry
  on pallets (source_goods_receipt_entry_id)
  where source_goods_receipt_entry_id is not null;

alter table storage_records
  add column if not exists source_goods_receipt_entry_id uuid references goods_receipt_entries(id);
create index if not exists idx_storage_records_source_goods_receipt_entry
  on storage_records (source_goods_receipt_entry_id)
  where source_goods_receipt_entry_id is not null;

-- 4. RLS: SELECT-only for the browser. Writes go through the SECURITY
-- DEFINER functions in section 6 (Supabase RPC), which check app_can()
-- themselves -- no direct INSERT/UPDATE/DELETE grant on either table.
alter table goods_receipts enable row level security;
alter table goods_receipt_entries enable row level security;
grant select on goods_receipts to authenticated;
grant select on goods_receipt_entries to authenticated;

drop policy if exists goods_receipts_select on goods_receipts;
create policy goods_receipts_select on goods_receipts for select
  using (app_can('goods_receipt', 'view'));

drop policy if exists goods_receipt_entries_select on goods_receipt_entries;
create policy goods_receipt_entries_select on goods_receipt_entries for select
  using (app_can('goods_receipt', 'view'));

-- 5. Permissions: seed the new module scope the same way every other module
-- was introduced (dev seed users), and give every existing admin full
-- access, matching migration 0027's "admin access is real rows" convention.
insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
select id, 'goods_receipt', true, true, true, true, true, true
from app_users where id = '00000000-0000-0000-0000-000000000001'
on conflict (user_id, module) do update set
  can_view = true, can_create = true, can_edit = true, can_delete = true, can_approve = true, can_fill_section = true;

insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
select id, 'goods_receipt', true, false, false, false, false, true
from app_users where id = '00000000-0000-0000-0000-000000000002'
on conflict (user_id, module) do update set
  can_view = true, can_fill_section = true;

insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
select id, 'goods_receipt', true, true, true, true, true, true
from app_users where is_admin = true
on conflict (user_id, module) do update set
  can_view = true, can_create = true, can_edit = true, can_delete = true, can_approve = true, can_fill_section = true;


-- 6. Writes -- Supabase RPC (Postgres functions), not FastAPI.
--
-- Supabase is the primary backend: every Goods Receipt write that is pure
-- data (save header + entries, inward one container, delete) is one atomic
-- Postgres function called with supabase.rpc() -- one round trip, one
-- transaction, permission-checked with the same app_can() RLS uses. Only
-- pallet QR generation stays in FastAPI (POST /api/v1/goods-receipts/
-- {id}/entries/{entry_id}/generate-qr), because it renders QR PNGs, uploads
-- them to Storage and must share the existing RM numbering code
-- (qr_generation_service.generate_pallets) with every other RM batch.
--
-- Every function returns the full record in the exact GoodsReceiptDetail
-- shape the frontend uses, so the UI updates from the response directly.

create or replace function gr_detail_json(_id uuid) returns jsonb
  language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', g.id, 'po_number', g.po_number, 'vendor_id', g.vendor_id, 'vendor_name', g.vendor_name,
    'status', g.status, 'created_at', g.created_at, 'updated_at', g.updated_at,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'container_name', e.container_name, 'container_number', e.container_number,
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

create or replace function gr_recompute_status(_id uuid, _as_draft boolean) returns void
  language sql security definer set search_path = public
as $$
  update goods_receipts g set status = case
    when _as_draft then 'draft'
    else (
      select case
        when count(*) filter (where e.status = 'inwarded') = 0 then 'pending'
        when count(*) filter (where e.status = 'inwarded') = count(*) then 'received'
        else 'partial'
      end
      from goods_receipt_entries e where e.goods_receipt_id = _id
    )
  end
  where g.id = _id;
$$;

-- Create (_id null) or update a Goods Receipt with its container entries.
-- _payload: {po_number, vendor_id, as_draft, entries: [{id?, container_name,
--   container_number?, sku_code_id, sku_version_id?, po_quantity, unit}]}
-- Inwarded entries are locked: never changed or removed, whatever the payload says.
create or replace function goods_receipt_save(_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _po text := upper(btrim(coalesce(_payload->>'po_number', '')));
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
    select coalesce(array_agg(upper(btrim(container_name)) || '|' || sku_code_id || '|' || coalesce(sku_version_id::text, '')), '{}')
      into _keys from goods_receipt_entries where goods_receipt_id = _id and status = 'inwarded';
  end if;

  if _po = '' then raise exception 'PO Number is required.'; end if;
  select * into _vendor from vendors where id = _vendor_id;
  if not found then raise exception 'Select a valid Vendor.'; end if;
  if not _as_draft and jsonb_array_length(_entries) = 0 then
    raise exception 'Add at least one container entry before saving.';
  end if;
  if _any_inwarded then
    if _po <> _gr.po_number or _vendor_id is distinct from _gr.vendor_id then
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
    _name := upper(btrim(coalesce(_e->>'container_name', '')));
    _label := case when _name = '' then 'Entry ' || _i else _name end;
    if _name = '' then raise exception '%: Container Name is required.', _label; end if;
    select * into _sku from sku_codes where id = nullif(_e->>'sku_code_id', '')::uuid;
    if not found then raise exception '%: select a valid SKU.', _label; end if;
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
    insert into goods_receipts (po_number, vendor_id, vendor_name, status, created_by)
      values (_po, _vendor.id, _vendor.name, 'draft', app_user_id())
      returning * into _gr;
  else
    update goods_receipts set po_number = _po, vendor_id = _vendor.id, vendor_name = _vendor.name, updated_at = now()
      where id = _id;
    -- Drop removed pending entries first, so a re-used container+SKU on
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
      if _eid is not null then
        update goods_receipt_entries set
          container_name = upper(btrim(_e->>'container_name')),
          container_number = nullif(upper(btrim(coalesce(_e->>'container_number', ''))), ''),
          sku_code_id = _sku.id, sku_version_id = _ver_id,
          sku_code_snapshot = _sku.code, sku_version_snapshot = case when _ver_id is null then null else _ver_label end,
          po_quantity = (_e->>'po_quantity')::numeric, unit = coalesce(_e->>'unit', 'Units'), sort_order = _i
        where id = _eid;
      else
        insert into goods_receipt_entries (
          goods_receipt_id, container_name, container_number, sku_code_id, sku_version_id,
          sku_code_snapshot, sku_version_snapshot, po_quantity, unit, sort_order, status
        ) values (
          _gr.id, upper(btrim(_e->>'container_name')), nullif(upper(btrim(coalesce(_e->>'container_number', ''))), ''),
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
  elsif _constraint = 'uq_goods_receipt_entries_container_sku' then
    raise exception using errcode = '23505', message = 'The same container and SKU is listed more than once.';
  end if;
  raise;
end;
$$;

-- Inward ONE container/SKU entry: its own received quantity, unit and
-- pallet count. Changes nothing on any other entry. Idempotent -- an
-- already-inwarded entry is returned as-is (retry / double click / second
-- tab), never overwritten. The receipt row lock serializes concurrent inwards.
-- _payload: {received_quantity, unit, pallet_count, container_number?}
create or replace function goods_receipt_inward(_entry_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _gid uuid; _gr goods_receipts%rowtype; _row goods_receipt_entries%rowtype;
  _qty numeric; _pallets numeric; _unit text;
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
  select * into _row from goods_receipt_entries where id = _entry_id for update;
  if _row.status = 'inwarded' then
    return gr_detail_json(_gid);
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
    received_quantity = _qty, unit = _unit, pallet_count = _pallets::int,
    container_number = case when _payload ? 'container_number'
      then nullif(upper(btrim(coalesce(_payload->>'container_number', ''))), '') else container_number end,
    status = 'inwarded', inwarded_at = now(), inwarded_by = app_user_id()
  where id = _entry_id;
  update goods_receipts set updated_at = now() where id = _gid;
  perform gr_recompute_status(_gid, false);
  return gr_detail_json(_gid);
end;
$$;

-- Delete a Goods Receipt -- blocked once any container is inwarded (its
-- pallets/QRs reference the entry and must stay traceable).
create or replace function goods_receipt_delete(_id uuid) returns void
  language plpgsql security definer set search_path = public
as $$
declare _names text;
begin
  if not app_can('goods_receipt', 'delete') then
    raise exception using errcode = '42501', message = 'You do not have permission to delete Goods Receipts.';
  end if;
  perform 1 from goods_receipts where id = _id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Goods Receipt not found'; end if;
  select string_agg(container_name, ', ' order by sort_order) into _names
    from goods_receipt_entries where goods_receipt_id = _id and status = 'inwarded';
  if _names is not null then
    raise exception using errcode = '23503',
      message = 'This Goods Receipt can''t be deleted: ' || _names || ' already inwarded and linked to RM pallets.';
  end if;
  delete from goods_receipts where id = _id;
end;
$$;

revoke all on function gr_detail_json(uuid) from public;
revoke all on function gr_recompute_status(uuid, boolean) from public;
revoke all on function goods_receipt_save(uuid, jsonb) from public;
revoke all on function goods_receipt_inward(uuid, jsonb) from public;
revoke all on function goods_receipt_delete(uuid) from public;
grant execute on function goods_receipt_save(uuid, jsonb) to authenticated;
grant execute on function goods_receipt_inward(uuid, jsonb) to authenticated;
grant execute on function goods_receipt_delete(uuid) to authenticated;
