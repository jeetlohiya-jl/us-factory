-- Section 13: Customer Shipment -- capture Pcs and Pcs/Sleeve per line
-- item. Neither field existed anywhere in this app before (per the earlier
-- investigation: only pallets_required was ever collected on a Customer
-- Shipment line item). Both are plain operator-entered numbers/text, not
-- derived from anything upstream -- SkuVersion.prod_pcs_per_sleeve is
-- reference data for Production, not the same value a customer shipment
-- necessarily ships at, so it's never auto-filled here.
alter table customer_shipment_line_items add column if not exists pcs integer;
alter table customer_shipment_line_items add column if not exists pcs_per_sleeve text;
comment on column customer_shipment_line_items.pcs is 'Section 13: total pieces for this line item, entered on the Customer Shipment form.';
comment on column customer_shipment_line_items.pcs_per_sleeve is 'Section 13: pieces per sleeve for this line item, entered on the Customer Shipment form.';
