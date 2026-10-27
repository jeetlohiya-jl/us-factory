-- Goods Outward: the same Shipment Number can be used on more than one shipment
-- (e.g. one inward shipment shipped out in several loads). Container Number stays unique.
drop index if exists customer_shipments_shipment_number_key;
alter table customer_shipments drop constraint if exists customer_shipments_shipment_number_key;
create index if not exists idx_customer_shipments_shipment_number on customer_shipments (product, shipment_number);
