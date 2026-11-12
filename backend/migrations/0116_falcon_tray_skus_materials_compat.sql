-- 0116 -- Falcon master data: tray SKUs (with Trays per Pallet), the films/pads/other materials and their suppliers,
-- and which film and pad are compatible with which tray. Falcon only (product 'falcon'). Run after 0115. Re-runnable.
--
--   1. sku_compatible_materials: tray SKU <-> compatible film / pad SKU (many to many).
--   2. 7 tray SKUs with one version each: Trays/Sleeve, Sleeve/Combo, and Total trays/Combo stored as
--      "Total Pcs per Pallet" (a Combo is one pallet in Falcon, so this is the Trays per Pallet used for pallet maths).
--      Pad Type / Pad Color on the version are filled from the sheet (e.g. "100gm BG" -> type 100gm, colour BG).
--   3. 16 materials from the materials sheet as SKUs (UOM -> default unit), and their 11 suppliers as Vendors.
--   4. The compatible film and pad of each tray, linked from the tray sheet.
--
-- Existing Falcon SKUs are never overwritten: a SKU is matched on its SKU Code (spaces and case ignored) or its SKU Name,
-- and only blank fields are filled in. A summary of what was created / matched / skipped is printed at the end.
-- Things the sheets leave open are listed in the notices (see the end): the 200gm WH pad has no row on the materials sheet,
-- and two materials have no SKU Code.

-- 1. compatibility table -------------------------------------------------------------------------------
create table if not exists sku_compatible_materials (
  id uuid primary key default gen_random_uuid(),
  tray_sku_code_id uuid not null references sku_codes(id) on delete cascade,
  material_sku_code_id uuid not null references sku_codes(id) on delete cascade,
  unique (tray_sku_code_id, material_sku_code_id)
);
create index if not exists idx_sku_compatible_materials_tray on sku_compatible_materials (tray_sku_code_id);
create index if not exists idx_sku_compatible_materials_material on sku_compatible_materials (material_sku_code_id);
alter table sku_compatible_materials enable row level security;
grant select, insert, update, delete on sku_compatible_materials to authenticated;

drop policy if exists sku_compatible_materials_read on sku_compatible_materials;
create policy sku_compatible_materials_read on sku_compatible_materials for select to authenticated
  using (exists (select 1 from sku_codes s where s.id = sku_compatible_materials.tray_sku_code_id));
drop policy if exists sku_compatible_materials_write on sku_compatible_materials;
create policy sku_compatible_materials_write on sku_compatible_materials for all to authenticated
  using (exists (select 1 from sku_codes s where s.id = sku_compatible_materials.tray_sku_code_id)
         and app_can(case when app_request_product() = 'factory' then 'goods_receipt' else 'inward_vehicle_inspection' end, 'edit'))
  with check (exists (select 1 from sku_codes s where s.id = sku_compatible_materials.tray_sku_code_id)
         and app_can(case when app_request_product() = 'factory' then 'goods_receipt' else 'inward_vehicle_inspection' end, 'edit'));

-- 2. data ---------------------------------------------------------------------------------------------
do $$
declare
  _r record; _id uuid; _vid uuid; _n_new int := 0; _n_match int := 0; _n_ver int := 0; _n_ven int := 0; _n_link int := 0;
  _tray uuid; _mat uuid; _norm text;
