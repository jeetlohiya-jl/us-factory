-- 2026-09-25 -- Goods Outward "Print Packing List" feature.
--
-- Adds the fields needed to reproduce Cirkla's exact "Last Mile Packing
-- List" document. Split across three tables, matching where each fact
-- naturally lives:
--
--   customers               -- address is a per-customer master fact
--                              (reused as both the packing list's
--                              "Address" row and the default starting
--                              value for "Ship To" on every shipment).
--   sku_versions            -- HS Code and Case Size (inch) are packaging
--                              specs of the SKU/packaging itself, entered
--                              once via the SKU Names admin screen
--                              alongside the existing prod_pcs_per_sleeve /
--                              prod_sleeve_per_case reference attributes
--                              (Trays/Combo is derived from those two at
--                              print time, not stored separately).
--   customer_shipments /    -- PO No., PO Date, PI No. and Ship To are
--   customer_shipment_          shipment-specific facts with no earlier
--   line_items                  home; Total Combo and UOM are likewise
--                                per-line-item facts (the actual quantity
--                                going out on THIS shipment, not a fixed
--                                SKU constant -- Total Quantity (Trays) is
--                                computed from Total Combo x Trays/Combo).
--
-- All nullable: none of this blocks Goods Outward's existing create/edit
-- flow, and every column is filled in later via the new "Create Packing
-- List" step on Goods Outward's detail panel.

alter table customers add column if not exists address text;

alter table sku_versions add column if not exists hs_code text;
alter table sku_versions add column if not exists case_size text;

alter table customer_shipments add column if not exists po_number text;
alter table customer_shipments add column if not exists po_date date;
alter table customer_shipments add column if not exists pi_number text;
alter table customer_shipments add column if not exists ship_to_address text;

alter table customer_shipment_line_items add column if not exists uom text;
alter table customer_shipment_line_items add column if not exists total_combo numeric;
