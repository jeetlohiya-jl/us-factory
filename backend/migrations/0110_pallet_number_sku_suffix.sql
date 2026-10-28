-- 0110: new Factory pallet numbers (RM and FG) end with the SKU name, e.g. CN-PLT-2610-0387-3P, US-PLT-2610-0001-7S.
-- Done as a BEFORE INSERT trigger on pallets, so every way a Factory pallet gets created (Goods Receipt QR generation,
-- Shift Record "Generate FG QRs") picks it up without changing those functions. The QR payload's id is changed to match.
-- Existing pallets keep their numbers. Falcon is not affected. Re-runnable.
-- To switch off: drop trigger trg_pallet_sku_suffix on pallets;

create or replace function trg_pallet_sku_suffix_fn() returns trigger
  language plpgsql set search_path = public
as $$
declare _name text; _suffix text; _old text := new.display_id;
begin
  if new.product is distinct from 'factory' or new.pallet_type not in ('rm', 'fg') or new.sku_code_id is null then
    return new;
  end if;
  select code into _name from sku_codes where id = new.sku_code_id;
  _suffix := trim(both '-' from regexp_replace(upper(coalesce(_name, '')), '[^A-Z0-9]+', '-', 'g'));
  if _suffix = '' or _old like '%-' || _suffix then return new; end if;
  new.display_id := _old || '-' || _suffix;
  if new.qr_payload is not null then
    new.qr_payload := replace(new.qr_payload, '"' || _old || '"', '"' || new.display_id || '"');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pallet_sku_suffix on pallets;
create trigger trg_pallet_sku_suffix before insert on pallets
  for each row execute function trg_pallet_sku_suffix_fn();
