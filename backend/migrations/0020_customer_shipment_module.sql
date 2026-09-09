-- Customer Shipment / Shipment Picking modules -- the downstream workflow
-- after FG Storage:
--   FG Storage -> Customer Shipment -> Shipment Picking
--
-- Neither module existed before this migration (confirmed via repo-wide
-- grep). Design notes:
--
-- 1) No new tables were added for anything that an existing table already
--    covers. Pallet.lifecycle_status + PalletLifecycleEvent (already
--    anticipating 'picked'/'shipped' as terminal states -- see
--    storage_service.resolve_pallet_for_storage's existing guard) and
--    StorageRecord (the existing "currently in storage" representation)
--    are reused as-is for tracking a pallet's pick. The one genuinely new
--    piece of information nothing existing tracks is "which specific
--    pallet was picked against which Shipment Picking request, and from
--    which location" -- needed to support undo/remove-pick -- so
--    shipment_picking_picks is a real new table, not a duplicate of
--    anything above.
-- 2) customer_shipments / customer_shipment_line_items /
--    shipment_picking_requests are new because nothing existing models
--    "a customer shipment order" or "a required pallet quantity of a given
--    SKU/version owed to a shipment" -- StorageRecord and Pallet describe
--    physical state, not a commercial shipment requirement.
-- 3) One Shipment Picking request per Customer Shipment line item (not one
--    per shipment) -- see customer_shipment_service.create_customer_shipment.
--    unique(customer_shipment_line_item_id) on shipment_picking_requests is
--    the hard backstop against duplicate fan-out.
-- 4) Snapshot-at-creation convention (matches qr_generation_records /
--    pallets / rqc_records): shipment_picking_requests snapshots
--    shipment_number, container_number, customer, sku_code_snapshot,
--    sku_version_snapshot from its parent Customer Shipment / line item at
--    creation time rather than joining back through 3 tables on every read.
-- 5) Delete-block: customer_shipment_line_items and shipment_picking_requests
--    both use default RESTRICT (no "on delete cascade") on their
--    customer_shipment_id FK where a dependent Shipment Picking request
--    exists, so the DB itself backstops the app-level pre-check in
--    customer_shipment_service.blocked_delete_reason -- no duplicate
--    dependency-tracking logic invented at the app layer.
-- 6) Customer Shipment has no status workflow of its own (per spec) --
--    creation is the completion event. The only status field that changes
--    over time is shipment_picking_requests.status ('pending' -> 'partial'
--    -> 'complete'), recomputed from the sum of its own picks.
-- 7) A narrow, additional SELECT-only policy is opened on the existing
--    display_id_counters table so the browser client can peek at (never
--    increment) the next Shipment/Container number for the create-panel
--    preview, per the spec's explicit "preview without consuming the
--    counter" requirement -- this is the minimal schema change needed,
--    not a new table.

create table if not exists customer_shipments (
  id uuid primary key default gen_random_uuid(),
  shipment_number text not null unique,
  container_number text not null unique,
  customer text not null,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_customer_shipments_created_at on customer_shipments(created_at);

create table if not exists customer_shipment_line_items (
  id uuid primary key default gen_random_uuid(),
  customer_shipment_id uuid not null references customer_shipments(id) on delete cascade,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  pallets_required integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_cs_line_items_shipment on customer_shipment_line_items(customer_shipment_id);

create table if not exists shipment_picking_requests (
  id uuid primary key default gen_random_uuid(),
  customer_shipment_id uuid not null references customer_shipments(id),
  customer_shipment_line_item_id uuid not null unique references customer_shipment_line_items(id),
  shipment_number text,
  container_number text,
  customer text,
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  pallets_required integer not null default 0,
  status text not null default 'pending',  -- 'pending' | 'partial' | 'complete'
  created_at timestamptz not null default now()
);

create index if not exists idx_sp_requests_shipment on shipment_picking_requests(customer_shipment_id);
create index if not exists idx_sp_requests_status on shipment_picking_requests(status);

create table if not exists shipment_picking_picks (
  id uuid primary key default gen_random_uuid(),
  shipment_picking_request_id uuid not null references shipment_picking_requests(id) on delete cascade,
  pallet_id uuid not null references pallets(id),
  location_id uuid references locations(id),
  picked_by uuid references app_users(id),
  picked_at timestamptz not null default now(),
  unique(shipment_picking_request_id, pallet_id)
);

create index if not exists idx_sp_picks_request on shipment_picking_picks(shipment_picking_request_id);

-- Ownership matches every other transactional table: owned by the role
-- FastAPI's service connection runs as, so its writes bypass RLS. RLS is
-- enabled purely to open the SELECT side for direct-Supabase list/detail
-- reads, per the spec's "prefer Supabase over Python for reads" mandate.
alter table customer_shipments enable row level security;
alter table customer_shipment_line_items enable row level security;
alter table shipment_picking_requests enable row level security;
alter table shipment_picking_picks enable row level security;

grant select on customer_shipments to authenticated;
grant select on customer_shipment_line_items to authenticated;
grant select on shipment_picking_requests to authenticated;
grant select on shipment_picking_picks to authenticated;

drop policy if exists customer_shipments_select on customer_shipments;
create policy customer_shipments_select on customer_shipments for select
  using (app_can('customer_shipment', 'view'));

drop policy if exists customer_shipment_line_items_select on customer_shipment_line_items;
create policy customer_shipment_line_items_select on customer_shipment_line_items for select
  using (app_can('customer_shipment', 'view'));

drop policy if exists shipment_picking_requests_select on shipment_picking_requests;
create policy shipment_picking_requests_select on shipment_picking_requests for select
  using (app_can('shipment_picking', 'view'));

drop policy if exists shipment_picking_picks_select on shipment_picking_picks;
create policy shipment_picking_picks_select on shipment_picking_picks for select
  using (app_can('shipment_picking', 'view'));

-- Narrow additional read policy: counters hold no sensitive data and are
-- already shared infrastructure touched by every module's numbering, so
-- this opens plain SELECT (never UPDATE) to any authenticated user rather
-- than adding an arbitrary single-module restriction. Used only for the
-- non-incrementing "next number" preview in the Customer Shipment create
-- panel -- actual allocation still only ever happens via next_seq()'s
-- atomic UPSERT inside the FastAPI create transaction.
grant select on display_id_counters to authenticated;

drop policy if exists display_id_counters_select on display_id_counters;
create policy display_id_counters_select on display_id_counters for select
  using (true);

alter table display_id_counters enable row level security;

insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
values
  ('00000000-0000-0000-0000-000000000001', 'customer_shipment', true, true, false, true, false, false),
  ('00000000-0000-0000-0000-000000000002', 'customer_shipment', true, false, false, false, false, false),
  ('00000000-0000-0000-0000-000000000001', 'shipment_picking', true, true, false, false, false, false),
  ('00000000-0000-0000-0000-000000000002', 'shipment_picking', true, false, false, false, false, false)
on conflict (user_id, module) do update set
  can_view = greatest(module_permissions.can_view, excluded.can_view),
  can_create = greatest(module_permissions.can_create, excluded.can_create),
  can_edit = greatest(module_permissions.can_edit, excluded.can_edit),
  can_delete = greatest(module_permissions.can_delete, excluded.can_delete),
  can_approve = greatest(module_permissions.can_approve, excluded.can_approve),
  can_fill_section = greatest(module_permissions.can_fill_section, excluded.can_fill_section);
