-- Hold & Release: whenever a QC record in one of the five gated modules
-- (Inward Vehicle Inspection, Inward QC, IPQC, RQC, Outward Vehicle
-- Inspection) reaches status 'hold', the user completes this form. Stored
-- as its own table, linked to (never overwriting) the original record --
-- the original inspection's own answers/reason/shipment number/SKU/
-- quantities and linked records all stay exactly where they already live;
-- this table only ever adds the Hold & Release decision trail alongside
-- them.
--
-- One row per (module, record_id) -- enforced by the unique constraint
-- below, which is also the idempotency backstop for the frontend's
-- find-or-create-on-open flow (see api.ts's getOrCreateHoldRelease):
-- opening the same Hold record twice, or two people opening it at once,
-- can never create two Hold & Release rows for it.
--
-- No single physical foreign key is possible here (record_id points into
-- one of five different tables depending on `module`) -- this is the one
-- genuinely polymorphic relationship in this app. `module` is constrained
-- to the five real values by a CHECK constraint, and every real write path
-- (the frontend's find-or-create) only ever creates a row for a record_id
-- it just read out of the matching module's own table, so an orphaned row
-- is not a realistic outcome -- but it is not DB-enforced the way every
-- other relationship in this app is, which is worth flagging explicitly
-- rather than silently treating it as equivalent to a real FK.
create table if not exists hold_release_records (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in (
    'inward_vehicle_inspection', 'inward_qc', 'ipqc', 'rqc', 'outward_vehicle_inspection'
  )),
  record_id uuid not null,
  -- Hold Details
  date_of_hold text,
  product_name text,
  batch_code text,
  point_of_detection text,
  qty_of_hold text,
  reason_for_hold text,
  record_filled_by text,
  -- Decision Details
  date_of_decision text,
  disposition text,
  reason_of_disposition text,
  qty_decided text,
  done_by text,
  approved_by text,
  -- This form's own completion state -- 'draft' (Save Draft) vs
  -- 'completed' (Save) -- entirely separate from the original record's own
  -- Hold status, which this table never touches.
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (module, record_id)
);

-- No separate index needed here: the unique(module, record_id) constraint
-- above already creates a btree index on exactly these two columns in this
-- order, which is also the only lookup pattern this table is ever queried
-- by (find-or-create by module+record_id) -- a second explicit index would
-- be a pure duplicate.

alter table hold_release_records enable row level security;

grant select, insert, update on hold_release_records to authenticated;

-- Same dynamic-module pattern as every other RLS policy in this app
-- (app_can(module, action)) -- except the module comes from the ROW itself
-- rather than being fixed per-table, since one table here serves five
-- different modules' permission scopes. Filling in a Hold & Release form is
-- gated on the same 'fill_section' permission as filling in the original
-- record it's attached to (the same person who completes an inspection is
-- who completes its Hold & Release form, in the same module).
drop policy if exists hold_release_select on hold_release_records;
create policy hold_release_select on hold_release_records for select
  using (app_can(module, 'view'));

drop policy if exists hold_release_insert on hold_release_records;
create policy hold_release_insert on hold_release_records for insert
  with check (app_can(module, 'fill_section'));

drop policy if exists hold_release_update on hold_release_records;
create policy hold_release_update on hold_release_records for update
  using (app_can(module, 'fill_section'))
  with check (app_can(module, 'fill_section'));
