-- Factory and US Factory are two independent working units (records,
-- numbering, master data and permissions all separate). Migration 0047 made
-- permissions per unit; this one separates everything else.
--
-- 1. Every root record and master-data table gets `product`
--    ('factory' | 'us_factory'). Sub-records (entries, machine entries,
--    defect rows, line items, lifecycle events, ...) belong to their parent.
-- 2. Supabase (browser) reads/writes are confined to the unit the request
--    comes from -- the X-Product header, 0047's app_product() -- by one
--    RESTRICTIVE policy per table, ANDed with every existing policy. New
--    rows get their unit from the same header by default.
--    FastAPI stamps and filters `product` itself (app/db/product_scope.py);
--    it connects as the table owner, which bypasses RLS.
-- 3. Business numbers are unique per unit, not across both: each unit's
--    pallets, QR batches, Production Runs, container numbers etc. start at
--    1 and never collide, with no prefix. (factory_id_mark() becomes ''.)
-- 4. Master data (Vendors, SKU Names, Machines, Locations) is per unit; the
--    Setup screens show and edit only the current unit's lists. Locations
--    get a write policy for the new Setup -> Locations screen.
--
-- Existing rows are US Factory. Goods Receipts are Factory. Delete Factory
-- test data separately with factory_test_data_cleanup.sql.
-- Additive and re-runnable.

create or replace function app_request_product() returns text
  language sql stable
as $$
  select case when app_product() = 'factory' then 'factory' else 'us_factory' end
$$;

-- 1. product column + 2. restrictive unit policy -------------------------
alter table material_consumptions add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'material_consumptions_product_check') then
    alter table material_consumptions add constraint material_consumptions_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists material_consumptions_product_scope on material_consumptions;
create policy material_consumptions_product_scope on material_consumptions as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table production_runs add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'production_runs_product_check') then
    alter table production_runs add constraint production_runs_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists production_runs_product_scope on production_runs;
create policy production_runs_product_scope on production_runs as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table ipqc_records add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ipqc_records_product_check') then
    alter table ipqc_records add constraint ipqc_records_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists ipqc_records_product_scope on ipqc_records;
create policy ipqc_records_product_scope on ipqc_records as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table rqc_records add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rqc_records_product_check') then
    alter table rqc_records add constraint rqc_records_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists rqc_records_product_scope on rqc_records;
create policy rqc_records_product_scope on rqc_records as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table qr_generation_records add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'qr_generation_records_product_check') then
    alter table qr_generation_records add constraint qr_generation_records_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists qr_generation_records_product_scope on qr_generation_records;
create policy qr_generation_records_product_scope on qr_generation_records as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table pallets add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pallets_product_check') then
    alter table pallets add constraint pallets_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists pallets_product_scope on pallets;
create policy pallets_product_scope on pallets as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table storage_records add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'storage_records_product_check') then
    alter table storage_records add constraint storage_records_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists storage_records_product_scope on storage_records;
create policy storage_records_product_scope on storage_records as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table customer_shipments add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'customer_shipments_product_check') then
    alter table customer_shipments add constraint customer_shipments_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists customer_shipments_product_scope on customer_shipments;
create policy customer_shipments_product_scope on customer_shipments as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table shipment_picking_requests add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shipment_picking_requests_product_check') then
    alter table shipment_picking_requests add constraint shipment_picking_requests_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists shipment_picking_requests_product_scope on shipment_picking_requests;
create policy shipment_picking_requests_product_scope on shipment_picking_requests as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table goods_receipts add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'goods_receipts_product_check') then
    alter table goods_receipts add constraint goods_receipts_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists goods_receipts_product_scope on goods_receipts;
create policy goods_receipts_product_scope on goods_receipts as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table vendors add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'vendors_product_check') then
    alter table vendors add constraint vendors_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists vendors_product_scope on vendors;
create policy vendors_product_scope on vendors as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table sku_codes add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sku_codes_product_check') then
    alter table sku_codes add constraint sku_codes_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists sku_codes_product_scope on sku_codes;
create policy sku_codes_product_scope on sku_codes as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table machines add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'machines_product_check') then
    alter table machines add constraint machines_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists machines_product_scope on machines;
create policy machines_product_scope on machines as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
alter table locations add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'locations_product_check') then
    alter table locations add constraint locations_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists locations_product_scope on locations;
