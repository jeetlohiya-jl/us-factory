-- 0107: store everything on the floor automatically (Gainesville Factory, for now).
-- RM pallets are stored at the active location whose zone is FLOOR-RM as soon as their
-- QRs are generated; FG pallets at the active FLOOR-FG location as soon as "Generate FG QRs"
-- is pressed in a Shift Record. If no such location exists nothing happens (pallets stay as before).
-- To switch this off later: drop trigger trg_floor_store_rm on qr_generation_records;
--                           drop trigger trg_floor_store_fg on shift_records;

create or replace function floor_auto_store_batch(_batch uuid, _type text) returns int
  language plpgsql security definer set search_path = public
as $$
declare
  _loc uuid; _locname text; _n int := 0; _p record; _actor uuid := app_user_id();
begin
  if _batch is null then return 0; end if;
  select id, display_id into _loc, _locname from locations
   where product = 'factory' and is_active
     and upper(zone) = case when _type = 'rm' then 'FLOOR-RM' else 'FLOOR-FG' end
   order by created_at limit 1;
  if _loc is null then return 0; end if;
  for _p in
    select p.* from pallets p
     where p.source_qr_generation_id = _batch and p.product = 'factory' and p.pallet_type = _type
       and p.lifecycle_status = case when _type = 'rm' then 'pending_storage' else 'generated' end
       and not exists (select 1 from storage_records r where r.pallet_id = p.id)
  loop
    insert into storage_records (product, storage_type, pallet_id, location_id, source_qr_generation_id,
                                 source_goods_receipt_entry_id, stored_by)
      values ('factory', _type, _p.id, _loc, _p.source_qr_generation_id, _p.source_goods_receipt_entry_id, _actor);
    update pallets set lifecycle_status = 'stored', current_location_id = _loc, updated_at = now() where id = _p.id;
    insert into pallet_lifecycle_events (pallet_id, stage, metadata, actor_user_id, occurred_at)
      values (_p.id, 'stored', jsonb_build_object('location', _locname, 'auto', 'floor'), _actor, now() + interval '2 microseconds');
    _n := _n + 1;
  end loop;
  return _n;
end;
$$;
revoke all on function floor_auto_store_batch(uuid, text) from public;

create or replace function trg_floor_store_rm_fn() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if new.qr_type = 'rm' and new.product = 'factory' and new.status = 'generated' then
    perform floor_auto_store_batch(new.id, 'rm');
  end if;
  return null;
end;
$$;
drop trigger if exists trg_floor_store_rm on qr_generation_records;
create trigger trg_floor_store_rm after update of status on qr_generation_records
  for each row execute function trg_floor_store_rm_fn();

create or replace function trg_floor_store_fg_fn() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if new.product = 'factory' and new.fg_generated_at is not null and new.qr_generation_id is not null then
    perform floor_auto_store_batch(new.qr_generation_id, 'fg');
  end if;
  return null;
end;
$$;
drop trigger if exists trg_floor_store_fg on shift_records;
create trigger trg_floor_store_fg after update of fg_generated_at on shift_records
  for each row execute function trg_floor_store_fg_fn();
