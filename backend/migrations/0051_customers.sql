-- Customer master data for Goods Outward's "Customer / Recipient" field
-- (2026-09-24). Previously a freehand text field on Customer Shipment /
-- Goods Outward; now backed by a managed list (a new Setup -> Customers
-- admin screen, mirroring vendors/machines/locations exactly) so it can be
-- a dropdown instead. `customer_shipments.customer` stays a plain text
-- column (not a foreign key) -- deleting or renaming a customer here never
-- rewrites history on an already-created shipment.
--
-- Product-scoped from creation (unlike vendors, which only became scoped
-- later in migration 0048) since Factory already has the Factory/US
-- Factory data-separation architecture in place -- every row is stamped
-- with the product ('factory' | 'us_factory') it was created under, and
-- RLS enforces a request can only ever see/write its own product's rows.
-- Permission is gated through the existing customer_shipment module,
-- which api/deps.py's FACTORY_PERMISSION_MAP already remaps to
-- factory_goods_outward under the Factory product header -- no new
-- permission module needed, same "reuse the permission of the module this
-- master data serves" convention Vendors follows for inward_vehicle_
-- inspection.

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  product text not null default app_request_product(),
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'customers_product_check') then
    alter table customers add constraint customers_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;

create unique index if not exists customers_product_name_key on customers (product, name);

alter table customers enable row level security;

grant select, insert, update, delete on customers to authenticated;

drop policy if exists customers_product_scope on customers;
create policy customers_product_scope on customers as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());

drop policy if exists customers_select on customers;
create policy customers_select on customers for select
  using (app_user_id() is not null);

drop policy if exists customers_write on customers;
create policy customers_write on customers for all
  using (app_can('customer_shipment', 'edit'))
  with check (app_can('customer_shipment', 'edit'));
