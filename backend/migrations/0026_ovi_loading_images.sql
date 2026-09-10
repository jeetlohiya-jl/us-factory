-- Outward Vehicle Inspection: loading-process photos (spec: "same as
-- inward for image attachment"). Named slots transcribed from the
-- "Loading Container Process" template (D69-1.7C) attached by the user --
-- License Plate, Container Number, Before Loading, First Row .. Eleventh
-- Row, Seal Half/Entire, Lead Seal, Weighbridge Record. See
-- OVI_IMAGE_TYPES in ovi_service.py for the authoritative list/order; the
-- CHECK constraint below is kept in lockstep with it.
--
-- Same shape and same FastAPI-owned write path as inward_vehicle_
-- inspection_images (migration 0001) -- storage adapter handles the
-- actual file, this table just tracks path/url/slot. No OCR columns:
-- these are loading-progress photos, not identifier images to extract
-- text from.
--
-- (Inward Vehicle Inspection's own "allow multiple images" request --
-- Container Photo becoming a multi-image field like Damage Pictures --
-- needed no schema change: inward_vehicle_inspection_images already
-- supports more than one row per image_type, exactly like the existing
-- 'damage' type does; only the frontend field component changed.)
create table if not exists outward_vehicle_inspection_images (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references outward_vehicle_inspections(id) on delete cascade,
  image_type text not null check (image_type in (
    'license_plate', 'container_number', 'before_loading',
    'row_1', 'row_2', 'row_3', 'row_4', 'row_5', 'row_6', 'row_7', 'row_8', 'row_9', 'row_10', 'row_11',
    'seal_half', 'seal_entire', 'lead_seal', 'weighbridge_record'
  )),
  storage_path text not null,
  public_url text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_ovi_images_inspection on outward_vehicle_inspection_images(inspection_id, image_type);

-- Ownership matches outward_vehicle_inspections itself: FastAPI's service
-- connection owns writes (see the new /images routes in
-- api/outward_vehicle_inspection.py); the browser only ever reads this
-- table directly, joined into the same Supabase-direct OVI detail select
-- used for every other OVI field.
alter table outward_vehicle_inspection_images enable row level security;

grant select on outward_vehicle_inspection_images to authenticated;

drop policy if exists outward_vehicle_inspection_images_select on outward_vehicle_inspection_images;
create policy outward_vehicle_inspection_images_select on outward_vehicle_inspection_images for select
  using (app_can('outward_vehicle_inspection', 'view'));
