-- 2026-09-17: supports rqc_service.find_linked_production_run_by_shipment_number,
-- the new fallback RQC uses to resolve a Production Run (and, through it,
-- SKU Code/Version/Shift/Date) directly from a shipment number when no
-- IPQC record exists for it (IPQC is optional). That lookup filters
-- pallets by shipment_number -- index it so the fallback stays fast as the
-- pallets table grows, instead of a sequential scan on every "+ New
-- Record" RQC creation that doesn't have an IPQC match.
create index if not exists idx_pallets_shipment_number on pallets (shipment_number);
