-- India Factory: Inward QC built from the six inward QC reports, plus the
-- automatic Pending QC -> approved QC -> Pending RM QR chain for every
-- material that has a report.
--
-- Source of truth: RM Tray (CTPL/RMIQ/FRM/01), Soaker Pads (CTPL/SPIQ/FRM/01),
-- Polybag (CTPL/PIQ/FRM/01), RM Film (CTPL/FIQ/FRM/01), CFB
-- (CTPL/CFBIQ/FRM/01), Corner Protector (CTPL/SPIQ/FRM/01 as printed).
--
-- Design:
--  * The existing Soaker Pad / Polybag / CFB / Glue field definitions and
--    sampling tiers are NOT edited -- Gainesville's manual Inward QC keeps
--    using them exactly as before. The India forms are new "form keys" in the
--    same tables: rm_tray, in_pad, in_polybag, in_cfb, film, corner_protector.
--    (A Goods Receipt-linked QC picks its form key in the application:
--    tray -> rm_tray, pad/polybag/cfb -> in_<category>, film and
--    corner_protector -> themselves; LNP Tray and Glue keep what they had --
--    no report was supplied for them.)
--  * Field definitions gain the report's columns: description, tolerance,
--    defect type (Critical/Major/Minor), inspection method, acceptable limit,
--    a section ('attribute' | 'defect'), the field that drives the sampling
--    plan (lot_role) and where a pre-filled value comes from (auto_source).
--  * corner_protector becomes a Goods Receipt / SKU category.
--  * gr_ensure_qc now covers film and corner_protector, pre-fills the
--    identity fields from the Goods Receipt entry, and locks the entry row so
--    two concurrent callers can never create two QC records.
--
-- Additive and re-runnable. Run it BEFORE deploying the matching backend and
-- frontend.

alter table inward_qc_attribute_definitions
  add column if not exists description text,
  add column if not exists tolerance text,
  add column if not exists defect_type text,
  add column if not exists inspection_method text,
  add column if not exists acceptable_limit text,
  add column if not exists section text not null default 'attribute',
  add column if not exists lot_role text,       -- 'lot_qty' | 'qty_per_pallet'
  add column if not exists auto_source text;    -- see gr_ensure_qc

