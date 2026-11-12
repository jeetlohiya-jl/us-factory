-- 0117 -- Falcon Inventory, in trays (like Factory). Run after 0116. Re-runnable.
--   * inventory_apply_receipt() now uses the unit (Factory / Falcon) of the Goods Receipt instead of always 'factory'. Factory behaves exactly as before.
--     Falcon tray SKUs are stocked in Pcs = number of trays (pallets x trays per pallet; trays per pallet from the receipt, else the SKU version's Trays per Pallet).
--   * A trigger on goods_receipt_inward_events adds each Falcon inward (first inward, and any later "remaining") to Inventory.
--     It is a trigger so the Goods Receipt inward functions themselves are not touched. Factory is excluded (its functions already call inventory_apply_receipt).
--   * One Inventory item per Falcon SKU, at 0 quantity (UOM Pcs for trays), so every material is there to count. NO stock is back-filled from containers
--     received before this migration: set each SKU's current stock with Update Stock on the Inventory screen.

create or replace function inventory_apply_receipt(_entry_id uuid, _delta numeric) returns void
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _item_id uuid; _country text;
  _tpp numeric; _trays numeric; _qty numeric; _unit text; _prod text; _uom text;
begin
  if _delta is null or _delta = 0 then return; end if;
  select * into _e from goods_receipt_entries where id = _entry_id;
  if not found then return; end if;
  select * into _gr from goods_receipts where id = _e.goods_receipt_id;
  _prod := coalesce(_gr.product, 'factory');

  -- Tray SKUs are stocked in Pcs (the number of trays) in Falcon, like Factory; every other material keeps its SKU unit.
  _uom := case when _prod = 'falcon' and sku_family(coalesce(_e.category, (select category from sku_codes where id = _e.sku_code_id))) = 'tray' then 'Pcs'
               else coalesce((select nullif(btrim(default_unit), '') from sku_codes where id = _e.sku_code_id), _e.unit) end;
  insert into inventory_items (product, sku_code_id, uom)
    values (_prod, _e.sku_code_id, _uom)
    on conflict (product, sku_code_id) do nothing;
  select id into _item_id from inventory_items where product = _prod and sku_code_id = _e.sku_code_id;

  _country := upper(coalesce(nullif(btrim((select country from vendors where id = _gr.vendor_id)), ''), 'US'));
  _qty := _delta; _unit := _e.unit;

  -- Trays: received in pallets, stored as a count of trays (Pcs) when trays per pallet is known.
  if _e.unit = 'Pallets'
     and sku_family(coalesce(_e.category, (select category from sku_codes where id = _e.sku_code_id))) = 'tray' then
    _tpp := _e.qty_per_pallet;
    -- Falcon: when the receipt did not record trays per pallet, use the SKU version's Trays per Pallet.
    if coalesce(_tpp, 0) <= 0 and _prod = 'falcon' then
      select v.prod_total_pcs_per_pallet into _tpp from sku_versions v where v.id = _e.sku_version_id;
    end if;
    if coalesce(_tpp, 0) > 0 then
      _trays := _delta * _tpp;
      _qty := _trays; _unit := 'Pcs';
    end if;
  end if;

  insert into inventory_sources (
    inventory_item_id, source_goods_receipt_entry_id, vendor_id, vendor_name, country_code, quantity, unit,
    trays_per_pallet, trays
  ) values (
    _item_id, _entry_id, _gr.vendor_id, _gr.vendor_name, _country, _qty, _unit, _tpp, _trays
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

create or replace function falcon_inventory_on_inward() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if (select gr.product from goods_receipt_entries e join goods_receipts gr on gr.id = e.goods_receipt_id where e.id = new.entry_id) = 'falcon' then
    perform inventory_apply_receipt(new.entry_id, new.received_quantity);
  end if;
  return new;
end;
$$;
revoke all on function falcon_inventory_on_inward() from public;

drop trigger if exists trg_falcon_inventory_on_inward on goods_receipt_inward_events;
create trigger trg_falcon_inventory_on_inward after insert on goods_receipt_inward_events
  for each row execute function falcon_inventory_on_inward();

-- one Inventory item per Falcon SKU (0 stock until a receipt or a count)
insert into inventory_items (product, sku_code_id, uom)
select 'falcon', c.id,
       case when sku_family(c.category) = 'tray' then 'Pcs' else coalesce(nullif(btrim(c.default_unit), ''), 'Units') end
  from sku_codes c
 where c.product = 'falcon' and c.is_active
on conflict (product, sku_code_id) do nothing;

-- Falcon tray items are counted in Pcs
update inventory_items i set uom = 'Pcs', updated_at = now()
  from sku_codes c
 where c.id = i.sku_code_id and i.product = 'falcon' and sku_family(c.category) = 'tray' and i.uom is distinct from 'Pcs';
