-- Factory and US Factory are two independent working units: their
-- permissions are separate.
--
-- Factory's modules 2-6 reuse US Factory's screens and tables, so until now
-- they also reused US Factory's permission rows (e.g. Factory -> RM Storage
-- was the same row as US Factory -> RM Storage). From here on each Factory
-- module has its own permission row:
--
--   Goods Receipt            goods_receipt                 (already Factory-only)
--   RM Storage               factory_rm_storage
--   Raw Material Consumption factory_material_consumption
--   Production               factory_production
--   RQC & FG QR              factory_rqc_fg_qr
--   Finished Goods Storage   factory_fg_storage
--   Goods Outward            factory_goods_outward
--
-- How it's enforced without forking any screen: the app sends which
-- product the person is in (header X-Product: factory | us_factory) on
-- every request. When it's "factory", a check for a shared module is
-- answered from the Factory row instead -- here for Supabase (RLS policies
-- and RPC functions all go through app_can), and identically in FastAPI
-- (app/api/deps.py effective_permission / FACTORY_PERMISSION_MAP) and the
-- frontend (lib/currentProduct.ts). US Factory checks are unchanged.
--
-- Additive and re-runnable.

-- Which product the current Supabase request comes from (PostgREST exposes
-- request headers as JSON; empty for direct DB connections such as FastAPI's).
create or replace function app_product() returns text
  language sql stable
as $$
  select lower(coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-product', ''))
$$;

-- Keep in sync with FACTORY_PERMISSION_MAP in app/api/deps.py and
-- frontend/src/lib/currentProduct.ts.
create or replace function app_effective_module(_module text) returns text
  language sql stable
as $$
  select case when app_product() = 'factory' then
    case _module
      when 'rm_storage'           then 'factory_rm_storage'
      when 'rm_qr_generation'     then 'goods_receipt'
      when 'material_consumption' then 'factory_material_consumption'
      when 'production'           then 'factory_production'
      when 'ipqc'                 then 'factory_production'
      when 'rqc'                  then 'factory_rqc_fg_qr'
      when 'fg_qr_generation'     then 'factory_rqc_fg_qr'
      when 'fg_storage'           then 'factory_fg_storage'
      when 'customer_shipment'    then 'factory_goods_outward'
      when 'shipment_picking'     then 'factory_goods_outward'
      else _module
    end
  else _module end
$$;

-- Same as migration 0027's app_can, with the module resolved per product.
create or replace function app_can(_module text, _action text) returns boolean
  language sql stable security definer
  set search_path = public
as $$
  select coalesce(
    (
      select case _action
        when 'view' then can_view
        when 'create' then can_create
        when 'edit' then can_edit
        when 'delete' then can_delete
        when 'approve' then can_approve
        when 'fill_section' then can_fill_section
        else false
      end
      from module_permissions
      where user_id = app_user_id() and module = app_effective_module(_module)
    ),
    -- No explicit row => view-only default, exactly matching
    -- ModulePermission(can_view=True) in every FastAPI *_get_perms().
    _action = 'view'
  );
$$;

-- Seed: nobody loses access on deploy. Each user's new Factory rows start
-- as a copy of the US Factory rows those Factory screens used until now
-- (a Factory module built on two US modules gets the union of both).
-- "do nothing" on conflict, so re-running never overwrites a permission
-- an admin has since changed.
insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
select mp.user_id, m.factory_module,
       bool_or(mp.can_view), bool_or(mp.can_create), bool_or(mp.can_edit),
       bool_or(mp.can_delete), bool_or(mp.can_approve), bool_or(mp.can_fill_section)
from module_permissions mp
join (values
  ('rm_storage',           'factory_rm_storage'),
  ('material_consumption', 'factory_material_consumption'),
  ('production',           'factory_production'),
  ('rqc',                  'factory_rqc_fg_qr'),
  ('fg_qr_generation',     'factory_rqc_fg_qr'),
  ('fg_storage',           'factory_fg_storage'),
  ('customer_shipment',    'factory_goods_outward'),
  ('shipment_picking',     'factory_goods_outward')
) as m(us_module, factory_module) on mp.module = m.us_module
group by mp.user_id, m.factory_module
on conflict (user_id, module) do nothing;