-- ---------------------------------------------------------------------------
-- Field definitions. (category = form key.) Re-runnable: wiped for these keys
-- only when no QC has stored a value against them yet; otherwise left alone.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from inward_qc_attribute_values v join inward_qc_attribute_definitions d on d.id = v.attribute_definition_id
             where d.category in ('rm_tray', 'in_pad', 'in_polybag', 'in_cfb', 'film', 'corner_protector')) then
    raise notice 'India QC forms already in use; leaving their field definitions as they are.';
    return;
  end if;
  delete from inward_qc_attribute_definitions where category in ('rm_tray', 'in_pad', 'in_polybag', 'in_cfb', 'film', 'corner_protector');

  insert into inward_qc_attribute_definitions
    (category, label, field_type, options_json, is_required, sort_order, description, tolerance, defect_type, inspection_method, acceptable_limit, section, lot_role, auto_source)
  values
  -- RM Tray ------------------------------------------------------------
  ('rm_tray', 'Weight (Set of 4)', 'number', null, true, 1, null, null, null, null, null, 'attribute', null, null),
  ('rm_tray', 'Denesting Pattern', 'text', null, true, 2, 'A-A-A-A (0° Rotation)', null, null, null, null, 'attribute', null, null),
  ('rm_tray', 'Finish', 'text', null, true, 3, 'Inside Smooth & Outside Mesh', null, null, null, null, 'attribute', null, null),
  ('rm_tray', 'Tray Color', 'text', null, true, 4, 'Natural / White', null, null, null, null, 'attribute', null, null),
  ('rm_tray', 'Quantity/Pallet', 'number', null, true, 5, null, null, null, null, null, 'attribute', 'qty_per_pallet', null),
  ('rm_tray', 'Total Pallet Received', 'number', null, true, 6, null, null, null, null, null, 'attribute', null, 'pallet_count'),
  ('rm_tray', 'Cracks / Damages', 'number', null, true, 10, null, null, 'Critical', null, 'As per standard', 'defect', null, null),
  ('rm_tray', 'Foreign Particle', 'number', null, true, 11, null, null, 'Critical', null, 'As per standard', 'defect', null, null),
  ('rm_tray', 'Metal burrs', 'number', null, true, 12, null, null, 'Critical', null, '1', 'defect', null, null),
  ('rm_tray', 'Uneven thickness', 'number', null, true, 13, null, null, 'Critical', null, '2', 'defect', null, null),
  ('rm_tray', 'Holes', 'number', null, true, 14, null, null, 'Critical', null, '1', 'defect', null, null),
  ('rm_tray', 'Color spot', 'number', null, true, 15, null, null, 'Major', null, 'As per standard', 'defect', null, null),
  ('rm_tray', 'Dust', 'number', null, true, 16, null, null, 'Major', null, 'As per standard', 'defect', null, null),
  ('rm_tray', 'Black spot', 'number', null, true, 17, null, null, 'Major', null, 'As per standard', 'defect', null, null),
  ('rm_tray', 'Water Mark', 'number', null, true, 18, null, null, 'Minor', null, 'As per standard', 'defect', null, null),
  ('rm_tray', 'To go for 100% inspection?', 'dropdown', '["Yes","No"]', false, 30, null, null, null, null, null, 'attribute', null, null),
  ('rm_tray', 'Counting/Pallet', 'text', null, false, 31, null, null, null, null, null, 'attribute', null, null),

  -- Soaker Pad ---------------------------------------------------------
  ('in_pad', 'Base Material', 'text', null, false, 1, 'As per specification', null, null, null, null, 'attribute', null, null),
  ('in_pad', 'Product Code', 'text', null, true, 2, 'As per specification', null, null, null, null, 'attribute', null, 'sku_code'),
  ('in_pad', 'Quantity Received', 'number', null, true, 3, 'As per PO', null, null, null, null, 'attribute', 'lot_qty', 'received_pcs'),
  ('in_pad', 'Appearance', 'text', null, true, 4, 'Clean/dust-free/No wrinkle/No damage', null, null, null, null, 'attribute', null, null),
  ('in_pad', 'Length mm (±2)', 'number', null, true, 5, 'As per specification', null, null, null, null, 'attribute', null, null),
  ('in_pad', 'Width mm (±2)', 'number', null, true, 6, 'As per specification', null, null, null, null, 'attribute', null, null),
  ('in_pad', 'Absorption Rate (With Normal Water) ml (±5)', 'number', null, false, 7, 'As per specification', '±5', 'Critical', null, null, 'attribute', null, null),
  ('in_pad', 'Absorption Rate (With 0.2% Saline Water) ml (±5)', 'number', null, true, 8, 'As per specification', '±5', 'Critical', null, null, 'attribute', null, null),
  ('in_pad', 'Color (Beige / White)', 'text', null, true, 9, 'As per specification', null, 'Major', null, null, 'attribute', null, null),
  ('in_pad', 'Weight, g', 'number', null, true, 10, 'As per specification', null, 'Major', null, null, 'attribute', null, null),

  -- Polybag ------------------------------------------------------------
  ('in_polybag', 'Product Name', 'text', null, true, 1, 'As per Specifications', null, null, null, null, 'attribute', null, 'sku_description'),
  ('in_polybag', 'Quantity Received', 'number', null, true, 2, 'As per PO', null, null, null, null, 'attribute', 'lot_qty', 'received_pcs'),
  ('in_polybag', 'Base Material', 'text', null, false, 3, 'As per Specifications', null, null, null, null, 'attribute', null, null),
  ('in_polybag', 'Length mm', 'number', null, true, 4, 'As per Specifications', null, null, null, null, 'attribute', null, null),
  ('in_polybag', 'Width mm', 'number', null, true, 5, 'As per Specifications', null, null, null, null, 'attribute', null, null),
  ('in_polybag', 'Width Side Gussets mm', 'number', null, true, 6, 'As per Specifications', null, null, null, null, 'attribute', null, null),
  ('in_polybag', 'Foreign Material/Dust', 'text', null, true, 7, null, null, 'Critical', 'Visual inspection', null, 'attribute', null, null),
  ('in_polybag', 'Bag Weight (Avg.)', 'number', null, true, 8, 'As per Specifications', null, 'Critical', null, null, 'attribute', null, null),
  ('in_polybag', 'Thickness Microns', 'number', null, true, 9, 'As per Specifications', null, 'Critical', null, null, 'attribute', null, null),
  ('in_polybag', 'Punch Holes (Units)', 'number', null, true, 10, 'As per Specifications', null, 'Minor', 'Visual inspection', null, 'attribute', null, null),
  ('in_polybag', 'Hole Dia. mm', 'number', null, true, 11, 'As per Specifications', null, 'Minor', null, null, 'attribute', null, null),
  ('in_polybag', 'Color', 'text', null, true, 12, 'As per Specifications', null, 'Minor', null, null, 'attribute', null, null),

  -- CFB ----------------------------------------------------------------
  ('in_cfb', 'Batch No', 'text', null, false, 1, null, null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Product Name', 'text', null, true, 2, null, null, null, null, null, 'attribute', null, 'sku_description'),
  ('in_cfb', 'Quantity Received', 'number', null, true, 3, 'As per PO', null, null, null, null, 'attribute', 'lot_qty', 'received_pcs'),
  ('in_cfb', 'No. Of Plies', 'dropdown', '["3 Ply","5 Ply","7 Ply"]', true, 4, '3 Ply / 5 Ply / 7 Ply', null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Length, mm', 'number', null, true, 5, null, '±2', null, null, null, 'attribute', null, null),
  ('in_cfb', 'Width, mm', 'number', null, true, 6, null, '±2', null, null, null, 'attribute', null, null),
  ('in_cfb', 'Height, mm', 'number', null, true, 7, null, '±2', null, null, null, 'attribute', null, null),
  ('in_cfb', 'GSM, gm/m2', 'number', null, true, 8, null, '±5', 'Critical', null, null, 'attribute', null, null),
  ('in_cfb', 'Weight, kg', 'number', null, true, 9, null, null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Flute Combination', 'text', null, true, 10, 'A/B/C', null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Box Type', 'text', null, true, 11, null, null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Artwork/printing', 'text', null, true, 12, 'As per Artwork', null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Color', 'text', null, true, 13, 'Brown / White', null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Moisture Content', 'number', null, true, 14, '<12%', null, 'Major', null, null, 'attribute', null, null),
  ('in_cfb', 'Side Joint Type', 'text', null, true, 15, 'Stapple/Gluing', null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Cutting Edge', 'text', null, true, 16, 'Smooth edge without burrs, crack width <8mm', null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Joint', 'text', null, true, 17, '>30mm', null, null, null, null, 'attribute', null, null),
  ('in_cfb', 'Flap Closing', 'text', null, true, 18, 'Gap or overlap <3mm', null, null, null, null, 'attribute', null, null),

  -- RM Film ------------------------------------------------------------
  ('film', 'No. of pallets', 'number', null, false, 1, null, null, null, null, null, 'attribute', null, 'pallet_count'),
  ('film', 'No. of rolls', 'number', null, true, 2, null, null, null, null, null, 'attribute', 'lot_qty', 'rolls'),
  ('film', 'Base Material', 'dropdown', '["High Barrier Liner","PP Liner"]', true, 3, 'High Barrier Liner / PP Liner', null, null, null, null, 'attribute', null, null),
  ('film', 'Thickness (Take avg of 10 readings)', 'number', null, true, 4, '125 / 150 / 40 / 50 / 55 µ', 'Min -5', 'Critical', null, null, 'attribute', null, null),
  ('film', 'Weight of Roll (kg)', 'number', null, true, 5, null, null, 'Critical', null, null, 'attribute', null, null),
  ('film', 'Roll Width', 'number', null, true, 6, '1080 mm', 'Min -5', 'Major', null, null, 'attribute', null, null),
  ('film', 'Core Dia.', 'number', null, true, 7, '3 Inch (76 mm)', 'Min -5', 'Major', null, null, 'attribute', null, null),
  ('film', 'Color', 'text', null, true, 8, 'Transparent', null, 'Major', null, null, 'attribute', null, null),
  ('film', 'Accept / Reject', 'dropdown', '["Accept","Reject"]', true, 9, null, null, null, null, null, 'attribute', null, null),
  ('film', 'Suggestions', 'text', null, false, 10, null, null, null, null, null, 'attribute', null, null),

  -- Corner Protector ---------------------------------------------------
  ('corner_protector', 'Base Material', 'text', null, true, 1, 'As per specification', null, null, null, null, 'attribute', null, null),
  ('corner_protector', 'Quantity Received', 'number', null, true, 2, 'As per PO', null, null, null, null, 'attribute', 'lot_qty', 'received_pcs'),
  ('corner_protector', 'Length mm (±2)', 'number', null, true, 3, '100 mm', null, null, null, null, 'attribute', null, null),
  ('corner_protector', 'Thickness', 'number', null, true, 4, '4 mm', null, null, null, null, 'attribute', null, null),
  ('corner_protector', 'Color (Beige / White)', 'text', null, true, 5, 'As per specification', null, null, null, null, 'attribute', null, null);
end $$;

-- ---------------------------------------------------------------------------
-- Sampling plans, exactly as printed on each report. Reference data; the plan
-- actually applied is snapshotted onto the QC at submit time. A lot size that
-- falls in no tier has NO plan (the form says so) -- nothing is guessed.
-- ---------------------------------------------------------------------------
delete from inward_qc_sampling_plan_tiers where category in ('rm_tray', 'in_pad', 'in_polybag', 'in_cfb', 'film', 'corner_protector');
insert into inward_qc_sampling_plan_tiers (category, qty_label, min_qty, max_qty, sample_size, upper_limit, note, sort_order) values
  ('rm_tray', 'Total pcs in container', 0, 149999, 200, 6, null, 1),
  ('rm_tray', 'Total pcs in container', 150000, 500000, 315, 8, null, 2),

  ('in_pad', 'Total pcs in container', 0, 149999, 200, 2, '32 samples for testing', 1),
  ('in_pad', 'Total pcs in container', 150000, 500000, 315, 2, '50 samples for testing', 2),
  ('in_pad', 'Total pcs in container', 500001, null, 500, 2, '80 samples for testing', 3),

  ('corner_protector', 'Total pcs in container', 0, 149999, 200, 2, '32 samples for testing', 1),
  ('corner_protector', 'Total pcs in container', 150000, 500000, 315, 2, '50 samples for testing', 2),
  ('corner_protector', 'Total pcs in container', 500001, null, 500, 2, '80 samples for testing', 3),

  ('in_polybag', 'Lot size (pcs)', 35000, 150000, 500, 22, null, 1),
  ('in_polybag', 'Lot size (pcs)', 150001, 500000, 800, 22, null, 2),
  ('in_polybag', 'Lot size (pcs)', 500001, null, 1250, 22, null, 3),

  -- CFB: the report gives no upper limit for acceptance (left null).
  ('in_cfb', 'Lot size (pcs)', 151, 280, 32, null, null, 1),
  ('in_cfb', 'Lot size (pcs)', 281, 500, 50, null, null, 2),
  ('in_cfb', 'Lot size (pcs)', 501, 1200, 80, null, null, 3),
  ('in_cfb', 'Lot size (pcs)', 1201, 3200, 125, null, null, 4),
  ('in_cfb', 'Lot size (pcs)', 3201, 10000, 200, null, null, 5),

  -- Film: "below 90" and "91 to 280" as printed (a lot of exactly 90.x rolls is moot: rolls are whole).
  ('film', 'Total rolls', 1, 90, 8, 1, null, 1),
  ('film', 'Total rolls', 91, 280, 13, 1, null, 2);

-- ---------------------------------------------------------------------------
-- corner_protector as a Goods Receipt / SKU category.
-- ---------------------------------------------------------------------------
create or replace function sku_family_label(_category text) returns text
  language sql immutable as $$
  select case sku_family(_category)
    when 'tray' then 'Tray' when 'film' then 'Film' when 'pad' then 'Soaker Pad'
    when 'polybag' then 'Polybag' when 'cfb' then 'CFB' when 'glue' then 'Glue'
    when 'corner_protector' then 'Corner Protector' else _category end
$$;

-- goods_receipt_save: migration 0082's body, with corner_protector accepted.
create or replace function goods_receipt_save(_id uuid, _payload jsonb) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _po text := upper(btrim(coalesce(_payload->>'po_number', '')));
  _ecat text;
  _vendor_id uuid := nullif(_payload->>'vendor_id', '')::uuid;
  _as_draft boolean := coalesce((_payload->>'as_draft')::boolean, false);
  _entries jsonb := coalesce(_payload->'entries', '[]'::jsonb);
  _vendor vendors%rowtype;
  _gr goods_receipts%rowtype;
  _any_inwarded boolean := false;
  _e jsonb; _i int := 0; _label text; _name text;
  _sku sku_codes%rowtype; _ver_id uuid; _ver_label text;
  _qty numeric; _unit text; _eid uuid; _row goods_receipt_entries%rowtype;
  _keys text[] := '{}'; _key text; _constraint text;
begin
  if _id is null then
    if not app_can('goods_receipt', 'create') then
      raise exception using errcode = '42501', message = 'You do not have permission to create Goods Receipts.';
    end if;
  else
    if not app_can('goods_receipt', 'edit') then
      raise exception using errcode = '42501', message = 'You do not have permission to edit Goods Receipts.';
    end if;
    select * into _gr from goods_receipts where id = _id for update;
    if not found then raise exception using errcode = 'P0002', message = 'Goods Receipt not found'; end if;
    _any_inwarded := exists (select 1 from goods_receipt_entries where goods_receipt_id = _id and status = 'inwarded');
    select coalesce(array_agg(upper(btrim(shipment_number)) || '|' || sku_code_id || '|' || coalesce(sku_version_id::text, '')), '{}')
      into _keys from goods_receipt_entries where goods_receipt_id = _id and status = 'inwarded';
  end if;

  if _po = '' then raise exception 'PO Number is required.'; end if;
  select * into _vendor from vendors where id = _vendor_id and product = app_request_product();
  if not found then raise exception 'Select a valid Vendor.'; end if;
  if not _as_draft and jsonb_array_length(_entries) = 0 then
    raise exception 'Add at least one container before saving.';
  end if;
  if _any_inwarded then
    if _po <> _gr.po_number or _vendor.name is distinct from _gr.vendor_name then
      raise exception using errcode = '23503', message = 'PO Number and Vendor can''t be changed once a container has been inwarded.';
    end if;
    if _as_draft then
      raise exception using errcode = '23503', message = 'A Goods Receipt with inwarded containers can''t go back to Draft.';
    end if;
  end if;

  -- Validate every entry before writing anything.
  for _e in select * from jsonb_array_elements(_entries) loop
    _i := _i + 1;
    _eid := nullif(_e->>'id', '')::uuid;
    if _eid is not null then
      select * into _row from goods_receipt_entries where id = _eid and goods_receipt_id = _id;
      if not found then raise exception 'An entry in this request doesn''t belong to this Goods Receipt.'; end if;
      if _row.status = 'inwarded' then continue; end if;
    end if;
    _name := upper(btrim(coalesce(_e->>'shipment_number', '')));
    _label := case when _name = '' then 'Row ' || _i else _name end;
    if _name = '' then raise exception '%: Shipment Number is required.', _label; end if;
    select * into _sku from sku_codes where id = nullif(_e->>'sku_code_id', '')::uuid and product = app_request_product();
    if not found then raise exception '%: select a valid SKU.', _label; end if;
    -- Category per container: a PO can mix materials. Only a Tray SKU
    -- needs its stage chosen (Base Tray / LNP Tray); every other SKU's
    -- material IS its category.
    _ecat := nullif(btrim(coalesce(_e->>'category', '')), '');
    if sku_family(_sku.category) <> 'tray' then _ecat := _sku.category; end if;
    -- A tray row's stage may be left blank (e.g. synced from Zoho): it is
    -- chosen when the container is inwarded (goods_receipt_inward).
    if _ecat is not null and _ecat not in ('tray', 'fnp_tray', 'lnp_tray', 'film', 'pad', 'polybag', 'cfb', 'glue', 'corner_protector') then
      raise exception '%: unknown category ''%''.', _label, _ecat;
    end if;
    if _ecat is not null and sku_family(_sku.category) <> sku_family(_ecat) then
      raise exception '%: SKU % is not a % SKU.', _label, _sku.code, sku_family_label(_ecat);
    end if;
    _ver_id := nullif(_e->>'sku_version_id', '')::uuid;
    if _ver_id is not null then
      if not exists (select 1 from sku_versions where id = _ver_id and sku_code_id = _sku.id) then
        raise exception '%: the SKU Version doesn''t belong to %.', _label, _sku.code;
      end if;
    elsif not _as_draft and exists (select 1 from sku_versions where sku_code_id = _sku.id and is_active) then
      raise exception '%: select a SKU Version for %.', _label, _sku.code;
    end if;
    _qty := nullif(_e->>'po_quantity', '')::numeric;
    if _qty is null or _qty <= 0 then raise exception '%: PO Quantity must be greater than 0.', _label; end if;
    _unit := coalesce(_e->>'unit', 'Units');
    if _unit not in ('Pallets', 'Kgs', 'Units', 'Bags', 'Rolls', 'Pairs', 'Sets', 'Pcs') then
      raise exception '%: unknown unit ''%''.', _label, _unit;
    end if;
    _key := _name || '|' || _sku.id || '|' || coalesce(_ver_id::text, '');
    if _key = any(_keys) then raise exception '% with SKU % is listed more than once.', _label, _sku.code; end if;
    _keys := _keys || _key;
  end loop;

  if _id is null then
    insert into goods_receipts (product, po_number, vendor_id, vendor_name, status, created_by)
      values (app_request_product(), _po, _vendor.id, _vendor.name, 'draft', app_user_id())
      returning * into _gr;
  else
    update goods_receipts set po_number = _po, vendor_id = _vendor.id,
      vendor_name = _vendor.name, updated_at = now()
      where id = _id;
    -- Drop removed pending entries first, so a re-used shipment+SKU on
    -- another row can't trip the unique index mid-save.
    delete from goods_receipt_entries
      where goods_receipt_id = _id and status <> 'inwarded'
        and id not in (
          select nullif(x->>'id', '')::uuid from jsonb_array_elements(_entries) x where nullif(x->>'id', '') is not null
        );
  end if;

  _i := 0;
  for _e in select * from jsonb_array_elements(_entries) loop
    _eid := nullif(_e->>'id', '')::uuid;
    _ver_id := nullif(_e->>'sku_version_id', '')::uuid;
    if _eid is not null and exists (select 1 from goods_receipt_entries where id = _eid and status = 'inwarded') then
      update goods_receipt_entries set sort_order = _i where id = _eid;
    else
      select * into _sku from sku_codes where id = (_e->>'sku_code_id')::uuid;
      select version into _ver_label from sku_versions where id = _ver_id;
      _ecat := case when sku_family(_sku.category) = 'tray' then nullif(btrim(coalesce(_e->>'category', '')), '') else _sku.category end;
      if _eid is not null then
        update goods_receipt_entries set
          shipment_number = upper(btrim(_e->>'shipment_number')),
          category = _ecat, sku_code_id = _sku.id, sku_version_id = _ver_id,
          sku_code_snapshot = _sku.code, sku_version_snapshot = case when _ver_id is null then null else _ver_label end,
          po_quantity = (_e->>'po_quantity')::numeric, unit = coalesce(_e->>'unit', 'Units'), sort_order = _i
        where id = _eid;
      else
        insert into goods_receipt_entries (
          goods_receipt_id, shipment_number, category, sku_code_id, sku_version_id,
          sku_code_snapshot, sku_version_snapshot, po_quantity, unit, sort_order, status
        ) values (
          _gr.id, upper(btrim(_e->>'shipment_number')), _ecat,
          _sku.id, _ver_id, _sku.code, case when _ver_id is null then null else _ver_label end,
          (_e->>'po_quantity')::numeric, coalesce(_e->>'unit', 'Units'), _i, 'pending'
        );
      end if;
    end if;
    _i := _i + 1;
  end loop;

  perform gr_recompute_status(_gr.id, _as_draft);
  return gr_detail_json(_gr.id);
exception when unique_violation then
  get stacked diagnostics _constraint = constraint_name;
  if _constraint = 'uq_goods_receipts_po_number' then
    raise exception using errcode = '23505', message = 'A Goods Receipt for this PO Number already exists. Open it from the dashboard instead.';
  elsif _constraint in ('uq_goods_receipt_entries_shipment_sku', 'uq_goods_receipt_entries_container_sku') then
    raise exception using errcode = '23505', message = 'The same Shipment Number and SKU is listed more than once.';
  end if;
  raise;
end;
$$;
revoke all on function goods_receipt_save(uuid, jsonb) from public;
grant execute on function goods_receipt_save(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- gr_ensure_qc: now also film and corner_protector; pre-fills the identity
-- fields; serialises on the entry row (idempotent AND concurrency-safe).
-- ---------------------------------------------------------------------------
create or replace function gr_ensure_qc(_entry_id uuid) returns uuid
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _qid uuid; _cat text; _tray boolean;
  _vi uuid; _label text; _qty numeric; _unit text; _ver_label text; _fk text; _desc text;
begin
  -- Lock the entry: a second concurrent caller waits here, then finds the
  -- record the first one created.
  select * into _e from goods_receipt_entries where id = _entry_id for update;
  if not found or _e.status <> 'inwarded' then return null; end if;

  select id into _qid from inward_qc_records where source_goods_receipt_entry_id = _entry_id;
  if found then return _qid; end if;

  _cat := case when _e.category = 'fnp_tray' then 'lnp_tray' else _e.category end;
  -- A Corner Protector SKU synced from Zoho arrives under the catch-all
  -- 'packaging' category; recognise it by its name.
  if _cat = 'packaging' and exists (
       select 1 from sku_codes s where s.id = _e.sku_code_id
         and (coalesce(s.code, '') || ' ' || coalesce(s.description, '') || ' ' || coalesce(_e.sku_code_snapshot, '')) ilike '%corner protector%'
     ) then
    _cat := 'corner_protector';
  end if;
  if _cat is null or _cat not in ('tray', 'lnp_tray', 'pad', 'polybag', 'cfb', 'glue', 'film', 'corner_protector') then
    return null;
  end if;
  _tray := sku_family(_cat) = 'tray';
  select * into _gr from goods_receipts where id = _e.goods_receipt_id;

  -- Which field definitions this QC uses (mirrors form_key() in the app).
  _fk := case when _cat = 'tray' then 'rm_tray'
              when _cat in ('pad', 'polybag', 'cfb') then 'in_' || _cat
              else _cat end;

  select id into _vi from inward_vehicle_inspections
    where source_goods_receipt_entry_id = _entry_id and status = 'approved'
    order by created_at desc limit 1;
  if _vi is not null and exists (select 1 from inward_qc_records where linked_vehicle_inspection_id = _vi) then
    _vi := null;
  end if;

  if _tray then
    _qty := _e.pallet_count; _unit := 'Pallets'; _label := 'No. of Pallets';
  else
    _qty := _e.received_quantity; _unit := _e.unit;
    select qty_label into _label from inward_qc_sampling_plan_tiers where category = _fk order by sort_order limit 1;
    if _label is null then
      select qty_label into _label from inward_qc_sampling_plan_tiers where category = _cat order by sort_order limit 1;
    end if;
    _label := coalesce(_label, 'Quantity');
  end if;
  select version into _ver_label from sku_versions where id = _e.sku_version_id;

  insert into inward_qc_records (
    shipment_number, is_auto_shipment_number, category, status, linked_vehicle_inspection_id,
    vendor_name, vendor_id, quantity, quantity_label, quantity_unit,
    sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
    source_goods_receipt_entry_id, created_by, updated_by
  ) values (
    _e.shipment_number, coalesce(_e.shipment_number, '') like 'AUTO-%', _cat, 'pending', _vi,
    _gr.vendor_name, _gr.vendor_id, _qty, _label, _unit,
    _e.sku_code_id, _e.sku_version_id, _e.sku_code_snapshot, _e.sku_version_snapshot,
    _e.id, app_user_id(), app_user_id()
  ) returning id into _qid;

  if _tray then
    insert into inward_qc_line_item_snapshots (
      inward_qc_id, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot, quantity, sort_order
    ) values (_qid, _e.sku_code_id, _e.sku_version_id, _e.sku_code_snapshot, _ver_label, _e.pallet_count, 0);
  end if;

  -- Pre-fill what the Goods Receipt already knows. Identity / quantity fields
  -- only -- never a measurement. A quantity is pre-filled only when it is in
  -- the unit the report's sampling plan counts (pieces / rolls), so the lot
  -- size is never silently wrong.
  select coalesce(nullif(btrim(description), ''), _e.sku_code_snapshot) into _desc from sku_codes where id = _e.sku_code_id;
  insert into inward_qc_attribute_values (inward_qc_id, attribute_definition_id, value)
  select _qid, d.id, v.val
  from inward_qc_attribute_definitions d
  cross join lateral (select case d.auto_source
      when 'sku_code' then _e.sku_code_snapshot
      when 'sku_description' then _desc
      when 'pallet_count' then _e.pallet_count::text
      when 'received_pcs' then case when _e.unit in ('Pcs', 'Units', 'Bags', 'Sets', 'Pairs') then trim_scale(_e.received_quantity)::text end
      when 'rolls' then case when _e.unit = 'Rolls' then trim_scale(_e.received_quantity)::text end
    end as val) v
  where d.category = _fk and d.is_active and d.auto_source is not null and v.val is not null
  on conflict (inward_qc_id, attribute_definition_id) do nothing;
  return _qid;
end;
$$;
revoke all on function gr_ensure_qc(uuid) from public;
revoke all on function gr_ensure_qc(uuid) from authenticated;
