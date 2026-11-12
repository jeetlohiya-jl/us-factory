-- 0115 -- Shift Record FG labels: shorter, easier-to-scan QR.
-- The FG pallet QR carried a JSON object ({"t","id","run","sku"}, ~85 characters), which makes a dense code
-- (about 41 x 41 modules) that is hard for the label printer and phone/scanner to read on a small label.
-- New FG pallets from Generate FG QRs now carry just the pallet number (e.g. US-PLT-2611-0058: a 25 x 25
-- code). Every scan screen already accepts a plain pallet number, so nothing else changes.
-- Existing Shift Record FG pallets are updated the same way; labels already printed with the old code still scan
-- (the id is read from either form). Additive and re-runnable. Run after 0114.

update pallets set qr_payload = display_id
  where product = 'factory' and pallet_type = 'fg' and qr_payload ~ '"run"\s*:\s*"SR-';

create or replace function shift_record_generate_fg(_id uuid) returns jsonb
  language plpgsql security definer set search_path = public
as $$
declare
  _s shift_records%rowtype; _fg_sku sku_codes%rowtype; _fg_ver sku_versions%rowtype; _machine machines%rowtype; _b qr_generation_records%rowtype;
  _carry int; _pool int; _per int; _n int; _loose int; _k int; _pid uuid; _did text; _pallets jsonb := '[]'::jsonb;
  _yymm text := to_char(now() at time zone 'utc', 'YYMM'); _by uuid := app_user_id();
begin
  if not app_can('shift_record', 'create') then
    raise exception using errcode = '42501', message = 'You do not have permission to generate FG QRs.';
  end if;
  if app_product() is distinct from 'factory' then raise exception 'Shift Record is only available in the Factory.'; end if;
  select * into _s from shift_records where id = _id and product = 'factory' for update;
  if not found then raise exception using errcode = 'P0002', message = 'Shift Record not found.'; end if;
  if _s.fg_generated_at is not null then raise exception 'FG QRs have already been generated for %.', _s.display_id; end if;
  if _s.fg_sku_code_id is null then raise exception '% has no FG tray SKU, so there is nothing to generate.', _s.display_id; end if;
  select * into _fg_sku from sku_codes where id = _s.fg_sku_code_id;
  select * into _fg_ver from sku_versions where id = _s.fg_sku_version_id;
  select * into _machine from machines where id = _s.machine_id;
  _per := coalesce(_s.total_pcs_per_pallet, _fg_ver.prod_total_pcs_per_pallet);
  if _per is null or _per <= 0 then
    raise exception 'Trays per Pallet is not set for %.', _fg_sku.code;
  end if;
  select coalesce(sum(loose_trays), 0) into _carry from (
    select loose_trays from shift_records
     where product = 'factory' and id <> _id and fg_sku_code_id = _s.fg_sku_code_id and fg_generated_at is not null
       and loose_trays > 0 and loose_carried_to is null for update) x;
  _pool := _s.trays_produced + _s.cum_hold_fg_trays + _carry;
  _n := _pool / _per;
  _loose := _pool - _n * _per;
  if _n > 0 then
    insert into qr_generation_records (product, batch_display_id, qr_type, category, shipment_number, sku_code_id, sku_version_id,
                                       sku_code_snapshot, sku_version_snapshot, country_code, quantity, status, generated_at)
      values ('factory', 'FGQR-' || lpad(factory_next_seq('qr_batch:fg')::text, 4, '0'), 'fg', 'fgtray', _s.shipment_number, _fg_sku.id, _fg_ver.id,
              coalesce(nullif(btrim(_fg_sku.sku_code), ''), _fg_sku.code), _fg_ver.version, 'US', _n, 'generated', now())
      returning * into _b;
    for _k in 1.._n loop
      _did := 'US-PLT-' || _yymm || '-' || lpad(factory_next_seq('pallet:US-PLT')::text, 4, '0');
      insert into pallets (product, display_id, pallet_type, category, sku_code_id, sku_version_id, sku_code_snapshot, sku_version_snapshot,
                           shipment_number, source_qr_generation_id, source_machine_id, lifecycle_status, qr_payload)
        values ('factory', _did, 'fg', 'fgtray', _fg_sku.id, _fg_ver.id, coalesce(nullif(btrim(_fg_sku.sku_code), ''), _fg_sku.code), _fg_ver.version,
                _s.shipment_number, _b.id, _s.machine_id, 'generated',
                _did)
        returning id into _pid;
      insert into pallet_lifecycle_events (pallet_id, stage, metadata, actor_user_id, occurred_at)
        values (_pid, 'generated', jsonb_build_object('shift_record', _s.display_id, 'batch', _b.batch_display_id, 'trays', _per,
                                                       'machine', _machine.code, 'shift', _s.shift, 'carried_in_loose_trays', case when _k = 1 then _carry end),
                _by, now());
      _pallets := _pallets || jsonb_build_object('id', _pid, 'display_id', _did, 'trays', _per);
    end loop;
  end if;
  update shift_records set loose_carried_to = _id
    where product = 'factory' and id <> _id and fg_sku_code_id = _s.fg_sku_code_id and fg_generated_at is not null
      and loose_trays > 0 and loose_carried_to is null;
  update shift_records set fg_pallets = _n, loose_trays = _loose, loose_carried_in = _carry, qr_generation_id = _b.id,
                           fg_generated_at = now(), fg_generated_by = _by where id = _id;
  return jsonb_build_object('id', _id, 'display_id', _s.display_id, 'fg_pallets', _pallets, 'qr_generation_id', _b.id,
                            'carried_in', _carry, 'loose_trays', _loose);
end;
$$;
revoke all on function shift_record_generate_fg(uuid) from public;
grant execute on function shift_record_generate_fg(uuid) to authenticated;
