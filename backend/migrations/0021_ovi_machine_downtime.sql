-- Outward Vehicle Inspection (OVI) + Machine Downtime.
--
-- Design notes:
-- 1) OVI is auto-created (never manually) the instant a Customer Shipment
--    is recorded -- one OVI per Customer Shipment (unique constraint on
--    customer_shipment_id is the idempotency backstop, exactly like
--    rqc_records.production_run_id's unique constraint backstops "one RQC
--    per Production Run"). Per explicit user clarification: RQC and OVI
--    are NOT linked -- the real chain here is Customer Shipment -> (later)
--    Shipment Picking -> Outward Vehicle Inspection, not RQC. Status starts
--    'pending' and only becomes draft/hold/approved via OVI's own save
--    route (api/outward_vehicle_inspection.py), matching RQC/IPQC's own
--    "auto-created as Pending, own save route drives status" convention.
-- 2) Shipment Number, Customer Name, and Quantity are snapshotted from the
--    parent Customer Shipment at creation time (same snapshot-at-creation
--    convention as every other downstream record in this app) so the OVI
--    form never re-asks for information the system already has. Quantity
--    snapshots the CS's total required pallets (the best "quantity"
--    figure available at CS-creation time, before Shipment Picking has
--    run) and stays editable afterward, matching the prototype's own
--    plain-text Quantity field.
-- 3) The 7 vehicle-condition checks are FIXED, hardcoded reference data
--    (OVI_QUESTIONS in ovi_service.py) -- exactly like RQC's defect groups
--    and IPQC's 8-item grid are hardcoded rather than stored in a
--    checklist_items table. Reusing inward_vehicle_inspection_checklist_
--    items was considered and rejected: that table already holds a
--    DIFFERENT, unrelated set of real questions for Inward Vehicle
--    Inspection ("Vehicle arrived within scheduled time window", etc.) --
--    reusing it would either corrupt that seeded list or require a
--    module-discriminator hack for content that doesn't actually overlap.
--    Only per-record answers are stored, in outward_vehicle_inspection_
--    answers, keyed by a plain integer question_sr (mirrors rqc_defect_
--    results.defect_sr) rather than a checklist_item_id FK.
-- 4) Machine Downtime is fully independent (no FK to Customer Shipment/
--    Shipment Picking/RQC/OVI) and stays Supabase-direct end-to-end,
--    including writes -- mirrors the existing sku_codes/vendors/machines
--    "reference data with RLS-gated full CRUD" convention (see migration
--    0011) rather than adding a FastAPI CRUD layer for a simple single-
--    table record with no privileged logic. Create is Admin-only (insert
--    policy gated on can_create); Delete is Admin-only (delete policy
--    gated on can_delete); Edit is available to any user with can_edit so
--    operators can fill in end time/reason after the fact.

create table if not exists outward_vehicle_inspections (
  id uuid primary key default gen_random_uuid(),
  customer_shipment_id uuid not null unique references customer_shipments(id),
  shipment_number text,
  customer_name text,
  quantity text,
  truck_number text,
  invoice_number text,
  transporter_name text,
  seal_number text,
  remarks text,
  status text not null default 'pending',  -- 'pending' | 'draft' | 'approved' | 'hold'
  created_by uuid references app_users(id),
  updated_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ovi_customer_shipment on outward_vehicle_inspections(customer_shipment_id);
create index if not exists idx_ovi_status on outward_vehicle_inspections(status);
create index if not exists idx_ovi_created_at on outward_vehicle_inspections(created_at);

create table if not exists outward_vehicle_inspection_answers (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references outward_vehicle_inspections(id) on delete cascade,
  question_sr integer not null,
  answer text,  -- 'ok' | 'not_ok' | null (unanswered)
  unique(inspection_id, question_sr)
);

create index if not exists idx_ovi_answers_inspection on outward_vehicle_inspection_answers(inspection_id);

create table if not exists machine_downtime_records (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid references machines(id),
  machine_snapshot text,
  shift text,
  start_time text,   -- 'HH:MM', 24h -- matches prototype's <input type="time">
  end_time text,
  duration_minutes integer,  -- computed client-side at save (handles overnight wrap), stored for search/sort
  reason text,
  status text not null default 'draft',  -- 'draft' | 'saved'
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_md_created_at on machine_downtime_records(created_at);
create index if not exists idx_md_machine on machine_downtime_records(machine_id);
create index if not exists idx_md_shift on machine_downtime_records(shift);

-- Ownership matches every other transactional table -- FastAPI's service
-- connection owns outward_vehicle_inspections* (writes go through its own
-- save/delete routes). machine_downtime_records is owned the same way at
-- the table level, but is written directly by the browser client via the
-- RLS write policies below (grants + policies), not through FastAPI.
alter table outward_vehicle_inspections enable row level security;
alter table outward_vehicle_inspection_answers enable row level security;
alter table machine_downtime_records enable row level security;

grant select on outward_vehicle_inspections to authenticated;
grant select on outward_vehicle_inspection_answers to authenticated;

drop policy if exists outward_vehicle_inspections_select on outward_vehicle_inspections;
create policy outward_vehicle_inspections_select on outward_vehicle_inspections for select
  using (app_can('outward_vehicle_inspection', 'view'));

drop policy if exists outward_vehicle_inspection_answers_select on outward_vehicle_inspection_answers;
create policy outward_vehicle_inspection_answers_select on outward_vehicle_inspection_answers for select
  using (app_can('outward_vehicle_inspection', 'view'));

-- Machine Downtime: full CRUD grants, mirroring sku_codes/vendors/machines
-- (migration 0011) -- separate insert/update/delete policies (rather than
-- one "for all" policy) because each action has a different required
-- permission: create and delete are Admin-only, edit is not.
grant select, insert, update, delete on machine_downtime_records to authenticated;

drop policy if exists machine_downtime_select on machine_downtime_records;
create policy machine_downtime_select on machine_downtime_records for select
  using (app_can('machine_downtime', 'view'));

drop policy if exists machine_downtime_insert on machine_downtime_records;
create policy machine_downtime_insert on machine_downtime_records for insert
  with check (app_can('machine_downtime', 'create'));

drop policy if exists machine_downtime_update on machine_downtime_records;
create policy machine_downtime_update on machine_downtime_records for update
  using (app_can('machine_downtime', 'edit'))
  with check (app_can('machine_downtime', 'edit'));

drop policy if exists machine_downtime_delete on machine_downtime_records;
create policy machine_downtime_delete on machine_downtime_records for delete
  using (app_can('machine_downtime', 'delete'));

insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
values
  ('00000000-0000-0000-0000-000000000001', 'outward_vehicle_inspection', true, false, false, true, false, true),
  ('00000000-0000-0000-0000-000000000002', 'outward_vehicle_inspection', true, false, false, false, false, true),
  ('00000000-0000-0000-0000-000000000001', 'machine_downtime', true, true, true, true, false, false),
  ('00000000-0000-0000-0000-000000000002', 'machine_downtime', true, false, true, false, false, false)
on conflict (user_id, module) do update set
  can_view = greatest(module_permissions.can_view, excluded.can_view),
  can_create = greatest(module_permissions.can_create, excluded.can_create),
  can_edit = greatest(module_permissions.can_edit, excluded.can_edit),
  can_delete = greatest(module_permissions.can_delete, excluded.can_delete),
  can_approve = greatest(module_permissions.can_approve, excluded.can_approve),
  can_fill_section = greatest(module_permissions.can_fill_section, excluded.can_fill_section);