begin
  -- ---- materials (name, sku_code, category, default_unit, description, vendor, vendor country, vendor category) ----
  for _r in
    select * from (values
      ('Padding Glue',      'PD154',            'glue',             'Units', null,                          'Super Bond Ahesive',                                  'IN', 'glue'),
      ('Pet Straps',        'PD162',            'packaging',        'Units', null,                          'Patel Straps PVT LTD',                                'IN', 'packaging'),
      ('Stretch Wrap',      'STF0001',          'packaging',        'Units', null,                          'Shree Balaji',                                        'IN', 'packaging'),
      ('Polybags 900mm',    'PD048',            'polybag',          'Pcs',   null,                          'Dhwani Polyprints Ltd',                               'IN', 'polybag'),
      ('Polybags 680mm',    'PEB002',           'polybag',          'Pcs',   null,                          'Dhwani Polyprints Ltd',                               'IN', 'polybag'),
      ('Corner Protectors', 'PD081',            'corner_protector', 'Pcs',   null,                          'Global Packaging',                                    'IN', 'corner_protector'),
      ('Brown Sheets',      'PD310',            'packaging',        'Kgs',   null,                          'Jay Raj Fine Paper',                                  'IN', 'packaging'),
      ('Alcohol Barrel',    'PD160',            'packaging',        'Units', null,                          'Jene Chemicals',                                      'IN', 'packaging'),
      ('150 micron Film',   'PD046',            'film',             'Rolls', '150 micron | PE/PA/EVOH/PA/PE', 'Green Packaging Material(Jiangyin) Co., Ltd',            'CN', 'film'),
      ('125 micron film',   'PD045',            'film',             'Rolls', '125 micron | PE/PA/EVOH/PA/PE', 'Green Packaging Material(Jiangyin) Co., Ltd',            'CN', 'film'),
      ('55 micron PP',      'PD391',            'film',             'Rolls', '55 micron PP',                 'Foshan City Double Will Import & Export Co., Ltd',    'CN', 'film'),
      ('40 micron PP',      'PD390',            'film',             'Rolls', '40 micron PP',                 'Foshan City Double Will Import & Export Co., Ltd',    'CN', 'film'),
      ('45 micron PE',      null,               'film',             'Rolls', '45 micron PE',                 'Foshan City Double Will Import & Export Co., Ltd',    'CN', 'film'),
      ('55 micron PE',      null,               'film',             'Rolls', '55 micron PE',                 'Foshan City Double Will Import & Export Co., Ltd',    'CN', 'film'),
      ('200 gm Pad BG',     'CIP160103200BG0',  'pad',              'Pcs',   null,                          'Shenzhen AbsorbDry Packaging Co.,ltd',                'CN', 'pad'),
      ('100 gm pad BG',     'CIP130090100BG0',  'pad',              'Pcs',   null,                          'Demi Co., Ltd.',                                      'CN', 'pad')
    ) as t(name, sku_code, category, unit, descr, vendor, country, vcat)
  loop
    insert into vendors (product, category, name, country, is_active)
      values ('falcon', _r.vcat, _r.vendor, _r.country, true)
      on conflict (product, category, name) do nothing;
    if found then _n_ven := _n_ven + 1; end if;

    select id into _id from sku_codes
      where product = 'falcon'
        and ((_r.sku_code is not null and upper(replace(coalesce(sku_code, ''), ' ', '')) = upper(replace(_r.sku_code, ' ', '')))
             or upper(btrim(code)) = upper(_r.name))
      order by is_active desc limit 1;
    if found then
      _n_match := _n_match + 1;
      update sku_codes set sku_code = coalesce(nullif(btrim(sku_code), ''), _r.sku_code),
                           description = coalesce(nullif(btrim(description), ''), _r.descr),
                           default_unit = coalesce(nullif(btrim(default_unit), ''), _r.unit)
        where id = _id;
    else
      insert into sku_codes (product, code, sku_code, category, description, default_unit, is_active)
        values ('falcon', _r.name, _r.sku_code, _r.category, _r.descr, _r.unit, true)
        returning id into _id;
      _n_new := _n_new + 1;
    end if;
    insert into sku_versions (sku_code_id, version) values (_id, 'V1') on conflict (sku_code_id, version) do nothing;
  end loop;

  -- ---- tray SKUs: name, sku_code, full name, version, trays/sleeve, sleeve/combo, total trays/combo, pad type, pad colour,
  --      film (SKU name), pad (SKU name) ----
  for _r in
    select * from (values
      ('#3 1.25"',    'CMM03125-BT',  'Cirkla Fiber MAP/VSP #3 Tray - 1.25" (Base Tray)',        'R10', '820',  '6', 4920,  null,    null, '125 micron film', null),
      ('#3 1.7"',     'CMM03170-BT',  'Cirkla Fiber MAP/VSP #3 Tray - 1.7" (Base Tray)',         'R11', '740',  '6', 4440,  '100gm', 'BG', '150 micron Film', '100 gm pad BG'),
      ('#3 2"',       'CMM03200',     'CMM03200 - Cirkla Fiber MAP/VSP #3 Tray - 2.0"',          'R10', '724',  '6', 4344,  '200gm', 'WH', '150 micron Film', null),
      ('#10 1.5"',    'CMM10150P-BT', 'Cirkla Fiber MAP/VSP #10 Tray - 1.5" Patty (Base Tray)',  'R10', '720',  '6', 4320,  null,    null, '150 micron Film', null),
      ('10 2"',       'CMM10200P-BT', 'Cirkla Fiber MAP/VSP #10 Tray - 2" Patty (Base Tray)',    'R10', '648',  '6', 3888,  null,    null, '150 micron Film', null),
      ('3P',          'CMP0003P-R',   'Cirkla Fiber OW Tray - 3P - (RM)',                        'R2',  '1120', '6', 6720,  '200gm', 'BG', '55 micron PP',    '200 gm Pad BG'),
      ('#3 1.7" VSP', 'SPL00001',     'Specialty VSP #3 Tray - 1.7"',                            'R11', '2000', '6', 12000, '100gm', 'BG', '125 micron film', '100 gm pad BG')
    ) as t(name, sku_code, descr, version, tps, spc, total, pad_type, pad_color, film, pad)
  loop
    select id into _id from sku_codes
      where product = 'falcon'
        and (upper(replace(coalesce(sku_code, ''), ' ', '')) = upper(replace(_r.sku_code, ' ', '')) or upper(btrim(code)) = upper(_r.name))
      order by is_active desc limit 1;
    if found then
      _n_match := _n_match + 1;
      update sku_codes set sku_code = coalesce(nullif(btrim(sku_code), ''), _r.sku_code),
                           description = coalesce(nullif(btrim(description), ''), _r.descr)
        where id = _id;
    else
      insert into sku_codes (product, code, sku_code, category, description, is_active)
        values ('falcon', _r.name, _r.sku_code, 'tray', _r.descr, true) returning id into _id;
      _n_new := _n_new + 1;
    end if;

    select id into _vid from sku_versions where sku_code_id = _id and version = _r.version;
    if not found then
      insert into sku_versions (sku_code_id, version) values (_id, _r.version) returning id into _vid;
      _n_ver := _n_ver + 1;
    end if;
    update sku_versions set
        prod_pcs_per_sleeve = coalesce(nullif(btrim(prod_pcs_per_sleeve), ''), _r.tps),
        prod_sleeve_per_case = coalesce(nullif(btrim(prod_sleeve_per_case), ''), _r.spc),
        prod_total_pcs_per_pallet = coalesce(prod_total_pcs_per_pallet, _r.total),
        prod_pad_type = coalesce(nullif(btrim(prod_pad_type), ''), _r.pad_type),
        prod_pad_color = coalesce(nullif(btrim(prod_pad_color), ''), _r.pad_color)
      where id = _vid;

    -- compatible film / pad
    for _mat in
      select s.id from sku_codes s
       where s.product = 'falcon' and s.category in ('film', 'pad') and upper(btrim(s.code)) in (upper(_r.film), upper(coalesce(_r.pad, '')))
    loop
      insert into sku_compatible_materials (tray_sku_code_id, material_sku_code_id) values (_id, _mat)
        on conflict (tray_sku_code_id, material_sku_code_id) do nothing;
      if found then _n_link := _n_link + 1; end if;
    end loop;
  end loop;

  raise notice 'Falcon master data: % SKUs created, % matched an existing SKU (blank fields filled), % tray versions created, % vendors created, % compatibility links created.',
    _n_new, _n_match, _n_ver, _n_ven, _n_link;
  raise notice 'Open: the sheets list a 200gm WH pad for "#3 2"" but the materials sheet has no 200gm WH pad, so no pad is linked to that tray (its Pad Type/Colour are set). 45 micron PE and 55 micron PE have no SKU Code on the sheet: add them in Setup -> SKUs when known.';
end $$;

-- 3. check: every Falcon tray from the sheet now has Trays per Pallet, and its film/pad links -------------------------
select c.code as tray, v.version, v.prod_pcs_per_sleeve as trays_per_sleeve, v.prod_sleeve_per_case as sleeves_per_combo, v.prod_total_pcs_per_pallet as trays_per_pallet,
       (select string_agg(m.code, ', ' order by m.code) from sku_compatible_materials l join sku_codes m on m.id = l.material_sku_code_id where l.tray_sku_code_id = c.id) as compatible_film_pad
  from sku_codes c join sku_versions v on v.sku_code_id = c.id
 where c.product = 'falcon' and c.sku_code in ('CMM03125-BT', 'CMM03170-BT', 'CMM03200', 'CMM10150P-BT', 'CMM10200P-BT', 'CMP0003P-R', 'SPL00001')
 order by c.code;
