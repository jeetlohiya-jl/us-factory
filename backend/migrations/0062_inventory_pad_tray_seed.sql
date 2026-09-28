-- 2026-09-28 -- Seeds the 3 Soaker Pad SKUs (MG-201-CT, MG-440, MG-570)
-- from the pad/tray reference sheet, their tray compatibility (a pad can
-- pair with more than one tray, same as migration 0061's Polybag case --
-- MG-201-CT is listed under both the 3P and 3D tray columns), and their
-- Production Details reference attributes (weight, Pcs/Sleeve,
-- Sleeve/Case, Pad Type, Pad Colour, Case Type, Dimension, Absorption
-- Rate -- the existing sku_versions.prod_* columns, same "entered once
-- per SKU Version" reference data the SKU Names admin screen already
-- uses for Packing List/Production/IPQC).
--
-- The sheet's "Pcs/Case" row is not stored separately: with Sleeve/Case
-- = 1 for every column here it equals Pcs/Sleeve, and Total Combo x
-- Trays/Combo already derives Pcs/Case the same way everywhere else in
-- this app (see migration 0059's docstring, Packing List). "Total
-- Quantity" is likewise not loaded as stock on hand -- like "Quantity
-- Ordered" on the Polybag/etc. sheet (migration 0060), its meaning here
-- (a batch/season total, not a per-pallet or current-stock figure)
-- doesn't match anything Inventory tracks, so it's left out rather than
-- guessed at; Inventory quantity stays 0 for these SKUs until a real
-- Goods Receipt or manual source adds to it. "Target shots" was blank
-- on the sheet and is left null.
--
-- Additive / idempotent, safe to re-run.

insert into vendors (product, category, name, country, is_active) values
  ('factory', 'pad', 'McAirlaid''s Inc', 'US', true)
on conflict (product, category, name) do nothing;

insert into sku_codes (product, code, sku_code, category, is_active) values
  ('factory', 'Soaker Pad MG-201-CT', 'MG-201-CT', 'pad', true),
  ('factory', 'Soaker Pad MG-440', 'MG-440', 'pad', true),
  ('factory', 'Soaker Pad MG-570', 'MG-570', 'pad', true)
on conflict (product, code) do nothing;

insert into sku_versions (sku_code_id, version)
select id, 'V1' from sku_codes
where product = 'factory' and sku_code in ('MG-201-CT', 'MG-440', 'MG-570')
on conflict (sku_code_id, version) do nothing;

-- Production Details reference attributes, one row of facts per pad SKU.
update sku_versions sv set
  prod_weight = a.weight, prod_pcs_per_sleeve = a.pcs_per_sleeve, prod_sleeve_per_case = a.sleeve_per_case,
  prod_pad_type = a.pad_type, prod_pad_color = a.pad_color, prod_case_type = a.case_type,
  prod_dimensions = a.dimensions, prod_absorption_rate = a.absorption_rate
from (values
  ('MG-201-CT', '5.7', '1000', '1', 'PE both side', 'White', 'Corrugated box', '160*136', '200'),
  ('MG-440',    '10.7', '575', '1', 'PE both side', 'White', 'Corrugated box', '312*101', '440'),
  ('MG-570',    '15.13', '600', '1', 'PE both side', 'White', 'Corrugated box', '212*160', '570')
) as a(sku_code, weight, pcs_per_sleeve, sleeve_per_case, pad_type, pad_color, case_type, dimensions, absorption_rate)
where sv.sku_code_id = (select id from sku_codes where product = 'factory' and sku_code = a.sku_code)
  and sv.version = 'V1';

insert into inventory_items (product, sku_code_id, uom)
select 'factory', id, 'Pcs' from sku_codes
where product = 'factory' and sku_code in ('MG-201-CT', 'MG-440', 'MG-570')
on conflict (product, sku_code_id) do nothing;

-- Tray compatibility: MG-201-CT -> 3P & 3D, MG-440 -> 7S, MG-570 -> 8P.
insert into inventory_compatible_trays (inventory_item_id, tray_sku_code_id)
select ii.id, tray.id
from inventory_items ii
join sku_codes mat on mat.id = ii.sku_code_id and mat.product = 'factory'
join (values
  ('MG-201-CT', 'SKU-3P'), ('MG-201-CT', 'SKU-3D'),
  ('MG-440', 'SKU-7S'),
  ('MG-570', 'SKU-8P')
) as pairing(material_sku_code, tray_code) on pairing.material_sku_code = mat.sku_code
join sku_codes tray on tray.product = 'factory' and tray.code = pairing.tray_code
where ii.product = 'factory'
on conflict (inventory_item_id, tray_sku_code_id) do nothing;
