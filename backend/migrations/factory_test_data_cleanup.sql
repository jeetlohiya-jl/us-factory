-- ============================================================================
-- Factory test-data cleanup -- run ONCE, in the factory prod Supabase SQL
-- Editor, AFTER migration 0048.
--
-- Deletes every Factory record traceable to a Goods Receipt:
--   Goods Receipts -> their RM QR batches and pallets -> storage records ->
--   Material Consumption records that used those pallets -> the Production
--   Runs / IPQC records ONLY those Material Consumptions created (a run that
--   also has a US Factory Material Consumption is kept, and just loses the
--   Factory part) -> Factory Customer Shipments (with picking and outward
--   inspections) and Factory RQC records -> anything else tagged 'factory'.
-- Also resets Factory's number sequences, so Factory numbering starts at 1.
--
-- US Factory records are never touched. Records created in the Factory
-- screens BEFORE migration 0048 that did not use a Goods Receipt pallet
-- (e.g. a test RQC typed in by hand) cannot be told apart from US Factory
-- ones and are NOT deleted by this script.
--
-- STEP 1: run only the PREVIEW block (select it, then Run) and check the
-- counts. STEP 2: run the whole file. Everything is one transaction.
-- ============================================================================

-- PREVIEW ------------------------------------------------------------------
with fp as (select id from pallets where product = 'factory' or source_goods_receipt_entry_id is not null),
     mc as (select distinct material_consumption_id id from material_consumption_pallets where pallet_id in (select id from fp)
            union select id from material_consumptions where product = 'factory')
select 'goods_receipts' as what, count(*) from goods_receipts
union all select 'factory QR batches', count(*) from qr_generation_records where product = 'factory' or source_goods_receipt_entry_id is not null
union all select 'factory pallets', count(*) from fp
union all select 'factory storage records', count(*) from storage_records where pallet_id in (select id from fp) or product = 'factory'
union all select 'material consumptions using factory pallets', count(*) from mc
union all select 'production runs created only by those', count(*) from production_runs r
  where (r.product = 'factory' or exists (select 1 from material_consumptions m where m.production_run_id = r.id and m.id in (select id from mc)))
    and not exists (select 1 from material_consumptions m where m.production_run_id = r.id and m.id not in (select id from mc))
union all select 'factory customer shipments', count(*) from customer_shipments where product = 'factory'
union all select 'factory RQC records', count(*) from rqc_records where product = 'factory';

-- DELETE -------------------------------------------------------------------
begin;

create temporary table _fp on commit drop as
  select id from pallets where product = 'factory' or source_goods_receipt_entry_id is not null;
create temporary table _mc on commit drop as
  select distinct material_consumption_id as id from material_consumption_pallets where pallet_id in (select id from _fp)
  union select id from material_consumptions where product = 'factory';
create temporary table _run on commit drop as
  select r.id from production_runs r
  where (r.product = 'factory' or exists (select 1 from material_consumptions m where m.production_run_id = r.id and m.id in (select id from _mc)))
    and not exists (select 1 from material_consumptions m where m.production_run_id = r.id and m.id not in (select id from _mc));

-- Material Consumption records that used Factory pallets
delete from material_consumption_pallets where material_consumption_id in (select id from _mc) or pallet_id in (select id from _fp);
delete from material_consumption_machine_entries where material_consumption_id in (select id from _mc);
delete from material_consumptions where id in (select id from _mc);

-- Production Runs / IPQC / RQC that only those created (plus anything tagged factory)
delete from hold_release_records where module = 'ipqc' and record_id in (select id from ipqc_records where production_run_id in (select id from _run) or product = 'factory');
delete from ipqc_block_defects where block_id in (select id from ipqc_check_blocks where ipqc_record_id in (select id from ipqc_records where production_run_id in (select id from _run) or product = 'factory'));
delete from ipqc_check_blocks where ipqc_record_id in (select id from ipqc_records where production_run_id in (select id from _run) or product = 'factory');
delete from ipqc_records where production_run_id in (select id from _run) or product = 'factory';
delete from production_run_machines where production_run_id in (select id from _run);
delete from production_wastage_entries where production_run_id in (select id from _run);
update rqc_records set production_run_id = null where production_run_id in (select id from _run) and product <> 'factory';
delete from production_runs where id in (select id from _run);

-- Factory Customer Shipments with their picking and outward inspections
delete from shipment_picking_picks
  where pallet_id in (select id from _fp)
     or shipment_picking_request_id in (select id from shipment_picking_requests
          where product = 'factory' or customer_shipment_id in (select id from customer_shipments where product = 'factory'));
delete from shipment_picking_requests where product = 'factory' or customer_shipment_id in (select id from customer_shipments where product = 'factory');
delete from outward_vehicle_inspection_images where inspection_id in (select id from outward_vehicle_inspections where customer_shipment_id in (select id from customer_shipments where product = 'factory'));
delete from outward_vehicle_inspections where customer_shipment_id in (select id from customer_shipments where product = 'factory');
delete from customer_shipment_line_items where customer_shipment_id in (select id from customer_shipments where product = 'factory');
delete from customer_shipments where product = 'factory';

-- Factory pallets, their storage and history, QR batches, Goods Receipts
delete from storage_records where pallet_id in (select id from _fp) or product = 'factory';
delete from pallet_lifecycle_events where pallet_id in (select id from _fp);
delete from pallets where id in (select id from _fp);
delete from qr_generation_records where product = 'factory' or source_goods_receipt_entry_id is not null;
delete from goods_receipts;

-- Factory RQC records (their FG QR batches / pallets are already gone above)
delete from qr_generation_records where source_rqc_record_id in (select id from rqc_records where product = 'factory')
   or source_rqc_approval_entry_id in (select e.id from rqc_approval_entries e join rqc_records r on r.id = e.rqc_record_id where r.product = 'factory');
delete from hold_release_records where module = 'rqc' and record_id in (select id from rqc_records where product = 'factory');
delete from rqc_machine_allocations where rqc_record_id in (select id from rqc_records where product = 'factory');
delete from rqc_approval_entries where rqc_record_id in (select id from rqc_records where product = 'factory');
delete from rqc_coa_observations where rqc_record_id in (select id from rqc_records where product = 'factory');
delete from rqc_defect_results where rqc_record_id in (select id from rqc_records where product = 'factory');
delete from rqc_records where product = 'factory';

-- Factory number sequences start again at 1
delete from display_id_counters where counter_key like 'factory:%';

commit;
