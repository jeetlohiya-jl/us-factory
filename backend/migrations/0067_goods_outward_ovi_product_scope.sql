-- Goods Outward -> Outward Vehicle Inspection product scoping (2026-09-28)
--
-- Goods Outward's pallet-picking flow now takes the user straight into the
-- existing Outward Vehicle Inspection (OVI) record for that shipment once
-- picking finishes (frontend: GoodsOutwardDetailPanel.tsx, reusing the
-- existing OviPanel.tsx unchanged -- this is not a new module). OVI records
-- are auto-created the instant a Customer Shipment is recorded
-- (ovi_service.create_pending_for_shipment), and CustomerShipment is
-- already ProductScoped (migration 0048) -- but outward_vehicle_inspections
-- itself never was, since Factory had no reason to touch it until now.
-- Without this, a Factory-created OVI record would be readable/writable by
-- every unit -- the same gap migration 0066 closed for Inward Vehicle
-- Inspection. Same pattern, applied to the parent table only (its answers/
-- images children rely on the FK relationship, exactly like Inward Vehicle
-- Inspection's own line_items/images/checklist_answers were left in 0066).
--
-- Additive and re-runnable.

alter table outward_vehicle_inspections add column if not exists product text not null default app_request_product();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'outward_vehicle_inspections_product_check') then
    alter table outward_vehicle_inspections add constraint outward_vehicle_inspections_product_check check (product in ('factory', 'us_factory'));
  end if;
end $$;
drop policy if exists outward_vehicle_inspections_product_scope on outward_vehicle_inspections;
create policy outward_vehicle_inspections_product_scope on outward_vehicle_inspections as restrictive for all
  using (product = app_request_product()) with check (product = app_request_product());
