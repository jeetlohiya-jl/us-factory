-- Section 12: Production -- backend-populated attributes (SKU Name, Weight,
-- Pcs/Sleeve, Sleeve/Case, Total Pcs/Pallet, Pad Type/Name/Code, Pad Color,
-- Case Type) must be visible AND editable in both the Pending-completion
-- fill-in flow and the later Edit flow -- plus three genuinely new
-- attributes that don't exist anywhere in the schema yet: Machine No.,
-- Auto Padding, Container Order No.
--
-- These attributes are shown one column per machine entry (PROD_DETAIL_ROWS
-- in ProductionDetailPanel.tsx), sourced today from the entry's linked
-- SkuVersion.prod_* reference columns -- pure read-only reference data,
-- shared across every run that happens to use that SKU Version. Making
-- them "editable" per the task does NOT mean editing that shared SKU
-- Version reference data (which would silently change every other run
-- using the same SKU Version); it means an OVERRIDE captured on this one
-- machine entry, for this one run, so an operator can correct what
-- actually happened on the floor without touching the SKU master data.
-- Null override = "use the SKU Version's own value" (today's exact
-- behaviour, unchanged); non-null override = the operator's correction,
-- which always wins.
alter table material_consumption_machine_entries add column if not exists override_weight text;
alter table material_consumption_machine_entries add column if not exists override_pcs_per_sleeve text;
alter table material_consumption_machine_entries add column if not exists override_sleeve_per_case text;
alter table material_consumption_machine_entries add column if not exists override_total_pcs_per_pallet text;
alter table material_consumption_machine_entries add column if not exists override_pad_type text;
alter table material_consumption_machine_entries add column if not exists override_pad_color text;
alter table material_consumption_machine_entries add column if not exists override_case_type text;

-- Genuinely new fields -- no prior column, no prior UI, no upstream source.
alter table material_consumption_machine_entries add column if not exists machine_no text;
alter table material_consumption_machine_entries add column if not exists auto_padding text;
alter table material_consumption_machine_entries add column if not exists container_order_no text;

comment on column material_consumption_machine_entries.override_weight is 'Section 12: operator override of the SKU Version''s prod_weight for this one machine entry/run. Null = use the SKU Version''s own value.';
comment on column material_consumption_machine_entries.machine_no is 'Section 12: brand-new field, free text (distinct from machine_id/Machine dropdown) -- entered per machine entry.';
comment on column material_consumption_machine_entries.auto_padding is 'Section 12: brand-new field -- entered per machine entry.';
comment on column material_consumption_machine_entries.container_order_no is 'Section 12: brand-new field -- entered per machine entry.';
