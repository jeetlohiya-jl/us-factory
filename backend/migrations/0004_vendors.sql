-- Vendor master data for Inward Vehicle Inspection's "Vendor Name" field.
-- Previously a freehand text field; now backed by a managed per-category
-- list (Vendors admin screen) so it can be a dropdown instead. Vendor Name
-- on inward_vehicle_inspections stays a plain text snapshot column (not a
-- foreign key) -- deleting or renaming a vendor here never breaks or
-- rewrites history on an already-submitted inspection.

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  category text not null, -- tray | pad | polybag | cfb | glue
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(category, name)
);
