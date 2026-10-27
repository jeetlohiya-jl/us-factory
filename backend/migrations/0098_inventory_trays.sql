-- 0098 -- Inventory shows trays as well as pallets for tray SKUs.
-- inventory_sources gains trays_per_pallet and trays (pallets x trays per pallet at receipt).
-- inventory_apply_receipt() fills them from the Goods Receipt entry's qty_per_pallet (migration 0095/0097,
-- editable at Inward) for tray-family lines; every other material is unchanged (null).
-- Existing tray sources are back-filled where the entry already has trays per pallet.
-- Additive and re-runnable. Run after 0097.

alter table inventory_sources add column if not exists trays_per_pallet numeric;
alter table inventory_sources add column if not exists trays numeric;

update inventory_sources s
   set trays_per_pallet = e.qty_per_pallet, trays = s.quantity * e.qty_per_pallet
  from goods_receipt_entries e
 where s.source_goods_receipt_entry_id = e.id and e.qty_per_pallet is not null
   and s.trays is null and s.unit = 'Pallets';

create or replace function inventory_apply_receipt(_entry_id uuid, _delta numeric) returns void
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _item_id uuid; _country text;
  _tpp numeric; _trays numeric;
begin
  if _delta is null or _delta = 0 then return; end if;
  select * into _e from goods_receipt_entries where id = _entry_id;
  if not found then return; end if;
  select * into _gr from goods_receipts where id = _e.goods_receipt_id;

  insert into inventory_items (product, sku_code_id, uom)
    values ('factory', _e.sku_code_id,
            coalesce((select nullif(btrim(default_unit), '') from sku_codes where id = _e.sku_code_id), _e.unit))
    on conflict (product, sku_code_id) do nothing;
  select id into _item_id from inventory_items where product = 'factory' and sku_code_id = _e.sku_code_id;

  _country := upper(coalesce(nullif(btrim((select country from vendors where id = _gr.vendor_id)), ''), 'US'));

  -- Trays: only tray-family lines received in pallets, and only when trays per pallet is known.
  if _e.unit = 'Pallets'
     and sku_family(coalesce(_e.category, (select category from sku_codes where id = _e.sku_code_id))) = 'tray' then
    _tpp := _e.qty_per_pallet;
    _trays := _delta * _tpp;
  end if;

  insert into inventory_sources (
    inventory_item_id, source_goods_receipt_entry_id, vendor_id, vendor_name, country_code, quantity, unit,
    trays_per_pallet, trays
  ) values (
    _item_id, _entry_id, _gr.vendor_id, _gr.vendor_name, _country, _delta, _e.unit, _tpp, _trays
  )
  on conflict (source_goods_receipt_entry_id) do update
    set quantity = inventory_sources.quantity + excluded.quantity,
        vendor_id = excluded.vendor_id, vendor_name = excluded.vendor_name,
        country_code = excluded.country_code, updated_at = now(),
        trays_per_pallet = coalesce(excluded.trays_per_pallet, inventory_sources.trays_per_pallet),
        trays = case when excluded.trays is null then inventory_sources.trays
                     else coalesce(inventory_sources.trays, 0) + excluded.trays end;
end;
$$;
revoke all on function inventory_apply_receipt(uuid, numeric) from public;
