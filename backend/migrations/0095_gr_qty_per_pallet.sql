-- 0095 -- Pieces per pallet from the Zoho PO -> Goods Receipt entry -> RM Tray Inward QC.
--
-- Zoho tray lines carry the pallet size ("Trays/Combo Box", or "Pcs/Combo" for
-- Falcon). The sync used it only to turn the tray count into pallets and then
-- dropped it, so the RM Tray Inward QC's "Quantity/Pallet" was blank and the
-- sampling plan (Quantity/Pallet x pallets received) could not show a sample
-- size. Now:
--   1. goods_receipt_entries.qty_per_pallet keeps it (set by the Zoho sync),
--   2. gr_ensure_qc pre-fills the QC's Quantity/Pallet from it (still editable).
-- Entries synced before this keep it blank: re-save the PO in Zoho (or type it
-- in the QC) for those. Only the two functions' text is patched (and each
-- patch is checked); nothing else changes.

alter table goods_receipt_entries add column if not exists qty_per_pallet numeric;

update inward_qc_attribute_definitions
   set auto_source = 'qty_per_pallet'
 where category = 'rm_tray' and label = 'Quantity/Pallet' and auto_source is null;

do $$
declare
  _def text;
  _new text;
  _pos int;
begin
  -- 1. Zoho sync: remember the pallet size on the entry. Whitespace-tolerant
  -- (the stored function text may use Windows line endings).
  select pg_get_functiondef(p.oid) into _def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'zoho_upsert_purchase_order';
  if _def is null then raise exception 'zoho_upsert_purchase_order not found'; end if;
  if _def like '%qty_per_pallet%' then
    raise notice 'zoho_upsert_purchase_order already patched';
  else
    _new := regexp_replace(_def,
      'zoho_unit\s*=\s*_li->>''unit''\s*,\s*sort_order\s*=\s*_i(\s+)where\s+id\s*=\s*_row\.id\s*;',
      'zoho_unit = _li->>''unit'', sort_order = _i, qty_per_pallet = case when sku_family(_sku.category) = ''tray'' then _per_box end\1where id = _row.id;');
    if _new = _def then
      _pos := position('sort_order' in _def);
      raise exception 'update patch did not match in zoho_upsert_purchase_order. Live text near it: %', replace(replace(substr(_def, greatest(_pos - 250, 1), 600), E'\r', '<CR>'), E'\n', '<LF>');
    end if;
    _def := _new;
    _new := regexp_replace(_def,
      'zoho_quantity\s*,\s*zoho_unit(\s*)\)(\s*)values(\s*)\(',
      'zoho_quantity, zoho_unit, qty_per_pallet\1)\2values\3(');
    if _new = _def then
      _pos := position('zoho_quantity, zoho_unit' in _def);
      raise exception 'insert-columns patch did not match in zoho_upsert_purchase_order. Live text near it: %', replace(replace(substr(_def, greatest(_pos - 250, 1), 600), E'\r', '<CR>'), E'\n', '<LF>');
    end if;
    _def := _new;
    _new := regexp_replace(_def,
      '(_entry_qty\s*,\s*_li->>''unit'')(\s*)\)\s*;',
      '\1, case when sku_family(_sku.category) = ''tray'' then _per_box end\2);');
    if _new = _def then
      _pos := position('_entry_qty, _li' in _def);
      raise exception 'insert-values patch did not match in zoho_upsert_purchase_order. Live text near it: %', replace(replace(substr(_def, greatest(_pos - 250, 1), 600), E'\r', '<CR>'), E'\n', '<LF>');
    end if;
    execute _new;
  end if;

  -- 2. QC creation: pre-fill Quantity/Pallet
  select pg_get_functiondef(p.oid) into _def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'gr_ensure_qc';
  if _def is null then raise exception 'gr_ensure_qc not found'; end if;
  if _def like '%qty_per_pallet%' then
    raise notice 'gr_ensure_qc already patched';
  else
    _new := regexp_replace(_def,
      '(when\s+''pallet_count''\s+then\s+_e\.pallet_count::text)',
      '\1 when ''qty_per_pallet'' then trim_scale(_e.qty_per_pallet)::text');
    if _new = _def then
      _pos := position('pallet_count' in _def);
      raise exception 'patch did not match in gr_ensure_qc. Live text near it: %', replace(replace(substr(_def, greatest(_pos - 150, 1), 400), E'\r', '<CR>'), E'\n', '<LF>');
    end if;
    execute _new;
  end if;
end $$;
