-- Production and IPQC were both missing module_permissions seed rows
-- entirely (every other module's migration seeds its own module the
-- moment it's introduced -- see 0001/0002/0003/0005 -- these two were
-- never given the same treatment when they were built). With no row for
-- either module, app_users.get_perms() (production.py/ipqc.py) falls back
-- to a view-only default for EVERY user, including the admin dev user --
-- so nobody, not even an admin, could ever actually save a Production Run
-- or an IPQC record. This migration fixes that gap.
--
-- Also aligning these two modules' permission SHAPE with the rest of the
-- app: Inward QC / Inward Vehicle Inspection gate their staff-facing
-- "fill in the observations/checklist" actions on can_fill_section, not
-- can_edit (see require_qc_permission("fill_section") /
-- require_permission("fill_section") in those routers) -- can_edit is
-- reserved for admin-style corrections. Production's save_production_run
-- and IPQC's save_ipqc_record are exactly that same "fill in the form"
-- action (Rejection Classification/Wastage/FG Pallets; Shift Incharge/
-- Check Time blocks), so the application code is updated alongside this
-- migration to check can_fill_section there too, matching the rest of the
-- app instead of being the one inconsistent pair of modules.

-- Uses DO UPDATE (not DO NOTHING): if a row for these modules already
-- exists for a user -- e.g. from an earlier ad-hoc/manual grant made
-- before can_fill_section existed -- it would otherwise default that
-- column to false and silently reproduce this exact bug. Every conflicting
-- row is corrected to at least the access below, never downgraded (an
-- existing true stays true via the greatest(...) merge).
insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
values
  ('00000000-0000-0000-0000-000000000001', 'production', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'production', true, false, false, false, false, true),
  ('00000000-0000-0000-0000-000000000001', 'ipqc', true, true, true, true, true, true),
  ('00000000-0000-0000-0000-000000000002', 'ipqc', true, false, false, false, false, true)
on conflict (user_id, module) do update set
  can_view = greatest(module_permissions.can_view, excluded.can_view),
  can_create = greatest(module_permissions.can_create, excluded.can_create),
  can_edit = greatest(module_permissions.can_edit, excluded.can_edit),
  can_delete = greatest(module_permissions.can_delete, excluded.can_delete),
  can_approve = greatest(module_permissions.can_approve, excluded.can_approve),
  can_fill_section = greatest(module_permissions.can_fill_section, excluded.can_fill_section);
