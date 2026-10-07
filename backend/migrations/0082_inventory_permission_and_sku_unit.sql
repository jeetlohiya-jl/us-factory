-- Inventory fixes (2026-10):
--  1. "+ Add" was disabled for everyone: app_bootstrap() (0050) builds each
--     person's permissions from a fixed module list that predates Inventory,
--     so permissions.inventory never reached the screen -- even though the
--     Users screen grants it and the Inventory API enforces it.
--  2. An Inventory item's UOM is its SKU's UOM (sku_codes.default_unit,
--     0077, set in Setup -> SKUs) -- read-only on Inventory's Add / Edit.
--  3. Soaker Pads are counted in Pcs: MG-201-CT / MG-440 / MG-570 were
--     seeded as Pcs (0062), but on-conflict-do-nothing skipped MG-440 /
--     MG-570 whose items Goods Receipt had already created in the GR line's
--     unit (Kgs). Goods Receipt now creates new items in the SKU's UOM.
-- Additive and re-runnable.

-- 1 ----------------------------------------------------------------------
create or replace function app_bootstrap() returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  _sub uuid := nullif(_claims->>'sub', '')::uuid;
  _email text := lower(btrim(coalesce(_claims->>'email', '')));
  _u app_users%rowtype;
  _pa portfolio_access%rowtype;
  _perms jsonb := '{}'::jsonb;
  _m text;
  _p module_permissions%rowtype;
begin
  if _sub is null or _email = '' then
    raise exception using errcode = '42501', message = 'Not signed in.';
  end if;
  select * into _pa from portfolio_access where lower(email) = _email;
  select * into _u from app_users where lower(email) = _email and is_active;
  if _u.id is not null then
    if _u.auth_user_id is distinct from _sub then
      begin
        update app_users set auth_user_id = _sub where id = _u.id;
      exception when unique_violation then
        null;  -- another row already claims this auth user; email matching still works
      end;
    end if;
    foreach _m in array array['inward_vehicle_inspection', 'inward_qc', 'rm_qr_generation', 'rm_storage', 'material_consumption', 'production', 'ipqc', 'rqc', 'fg_qr_generation', 'fg_storage', 'customer_shipment', 'shipment_picking', 'outward_vehicle_inspection', 'machine_downtime', 'goods_receipt', 'factory_rm_storage', 'factory_material_consumption', 'factory_production', 'factory_rqc_fg_qr', 'factory_fg_storage', 'factory_goods_outward', 'inventory']::text[] loop
      select * into _p from module_permissions where user_id = _u.id and module = _m;
      _perms := _perms || jsonb_build_object(_m, case when _p.id is null then
        jsonb_build_object('can_view', true, 'can_create', false, 'can_edit', false, 'can_delete', false, 'can_approve', false, 'can_fill_section', false)
      else
        jsonb_build_object('can_view', _p.can_view, 'can_create', _p.can_create, 'can_edit', _p.can_edit,
                           'can_delete', _p.can_delete, 'can_approve', _p.can_approve, 'can_fill_section', _p.can_fill_section)
      end);
      _p := null;
    end loop;
  end if;
  return jsonb_build_object(
    'portfolio', jsonb_build_object('access_factory', coalesce(_pa.access_factory, false), 'access_us_factory', coalesce(_pa.access_us_factory, false)),
    'me', case when _u.id is null then null else jsonb_build_object(
      'user_id', _u.id, 'email', _u.email, 'full_name', _u.full_name, 'is_admin', coalesce(_u.is_admin, false), 'permissions', _perms) end
  );
end;
$$;
revoke all on function app_bootstrap() from public;
grant execute on function app_bootstrap() to authenticated;

-- 2 ----------------------------------------------------------------------
-- The SKU's UOM is sku_codes.default_unit (0077, editable in Setup -> SKUs;
-- the Zoho sync already prefers it, 0078). Soaker Pads never got one, so
-- their PO lines -- and from them Goods Receipt and Inventory -- took Kgs.
update sku_codes set default_unit = 'Pcs'
  where category = 'pad' and default_unit is distinct from 'Pcs';
-- Every other SKU with an Inventory item but no default_unit yet: the unit
-- its item already uses, so Inventory's (now read-only) UOM is never blank.
update sku_codes s set default_unit = ii.uom
  from inventory_items ii
  where ii.sku_code_id = s.id and (s.default_unit is null or btrim(s.default_unit) = '')
    and ii.uom in ('Pallets', 'Kgs', 'Units', 'Bags', 'Rolls', 'Pairs', 'Sets', 'Pcs');

-- 3 ----------------------------------------------------------------------
-- Inventory items follow their SKU's UOM (fixes MG-440 / MG-570 in Kgs).
update inventory_items ii set uom = s.default_unit, updated_at = now()
  from sku_codes s
  where s.id = ii.sku_code_id and s.default_unit is not null and ii.uom is distinct from s.default_unit;

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

  -- A new item takes the SKU's own UOM (sku_codes.default_unit) -- not the
  -- Goods Receipt line's unit, which is how Soaker Pads ended up in Kgs.
  insert into inventory_items (product, sku_code_id, uom)
    values ('factory', _e.sku_code_id,
            coalesce((select nullif(btrim(default_unit), '') from sku_codes where id = _e.sku_code_id), _e.unit))
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

-- 4 ----------------------------------------------------------------------
-- Changing a SKU's UOM in Setup -> SKUs (saved straight to sku_codes)
-- updates its Inventory item at once -- however the SKU is changed.
create or replace function sku_codes_sync_inventory_uom() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if nullif(btrim(coalesce(new.default_unit, '')), '') is not null
     and new.default_unit is distinct from old.default_unit then
    update inventory_items set uom = new.default_unit, updated_at = now()
      where sku_code_id = new.id and uom is distinct from new.default_unit;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_sku_codes_sync_inventory_uom on sku_codes;
create trigger trg_sku_codes_sync_inventory_uom
  after update of default_unit on sku_codes
  for each row execute function sku_codes_sync_inventory_uom();
