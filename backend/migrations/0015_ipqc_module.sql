-- IPQC (In-Process Quality Control) module -- makes the previously
-- minimal IpqcRecord stub (added only to give Material Consumption's
-- Production Run a downstream link) into the actual module the HTML
-- prototype describes: autopopulated Product/Shipment Details, editable
-- Shift Incharge, and repeatable Check Time inspection blocks with the
-- prototype's fixed 8-defect list per block.
--
-- Design notes (mirrors the reasoning in 0013/0014 for Production):
-- 1) sku_versions.prod_dimensions / prod_absorption_rate complete the
--    prototype's SKU_PRODUCTION_DETAILS lookup -- Production didn't need
--    these two, IPQC's "Dimensions of Pad" / "Absorption Rate" do.
-- 2) shipment_number/batch_code/manufacturer/pad_color/weight/dimensions/
--    absorption_rate on ipqc_records are autopopulated once at creation
--    (IPQC_LOCKABLE_IDS in the prototype -- never re-entered); shift_incharge
--    is genuinely user-entered.
-- 3) ipqc_check_blocks / ipqc_block_defects are real child tables (not a
--    JSON blob) per the "use normalized PK/FK relationships" instruction --
--    same pattern as production_wastage_entries. defect_sr references the
--    prototype's fixed IPQC_DEFECTS list (static frontend data, not a DB
--    table, matching how Rejection Classification's labels aren't a table
--    either).
-- 4) IPQC gets its own module scope ('ipqc') in module_permissions,
--    tightening ipqc_records' previous blanket "any authenticated user"
--    SELECT policy (0011) the same way 0012 did for production_runs.

alter table sku_versions add column if not exists prod_dimensions text;
alter table sku_versions add column if not exists prod_absorption_rate text;

alter table ipqc_records add column if not exists shipment_number text;
alter table ipqc_records add column if not exists batch_code text;
alter table ipqc_records add column if not exists manufacturer text;
alter table ipqc_records add column if not exists pad_color text;
alter table ipqc_records add column if not exists weight text;
alter table ipqc_records add column if not exists dimensions text;
alter table ipqc_records add column if not exists absorption_rate text;
alter table ipqc_records add column if not exists shift_incharge text;

create table if not exists ipqc_check_blocks (
  id uuid primary key default gen_random_uuid(),
  ipqc_record_id uuid not null references ipqc_records(id) on delete cascade,
  check_time text,
  overall_result text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_ipqc_check_blocks_record on ipqc_check_blocks(ipqc_record_id);

create table if not exists ipqc_block_defects (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references ipqc_check_blocks(id) on delete cascade,
  defect_sr integer not null,
  failure numeric,
  reason text,
  unique(block_id, defect_sr)
);

create index if not exists idx_ipqc_block_defects_block on ipqc_block_defects(block_id);

-- Ownership must match every other transactional table (production_runs,
-- production_wastage_entries, ipqc_records itself, ...): whatever role the
-- FastAPI backend's own DB connection uses needs to write these tables
-- without RLS getting in the way, and RLS only lets a non-owner role
-- through when a policy explicitly permits it -- these two only ever get
-- an insert/update/delete via ipqc.py's own require("edit") check, not
-- RLS, so they must be owned the same way their parent (ipqc_records) is.
--
-- 'factory_app' is only a real role in the local dev sandbox (a stand-in
-- for "the backend's app role" used to test this migration end to end --
-- see the delivery notes). On the real Supabase project FastAPI connects
-- via the service-role/postgres connection string, which already owns
-- and bypasses RLS on every table it creates, so there is nothing to
-- reassign there -- this block only fires where 'factory_app' actually
-- exists, and is a no-op everywhere else (Supabase included).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'factory_app') then
    alter table ipqc_check_blocks owner to factory_app;
    alter table ipqc_block_defects owner to factory_app;
  end if;
end $$;

alter table ipqc_check_blocks enable row level security;
alter table ipqc_block_defects enable row level security;

grant select on ipqc_check_blocks to authenticated;
grant select on ipqc_block_defects to authenticated;

drop policy if exists ipqc_check_blocks_select on ipqc_check_blocks;
create policy ipqc_check_blocks_select on ipqc_check_blocks for select
  using (app_can('ipqc', 'view'));

drop policy if exists ipqc_block_defects_select on ipqc_block_defects;
create policy ipqc_block_defects_select on ipqc_block_defects for select
  using (app_can('ipqc', 'view'));

-- Tighten ipqc_records' own SELECT policy from "any authenticated user"
-- (0011, back when IPQC had no module of its own) to the same
-- module-scoped app_can() gate every other module uses.
drop policy if exists ipqc_records_select on ipqc_records;
create policy ipqc_records_select on ipqc_records for select
  using (app_can('ipqc', 'view'));
