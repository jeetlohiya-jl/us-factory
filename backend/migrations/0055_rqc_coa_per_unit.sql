-- COA is kept once per Shipment Number (every RQC record of that shipment
-- shows the same COA) -- but it was the one table left out of the Factory /
-- US Factory separation (migration 0048): its Shipment Number was unique
-- across BOTH units, so Factory's HA1 and US Factory's HA1 would have shared
-- a single COA. Now: one COA per Shipment Number per unit.
-- Additive and re-runnable.

alter table rqc_coa_entries add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rqc_coa_entries_product_check') then
    alter table rqc_coa_entries add constraint rqc_coa_entries_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;

-- Existing COA entries: Factory's when that Shipment Number only ever had
-- Factory RQC records.
update rqc_coa_entries c set product = 'factory'
  where c.product <> 'factory'
    and exists (select 1 from rqc_records r where r.shipment_number = c.shipment_number and r.product = 'factory')
    and not exists (select 1 from rqc_records r where r.shipment_number = c.shipment_number and r.product = 'us_factory');

alter table rqc_coa_entries drop constraint if exists rqc_coa_entries_shipment_number_key;
drop index if exists rqc_coa_entries_shipment_number_key;
create unique index rqc_coa_entries_shipment_number_key on rqc_coa_entries (product, shipment_number);

drop policy if exists rqc_coa_entries_product_scope on rqc_coa_entries;
create policy rqc_coa_entries_product_scope on rqc_coa_entries as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
