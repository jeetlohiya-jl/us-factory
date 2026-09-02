-- Material Consumption: one record now supports MULTIPLE machines, each
-- with its own pallet set (primary + secondary materials), its own
-- Category/SKU/SKU Version (established by that machine's first scanned
-- primary pallet, same as before), and its own start_time/end_time --
-- rather than one record being pinned to exactly one machine with one
-- shared start/end time. Shift stays shared across the whole record (one
-- record = one shift, still), since that's how the spec groups things:
-- Machine -> Shift -> Pallet -> Secondary Materials -> Start Time -> End Time,
-- with Shift set once per record and everything else per machine.
--
-- Non-destructive: existing material_consumptions rows keep their
-- machine_id/category/sku_*/start_time/end_time columns exactly as they
-- are (nothing dropped, nothing overwritten) -- each existing row is
-- backfilled into exactly one new material_consumption_machine_entries
-- row carrying those same values, and every existing
-- material_consumption_pallets row is pointed at that one backfilled
-- entry. Application code stops reading/writing the old columns on
-- material_consumptions going forward; they're left in place purely as a
-- non-destructive migration safety net, not because they're still used.

create table if not exists material_consumption_machine_entries (
  id uuid primary key default gen_random_uuid(),
  material_consumption_id uuid not null references material_consumptions(id) on delete cascade,
  machine_id uuid references machines(id),
  category text, -- 'tray' | 'fgtray', set by this entry's first primary pallet scan
  sku_code_id uuid references sku_codes(id),
  sku_version_id uuid references sku_versions(id),
  sku_code_snapshot text,
  sku_version_snapshot text,
  start_time text,
  end_time text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ix_mc_machine_entries_mc_id on material_consumption_machine_entries(material_consumption_id);
create index if not exists ix_mc_machine_entries_machine_id on material_consumption_machine_entries(machine_id);

alter table material_consumption_pallets
  add column if not exists machine_entry_id uuid references material_consumption_machine_entries(id) on delete cascade;
create index if not exists ix_mc_pallets_machine_entry_id on material_consumption_pallets(machine_entry_id);

-- Backfill: one machine entry per existing material_consumptions row,
-- carrying that row's existing machine/category/sku/start/end values.
insert into material_consumption_machine_entries
  (id, material_consumption_id, machine_id, category, sku_code_id, sku_version_id,
   sku_code_snapshot, sku_version_snapshot, start_time, end_time, sort_order, created_at)
select
  gen_random_uuid(), mc.id, mc.machine_id, mc.category, mc.sku_code_id, mc.sku_version_id,
  mc.sku_code_snapshot, mc.sku_version_snapshot, mc.start_time, mc.end_time, 0, mc.created_at
from material_consumptions mc
where not exists (
  select 1 from material_consumption_machine_entries e where e.material_consumption_id = mc.id
);

-- Point every existing pallet row at the (now backfilled) single entry for its record.
update material_consumption_pallets p
set machine_entry_id = e.id
from material_consumption_machine_entries e
where p.machine_entry_id is null and e.material_consumption_id = p.material_consumption_id;
