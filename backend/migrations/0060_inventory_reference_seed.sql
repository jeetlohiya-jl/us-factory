-- 2026-09-28 -- Seeds the Inventory reference data from the current
-- supplier/SKU sheet (2026-09-25 factory materials list): the 6 current
-- suppliers (as Vendors) and the 17 SKUs they supply (as SKU Codes),
-- plus one Inventory item per SKU so every material on the sheet already
-- has a row on the Inventory dashboard -- at zero quantity, since none of
-- this has actually been received yet. "Quantity Ordered" on the sheet is
-- a PO reference number, not stock on hand, so it is intentionally NOT
-- written here as a fabricated starting balance; real quantity only
-- ever arrives via an actual Goods Receipt inward (or a manual source
-- added on the Inventory screen itself, for stock that predates this).
--
-- Two rows on the sheet share the SKU name "Polybags 1800*900mm" (PD100
-- vs PD101) -- kept as two separate SKU Codes (sku_codes.code is unique),
-- disambiguated by the tray pairing the sheet lists them under.
--
-- Additive / idempotent, safe to re-run: every insert is on-conflict-safe
-- against the unique constraints already on these tables.

insert into vendors (product, category, name, country, is_active) values
  ('factory', 'packaging', 'TaiShan MIDA Eco-Friendly Product Co., Ltd', 'CN', true),
  ('factory', 'polybag', 'Miracle Well Pack', 'IN', true),
  ('factory', 'glue', 'Jowat Corporation', 'US', true),
  ('factory', 'glue', 'Biobond Adhesives', 'US', true),
  ('factory', 'pallet', 'Premier Pallets Inc', 'US', true),
  ('factory', 'ppe', 'Cirkla Technologies Private Limited', 'IN', true)
on conflict (product, category, name) do nothing;

insert into sku_codes (product, code, sku_code, category, is_active) values
  ('factory', 'PET Strap', 'PD077', 'packaging', true),
  ('factory', 'Stretch wrap', 'PD079', 'packaging', true),
  ('factory', 'Corner Protector', 'PD078', 'packaging', true),
  ('factory', 'Polybag 1300*900mm', 'PEB0001', 'polybag', true),
  -- Same SKU name on the sheet, two different SKU Codes/tray pairings --
  -- disambiguated here since sku_codes.code must be unique.
  ('factory', 'Polybags 1800*900mm (3P & 3D)', 'PD100', 'polybag', true),
  ('factory', 'Polybags 1800*900mm (7S & 8P)', 'PD101', 'polybag', true),
  ('factory', 'Padding glue (Jowat)', 'PD102', 'glue', true),
  ('factory', 'Padding glue (Biobond)', 'PD081', 'glue', true),
  ('factory', 'Pallets', 'PD098', 'pallet', true),
  ('factory', 'Combo boxes', 'PD099', 'cfb', true),
  ('factory', 'Shoe Cover', 'PD070', 'ppe', true),
  ('factory', 'Hairnets', 'PD225', 'ppe', true),
  ('factory', 'Face Mask', 'PD293', 'ppe', true),
  ('factory', 'Beard Mask', 'PD481', 'ppe', true),
  ('factory', 'Hand Gloves', 'PD147', 'ppe', true),
  ('factory', 'Disposable Apron', 'PD483', 'ppe', true),
  ('factory', 'Glue sticks', 'PD550', 'ppe', true)
on conflict (product, code) do nothing;

insert into sku_versions (sku_code_id, version)
select id, 'V1' from sku_codes
where product = 'factory' and sku_code in (
  'PD077', 'PD079', 'PD078', 'PEB0001', 'PD100', 'PD101', 'PD102', 'PD081',
  'PD098', 'PD099', 'PD070', 'PD225', 'PD293', 'PD481', 'PD147', 'PD483', 'PD550'
)
on conflict (sku_code_id, version) do nothing;

-- One Inventory item per SKU, UOM from the sheet -- quantity starts at
-- zero (derived from inventory_sources, see inventory_service.py) until
-- an actual Goods Receipt or manual source adds to it.
insert into inventory_items (product, sku_code_id, uom)
select 'factory', sc.id, v.uom
from sku_codes sc
join (values
  ('PD077', 'Rolls'), ('PD079', 'Rolls'), ('PD078', 'Pcs'), ('PEB0001', 'Pcs'),
  ('PD100', 'Pcs'), ('PD101', 'Pcs'), ('PD102', 'Kgs'), ('PD081', 'Kgs'),
  ('PD098', 'Pcs'), ('PD099', 'Pcs'), ('PD070', 'Pairs'), ('PD225', 'Pcs'),
  ('PD293', 'Pcs'), ('PD481', 'Pcs'), ('PD147', 'Pairs'), ('PD483', 'Pcs'), ('PD550', 'Pcs')
) as v(sku_code, uom) on v.sku_code = sc.sku_code
where sc.product = 'factory'
on conflict (product, sku_code_id) do nothing;