create policy locations_product_scope on locations as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
update goods_receipts set product = 'factory' where product <> 'factory';
-- Anything that came from a Goods Receipt is Factory's.
update qr_generation_records set product = 'factory' where source_goods_receipt_entry_id is not null and product <> 'factory';
update pallets set product = 'factory' where source_goods_receipt_entry_id is not null and product <> 'factory';
update storage_records set product = 'factory' where source_goods_receipt_entry_id is not null and product <> 'factory';

create index if not exists idx_production_runs_product_date_shift on production_runs (product, production_date, shift);
create index if not exists idx_pallets_product_type_status on pallets (product, pallet_type, lifecycle_status);
create index if not exists idx_material_consumptions_product on material_consumptions (product);
create index if not exists idx_ipqc_records_product on ipqc_records (product);
create index if not exists idx_rqc_records_product on rqc_records (product);
create index if not exists idx_qr_generation_records_product on qr_generation_records (product);
create index if not exists idx_storage_records_product on storage_records (product);
create index if not exists idx_customer_shipments_product on customer_shipments (product);
create index if not exists idx_shipment_picking_requests_product on shipment_picking_requests (product);

-- 3. Business numbers unique per unit (same names, so error handling that
--    matches on them keeps working) ----------------------------------------
alter table pallets drop constraint if exists pallets_display_id_key;
drop index if exists pallets_display_id_key;
create unique index pallets_display_id_key on pallets (product, display_id);
alter table qr_generation_records drop constraint if exists qr_generation_records_batch_display_id_key;
drop index if exists qr_generation_records_batch_display_id_key;
create unique index qr_generation_records_batch_display_id_key on qr_generation_records (product, batch_display_id);
alter table production_runs drop constraint if exists production_runs_run_number_key;
drop index if exists production_runs_run_number_key;
create unique index production_runs_run_number_key on production_runs (product, run_number);
alter table customer_shipments drop constraint if exists customer_shipments_shipment_number_key;
drop index if exists customer_shipments_shipment_number_key;
create unique index customer_shipments_shipment_number_key on customer_shipments (product, shipment_number);
alter table customer_shipments drop constraint if exists customer_shipments_container_number_key;
drop index if exists customer_shipments_container_number_key;
create unique index customer_shipments_container_number_key on customer_shipments (product, container_number);
alter table machines drop constraint if exists machines_code_key;
drop index if exists machines_code_key;
create unique index machines_code_key on machines (product, code);
alter table locations drop constraint if exists locations_display_id_key;
drop index if exists locations_display_id_key;
create unique index locations_display_id_key on locations (product, display_id);
alter table sku_codes drop constraint if exists sku_codes_code_key;
drop index if exists sku_codes_code_key;
create unique index sku_codes_code_key on sku_codes (product, code);
alter table vendors drop constraint if exists vendors_category_name_key;
drop index if exists vendors_category_name_key;
create unique index vendors_category_name_key on vendors (product, category, name);

create or replace function factory_id_mark() returns text
  language sql immutable as $$ select ''::text $$;

-- sku_versions belong to their SKU: writable only through an SKU of the
-- current unit (the subquery sees sku_codes through its product policy).
drop policy if exists sku_versions_product_scope on sku_versions;
create policy sku_versions_product_scope on sku_versions as restrictive for all
  using (exists (select 1 from sku_codes s where s.id = sku_versions.sku_code_id))
  with check (exists (select 1 from sku_codes s where s.id = sku_versions.sku_code_id));

-- 4. Master-data write permissions per unit. Vendors / SKU Names were gated
-- on US Factory's Inward Vehicle Inspection edit right; inside Factory they
-- are gated on Factory's Goods Receipt (the module that uses them).
drop policy if exists sku_codes_write on sku_codes;
create policy sku_codes_write on sku_codes for all
  using (app_can(case when app_request_product() = 'factory' then 'goods_receipt' else 'inward_vehicle_inspection' end, 'edit'))
  with check (app_can(case when app_request_product() = 'factory' then 'goods_receipt' else 'inward_vehicle_inspection' end, 'edit'));
drop policy if exists sku_versions_write on sku_versions;
create policy sku_versions_write on sku_versions for all
  using (app_can(case when app_request_product() = 'factory' then 'goods_receipt' else 'inward_vehicle_inspection' end, 'edit'))
  with check (app_can(case when app_request_product() = 'factory' then 'goods_receipt' else 'inward_vehicle_inspection' end, 'edit'));
drop policy if exists vendors_write on vendors;
create policy vendors_write on vendors for all
  using (app_can(case when app_request_product() = 'factory' then 'goods_receipt' else 'inward_vehicle_inspection' end, 'edit'))
  with check (app_can(case when app_request_product() = 'factory' then 'goods_receipt' else 'inward_vehicle_inspection' end, 'edit'));
