-- 0097 -- Trays per Pallet and Trays per Container (40HQ) from the Zoho PO, editable at Inward.
--
-- Zoho tray lines carry "Trays/40HQ" and "Combo boxes/40HQ" (and "Trays/Combo Box").
--   trays per container = Trays/40HQ
--   trays per pallet    = Trays/40HQ / Combo boxes/40HQ  (falls back to Trays/Combo Box)
-- The Zoho sync stores both on the Goods Receipt entry (qty_per_pallet already exists,
-- migration 0095; trays_per_container is new). The Inward Inspection pre-fills both
-- fields from the entry; the operator can edit them and the edited values are stored on
-- the inspection (and written back to the entry, so the RM Tray Inward QC pre-fill
-- follows). Entries synced before this keep them blank until the PO is re-saved in Zoho.
-- Idempotent; only the sync function's text is patched (each patch is checked).

alter table goods_receipt_entries add column if not exists trays_per_container numeric;
alter table inward_vehicle_inspections add column if not exists trays_per_pallet numeric;
alter table inward_vehicle_inspections add column if not exists trays_per_container numeric;

create or replace function zoho_desc_number(_desc text, _label text) returns numeric
  language sql immutable as $$
  select nullif(regexp_replace(coalesce(zoho_desc_value(_desc, _label), ''), '[^0-9.]', '', 'g'), '')::numeric
$$;

create or replace function zoho_trays_per_container(_desc text) returns numeric
  language sql immutable as $$
  select nullif(zoho_desc_number(_desc, 'Trays/40HQ'), 0)
$$;

create or replace function zoho_trays_per_pallet(_desc text) returns numeric
  language sql immutable as $$
  select coalesce(
    round(zoho_desc_number(_desc, 'Trays/40HQ') / nullif(zoho_desc_number(_desc, 'Combo boxes/40HQ'), 0), 2),
    nullif(zoho_desc_number(_desc, 'Trays/Combo Box'), 0))
$$;

do $$
declare
  _def text;
  _new text;
  _pos int;
begin
  select pg_get_functiondef(p.oid) into _def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'zoho_upsert_purchase_order';
  if _def is null then raise exception 'zoho_upsert_purchase_order not found'; end if;
  if _def like '%trays_per_container%' then
    raise notice 'zoho_upsert_purchase_order already patched';
    return;
  end if;
  if _def not like '%qty_per_pallet%' then raise exception 'run 0095 first'; end if;

  -- per pallet: prefer Trays/40HQ / Combo boxes/40HQ, else Trays/Combo Box (_per_box)
  _new := regexp_replace(_def,
    'then\s+_per_box\s+end', 'then coalesce(zoho_trays_per_pallet(_desc), _per_box) end', 'g');
  if _new = _def then
    _pos := position('qty_per_pallet' in _def);
    raise exception 'per-pallet patch did not match. Live text near it: %', replace(replace(substr(_def, greatest(_pos - 250, 1), 600), E'\r', '<CR>'), E'\n', '<LF>');
  end if;
  _def := _new;

  -- update branch
  _new := regexp_replace(_def,
    '(qty_per_pallet\s*=\s*case\s+when\s+sku_family\(_sku\.category\)\s*=\s*''tray''\s+then\s+coalesce\(zoho_trays_per_pallet\(_desc\),\s*_per_box\)\s+end)',
    '\1, trays_per_container = case when sku_family(_sku.category) = ''tray'' then zoho_trays_per_container(_desc) end');
  if _new = _def then raise exception 'update patch did not match'; end if;
  _def := _new;

  -- insert column list
  _new := regexp_replace(_def, 'zoho_unit\s*,\s*qty_per_pallet(\s*)\)', 'zoho_unit, qty_per_pallet, trays_per_container\1)');
  if _new = _def then raise exception 'insert-columns patch did not match'; end if;
  _def := _new;

  -- insert values
  _new := regexp_replace(_def,
    '(case\s+when\s+sku_family\(_sku\.category\)\s*=\s*''tray''\s+then\s+coalesce\(zoho_trays_per_pallet\(_desc\),\s*_per_box\)\s+end)(\s*)\)\s*;',
    '\1, case when sku_family(_sku.category) = ''tray'' then zoho_trays_per_container(_desc) end\2);');
  if _new = _def then raise exception 'insert-values patch did not match'; end if;

  execute _new;
end $$;
