-- 2026-09-28 -- Links a Customer Shipment / Goods Outward line item to the
-- Production Run(s) that actually made the trays going out on it, so
-- "Trays" (renamed from Pcs) can be derived rather than hand-typed: Trays
-- = SUM(linked runs' Total FG Pallets Generated) x Trays per Sleeve
-- (SkuVersion.prod_pcs_per_sleeve / the line item's own pcs_per_sleeve).
-- A line item can draw from more than one run (e.g. two shifts/machines
-- both contributed pallets to the same shipment), hence a join table
-- rather than a single FK.
--
-- Manual entry is still supported: a line item with no linked run keeps
-- accepting a hand-typed Trays value exactly as before (see
-- customer_shipment_service.py) -- this is additive, not a hard
-- requirement.
--
-- Additive / idempotent, safe to re-run.

create table if not exists customer_shipment_line_item_production_runs (
  id uuid primary key default gen_random_uuid(),
  line_item_id uuid not null references customer_shipment_line_items(id) on delete cascade,
  production_run_id uuid not null references production_runs(id) on delete cascade,
  unique (line_item_id, production_run_id)
);
create index if not exists idx_cs_li_runs_line_item on customer_shipment_line_item_production_runs (line_item_id);
create index if not exists idx_cs_li_runs_run on customer_shipment_line_item_production_runs (production_run_id);

-- Writes go through FastAPI (customer_shipment_service.py), but this is
-- read directly via Supabase like customer_shipment_line_items itself
-- (migration 0020's "prefer Supabase over Python for reads" mandate) --
-- same select-only grant/policy, same app_can('customer_shipment', 'view')
-- check (already transparently remapped to 'factory_goods_outward' for
-- the Factory product by migration 0047's app_can()).
alter table customer_shipment_line_item_production_runs enable row level security;
grant select on customer_shipment_line_item_production_runs to authenticated;

drop policy if exists cs_li_production_runs_select on customer_shipment_line_item_production_runs;
create policy cs_li_production_runs_select on customer_shipment_line_item_production_runs for select
  using (app_can('customer_shipment', 'view'));
