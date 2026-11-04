-- 0113 -- Inventory: trays are counted in Pcs (number of trays); Goods Outward: FG pallets available per SKU. Run after 0112. Re-runnable.
--   1. Tray SKUs (Factory): UOM Pallets -> Pcs. Each stock entry now holds the number of trays (pallets x trays per pallet, as recorded at receipt);
--      the inventory.quantity of a tray item is therefore its tray count. Goods Receipt inward stores trays the same way from now on.
--      Entries that were received in pallets with no trays-per-pallet on record cannot be converted: they are listed, left as they are,
--      and need a one-off adjustment on the Inventory screen ("Adjust Inventory").
--   2. factory_fg_available(): per SKU, the FG pallets in stock (stored), the pallets other open Goods Outward requests still need,
--      and what is left to promise. Goods Outward uses it to show "Available" and to refuse over-requesting.

-- 1. trays in Pcs ------------------------------------------------------------------------------
update sku_codes set default_unit = 'Pcs'
 where product = 'factory' and category in ('tray', 'fnp_tray', 'lnp_tray', 'fgtray') and default_unit is distinct from 'Pcs';

create temp table _tray_unconverted as
  select s.id from inventory_sources s
    join inventory_items i on i.id = s.inventory_item_id
    join sku_codes c on c.id = i.sku_code_id
   where i.product = 'factory' and c.category in ('tray', 'fnp_tray', 'lnp_tray', 'fgtray')
     and s.unit is distinct from 'Pcs' and s.trays is null and s.trays_per_pallet is null and s.unit = 'Pallets' and s.quantity <> 0;

update inventory_sources s
   set quantity = coalesce(s.trays, s.quantity * s.trays_per_pallet, s.quantity), unit = 'Pcs',
       trays = coalesce(s.trays, s.quantity * s.trays_per_pallet, s.quantity), updated_at = now()
  from inventory_items i, sku_codes c
 where i.id = s.inventory_item_id and c.id = i.sku_code_id
   and i.product = 'factory' and c.category in ('tray', 'fnp_tray', 'lnp_tray', 'fgtray')
   and s.unit is distinct from 'Pcs'
   and s.id not in (select id from _tray_unconverted);

update inventory_items i set uom = 'Pcs'
  from sku_codes c
 where c.id = i.sku_code_id and i.product = 'factory' and c.category in ('tray', 'fnp_tray', 'lnp_tray', 'fgtray')
   and i.uom is distinct from 'Pcs'
   and not exists (select 1 from _tray_unconverted u join inventory_sources s on s.id = u.id where s.inventory_item_id = i.id);

select c.code as sku, s.quantity, s.unit, 'not converted: received in pallets with no trays per pallet on record' as note
  from _tray_unconverted u join inventory_sources s on s.id = u.id
  join inventory_items i on i.id = s.inventory_item_id join sku_codes c on c.id = i.sku_code_id;

create or replace function inventory_apply_receipt(_entry_id uuid, _delta numeric) returns void
  language plpgsql security definer set search_path = public
as $$
declare
  _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype; _item_id uuid; _country text;
  _tpp numeric; _trays numeric; _qty numeric; _unit text;
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
  _qty := _delta; _unit := _e.unit;

  -- Trays: received in pallets, stored as a count of trays (Pcs) when trays per pallet is known.
  if _e.unit = 'Pallets'
     and sku_family(coalesce(_e.category, (select category from sku_codes where id = _e.sku_code_id))) = 'tray' then
    _tpp := _e.qty_per_pallet;
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

-- 2. FG pallets available per SKU --------------------------------------------------------------
-- stored   = FG pallets sitting in storage (not picked, shipped or used)
-- reserved = pallets other open Goods Outward requests still need (required - already picked), skipping _exclude_shipment (the one being edited)
-- available = stored - reserved
create or replace function factory_fg_available(_exclude_shipment uuid default null)
  returns table (sku_code_id uuid, stored int, reserved int, available int)
  language sql stable security definer set search_path = public
as $$
  with st as (
    select p.sku_code_id, count(*)::int as n from pallets p
     where p.product = 'factory' and p.pallet_type = 'fg' and p.lifecycle_status = 'stored' and p.sku_code_id is not null
     group by p.sku_code_id),
  rs as (
    select r.sku_code_id, sum(greatest(r.pallets_required - coalesce(pk.n, 0), 0))::int as n
      from shipment_picking_requests r
      left join (select shipment_picking_request_id, count(*) as n from shipment_picking_picks group by 1) pk
             on pk.shipment_picking_request_id = r.id
     where r.product = 'factory' and r.status in ('pending', 'partial') and r.sku_code_id is not null
       and (_exclude_shipment is null or r.customer_shipment_id <> _exclude_shipment)
     group by r.sku_code_id)
  select s.sku_code_id, s.n, coalesce(rs.n, 0), greatest(s.n - coalesce(rs.n, 0), 0)
    from st s left join rs on rs.sku_code_id = s.sku_code_id
  union all
  select rs.sku_code_id, 0, rs.n, 0 from rs where not exists (select 1 from st where st.sku_code_id = rs.sku_code_id)
$$;
revoke all on function factory_fg_available(uuid) from public;
grant execute on function factory_fg_available(uuid) to authenticated;
