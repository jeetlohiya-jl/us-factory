-- 2026-09-28 -- Inventory: a material can be compatible with more than
-- one tray SKU (migration 0059/0060's reference sheet lists e.g. "3P &
-- 3D" for one Polybag SKU, "7S & 8P" for another) -- replaces the
-- single compatible_tray_sku_code_id column on inventory_items with a
-- proper many-to-many (inventory_compatible_trays).
--
-- Additive / idempotent, safe to re-run.

create table if not exists inventory_compatible_trays (
  id uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references inventory_items(id) on delete cascade,
  tray_sku_code_id uuid not null references sku_codes(id) on delete cascade,
  unique (inventory_item_id, tray_sku_code_id)
);
create index if not exists idx_inventory_compatible_trays_item on inventory_compatible_trays (inventory_item_id);
alter table inventory_compatible_trays enable row level security;

-- Carry over anything already set via the single-FK column (migration
-- 0059) before dropping it -- no-op today (0060 never populated it) but
-- safe either way.
insert into inventory_compatible_trays (inventory_item_id, tray_sku_code_id)
select id, compatible_tray_sku_code_id from inventory_items
where compatible_tray_sku_code_id is not null
on conflict (inventory_item_id, tray_sku_code_id) do nothing;

alter table inventory_items drop column if exists compatible_tray_sku_code_id;

-- The tray SKUs this compatibility mapping needs (3P/3D/7S/8P) already
-- exist for US Factory (migrations 0001/0002, "Existing rows are US
-- Factory" per migration 0048) -- but SKU Names master data is per unit
-- (0048), so Factory needs its own 'factory'-scoped rows, not a
-- cross-unit reference to those. Seeded here under product='factory',
-- same on-conflict-safe pattern as migration 0060; a no-op if Factory
-- already has its own matching codes from its own SKU Names screen.
insert into sku_codes (product, code, category, description) values
  ('factory', 'SKU-3P', 'tray', '3P China tray'),
  ('factory', 'SKU-3D', 'tray', '3D China tray'),
  ('factory', 'SKU-7S', 'tray', '7S China tray'),
  ('factory', 'SKU-8P', 'tray', '8P China tray')
on conflict (product, code) do nothing;

insert into sku_versions (sku_code_id, version)
select id, v from sku_codes, unnest(array['V1', 'V2']) as v
where product = 'factory' and code in ('SKU-3P', 'SKU-3D', 'SKU-7S', 'SKU-8P')
on conflict (sku_code_id, version) do nothing;

-- The two Polybag 1800*900mm SKUs (migration 0060) get their tray
-- compatibility: PD100 -> 3P & 3D, PD101 -> 7S & 8P.
insert into inventory_compatible_trays (inventory_item_id, tray_sku_code_id)
select ii.id, tray.id
from inventory_items ii
join sku_codes mat on mat.id = ii.sku_code_id and mat.product = 'factory'
join (values ('PD100', 'SKU-3P'), ('PD100', 'SKU-3D'), ('PD101', 'SKU-7S'), ('PD101', 'SKU-8P')) as pairing(material_sku_code, tray_code)
  on pairing.material_sku_code = mat.sku_code
join sku_codes tray on tray.product = 'factory' and tray.code = pairing.tray_code
where ii.product = 'factory'
on conflict (inventory_item_id, tray_sku_code_id) do nothing;
