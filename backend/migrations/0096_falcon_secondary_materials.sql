-- 0096 -- Falcon: add the 8 secondary-material SKUs and their 7 suppliers.
--
-- sku_codes.code      = the SKU name (what people see)
-- sku_codes.sku_code  = the SKU Code from Zoho (what the PO sync matches on)
-- default_unit        = the unit Goods Receipt uses when the PO's unit is not specific
--                       (sheet UOM: Nos -> Units, Pcs -> Pcs, kg -> Kgs)
-- Categories: glue / polybag / corner_protector have their own category (and QC form);
-- the rest go under "packaging" (change in Setup -> SKUs if you want another).
-- Suppliers are created in the same category as their SKU. Safe to re-run.

insert into sku_codes (product, code, sku_code, category, default_unit, is_active) values
  ('falcon', 'Padding Glue',       'PD154',   'glue',             'Units', true),
  ('falcon', 'Pet Straps',         'PD162',   'packaging',        'Units', true),
  ('falcon', 'Stretch Wrap',       'STF0001', 'packaging',        'Units', true),
  ('falcon', 'Polybags 900mm',     'PD048',   'polybag',          'Pcs',   true),
  ('falcon', 'Polybags 680mm',     'PEB002',  'polybag',          'Pcs',   true),
  ('falcon', 'Corner Protectors',  'PD081',   'corner_protector', 'Pcs',   true),
  ('falcon', 'Brown Sheets',       'PD310',   'packaging',        'Kgs',   true),
  ('falcon', 'Alcohol Barrel',     'PD160',   'packaging',        'Units', true)
on conflict (product, code) do update
  set sku_code = excluded.sku_code, category = excluded.category,
      default_unit = excluded.default_unit, is_active = true;

insert into vendors (product, category, name, country, is_active) values
  ('falcon', 'glue',             'Super Bond Ahesive',  'IN', true),
  ('falcon', 'packaging',        'Patel Straps',        'IN', true),
  ('falcon', 'packaging',        'Shree Balaji',        'IN', true),
  ('falcon', 'polybag',          'Dhwani',              'IN', true),
  ('falcon', 'corner_protector', 'Global Packaging',    'IN', true),
  ('falcon', 'packaging',        'Jay Raj Fine Paper',  'IN', true),
  ('falcon', 'packaging',        'Jene Chemicals',      'IN', true)
on conflict (product, category, name) do update
  set country = excluded.country, is_active = true;

-- check
select 'sku' as kind, code as name, sku_code as code_or_country, category, default_unit as unit
  from sku_codes where product = 'falcon' and sku_code in ('PD154','PD162','STF0001','PD048','PEB002','PD081','PD310','PD160')
union all
select 'vendor', name, country, category, null from vendors
  where product = 'falcon' and name in ('Super Bond Ahesive','Patel Straps','Shree Balaji','Dhwani','Global Packaging','Jay Raj Fine Paper','Jene Chemicals')
order by 1 desc, 4, 2;
