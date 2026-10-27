-- 0099 -- Soaker Pad packing at Inward (Factory): No. of Pcs/Box and No. of Boxes/Pallet, compulsory.
--   * goods_receipt_entries.pcs_per_box / boxes_per_pallet (whole numbers).
--   * goods_receipt_set_pad_packing(entry, pcs_per_box, boxes_per_pallet): the Inward screens save the two
--     numbers with this just before the inward itself (works for the quick Inward form and the Inward
--     Inspection wizard, without touching the inward functions).
--   * Trigger: a Factory Soaker Pad container cannot become Inwarded until both numbers are filled in,
--     whichever screen or API call tries to inward it. Already-inwarded rows are not affected.
-- Additive and re-runnable.

alter table goods_receipt_entries add column if not exists pcs_per_box integer;
alter table goods_receipt_entries add column if not exists boxes_per_pallet integer;

create or replace function goods_receipt_set_pad_packing(_entry_id uuid, _pcs_per_box integer, _boxes_per_pallet integer)
  returns void
  language plpgsql security definer set search_path = public
as $$
declare _e goods_receipt_entries%rowtype; _gr goods_receipts%rowtype;
begin
  if not app_can('goods_receipt', 'fill_section') then
    raise exception using errcode = '42501', message = 'You do not have permission to inward containers.';
  end if;
  select * into _e from goods_receipt_entries where id = _entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Container entry not found.'; end if;
  select * into _gr from goods_receipts where id = _e.goods_receipt_id;
  if _gr.product <> app_request_product() then
    raise exception using errcode = '42501', message = 'Container entry not found.';
  end if;
  if _e.category is distinct from 'pad' then
    raise exception 'No. of Pcs/Box and Boxes/Pallet apply to Soaker Pads only.';
  end if;
  if _pcs_per_box is null or _pcs_per_box < 1 then raise exception 'No. of Pcs/Box must be a whole number of at least 1.'; end if;
  if _boxes_per_pallet is null or _boxes_per_pallet < 1 then raise exception 'No. of Boxes/Pallet must be a whole number of at least 1.'; end if;
  update goods_receipt_entries set pcs_per_box = _pcs_per_box, boxes_per_pallet = _boxes_per_pallet where id = _entry_id;
end;
$$;
revoke all on function goods_receipt_set_pad_packing(uuid, integer, integer) from public;
grant execute on function goods_receipt_set_pad_packing(uuid, integer, integer) to authenticated;

create or replace function gr_require_pad_packing() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'inwarded' and old.status is distinct from 'inwarded' and new.category = 'pad'
     and exists (select 1 from goods_receipts g where g.id = new.goods_receipt_id and g.product = 'factory')
     and (coalesce(new.pcs_per_box, 0) < 1 or coalesce(new.boxes_per_pallet, 0) < 1) then
    raise exception 'Enter No. of Pcs/Box and No. of Boxes/Pallet before inwarding a Soaker Pad.';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_gr_require_pad_packing on goods_receipt_entries;
create trigger trg_gr_require_pad_packing before update on goods_receipt_entries
  for each row execute function gr_require_pad_packing();