-- Locations: new Setup -> Locations screen (RM Storage edit right; in
-- Factory, 0047 maps that to Factory RM Storage).
grant select, insert, update on locations to authenticated;
drop policy if exists locations_write on locations;
create policy locations_write on locations for all
  using (app_can('rm_storage', 'edit')) with check (app_can('rm_storage', 'edit'));
drop policy if exists locations_select on locations;
create policy locations_select on locations for select using (app_user_id() is not null);

-- 5. Goods Receipt functions: Factory vendors/SKUs only, rows stamped Factory.

create or replace function goods_receipt_save(_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _po text := upper(btrim(coalesce(_payload->>'po_number', '')));
  _category text := nullif(btrim(coalesce(_payload->>'category', '')), '');
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
  if _category is null or _category not in ('tray', 'fnp_tray', 'film', 'pad', 'polybag', 'cfb', 'glue') then
    raise exception 'Select a Category.';
  end if;
  select * into _vendor from vendors where id = _vendor_id and product = 'factory';
  if not found then raise exception 'Select a valid Vendor.'; end if;
  if _vendor.category <> _category then raise exception 'The selected Vendor is not set up for this Category.'; end if;
  if not _as_draft and jsonb_array_length(_entries) = 0 then
    raise exception 'Add at least one container before saving.';
  end if;
  if _any_inwarded then
    if _po <> _gr.po_number or _vendor_id is distinct from _gr.vendor_id or _category is distinct from _gr.category then
      raise exception using errcode = '23503', message = 'PO Number, Category and Vendor can''t be changed once a container has been inwarded.';
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
    if _sku.category <> _category then raise exception '%: SKU % is not a % SKU.', _label, _sku.code, _category; end if;
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
    insert into goods_receipts (product, po_number, category, vendor_id, vendor_name, status, created_by)
      values ('factory', _po, _category, _vendor.id, _vendor.name, 'draft', app_user_id())
      returning * into _gr;
  else
    update goods_receipts set po_number = _po, category = _category, vendor_id = _vendor.id,
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
      if _eid is not null then
        update goods_receipt_entries set
          shipment_number = upper(btrim(_e->>'shipment_number')),
          sku_code_id = _sku.id, sku_version_id = _ver_id,
          sku_code_snapshot = _sku.code, sku_version_snapshot = case when _ver_id is null then null else _ver_label end,
          po_quantity = (_e->>'po_quantity')::numeric, unit = coalesce(_e->>'unit', 'Units'), sort_order = _i
        where id = _eid;
      else
        insert into goods_receipt_entries (
          goods_receipt_id, shipment_number, sku_code_id, sku_version_id,
          sku_code_snapshot, sku_version_snapshot, po_quantity, unit, sort_order, status
        ) values (
          _gr.id, upper(btrim(_e->>'shipment_number')),
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


create or replace function goods_receipt_generate_pallets(_entry_id uuid) returns uuid
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _b qr_generation_records%rowtype;
  _country text; _category text; _base text; _yymm text; _did text; _pid uuid; _actor uuid := app_user_id();
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
  _category := coalesce(_gr.category, (select category from sku_codes where id = _e.sku_code_id));

  if _b.id is null then
    insert into qr_generation_records (
      product, batch_display_id, qr_type, category, source_goods_receipt_entry_id, shipment_number,
      sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
      country_code, quantity, status, created_by
    ) values (
      'factory', factory_id_mark() || 'RMQR-' || lpad(factory_next_seq('qr_batch:rm')::text, 4, '0'),
      'rm', _category, _e.id, _e.shipment_number,
      _e.sku_code_id, _e.sku_version_id, _e.sku_code_snapshot, _e.sku_version_snapshot,
      _country, _e.pallet_count, 'pending', _actor
    ) returning * into _b;
  end if;

  _base := _country || '-' || factory_pallet_suffix(_category);
  _yymm := to_char(now() at time zone 'utc', 'YYMM');
  for _i in 1.._b.quantity loop
    _did := factory_id_mark() || _base || '-' || _yymm || '-' || lpad(factory_next_seq('pallet:' || _base)::text, 4, '0');
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


revoke all on function goods_receipt_save(uuid, jsonb) from public;
revoke all on function goods_receipt_generate_pallets(uuid) from public;
grant execute on function goods_receipt_save(uuid, jsonb) to authenticated;
grant execute on function goods_receipt_generate_pallets(uuid) to authenticated;
