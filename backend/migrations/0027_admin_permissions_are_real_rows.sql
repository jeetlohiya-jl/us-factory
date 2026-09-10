-- "Admin should start with full access across all modules... while still
-- allowing individual permissions to be removed where required" (explicit
-- user request). Migration 0023 made "Admin has full access" a runtime
-- override in app_can() (and effective_permission() on the FastAPI side)
-- that unconditionally granted every permission to any is_admin user,
-- completely ignoring their module_permissions rows. That satisfied "full
-- access" but broke "removed where required": unchecking a permission for
-- an admin in the Users screen wrote a row that the override then ignored,
-- so the UI showed a change that had zero real effect -- and separately,
-- the Users screen's own checkboxes read the real (mostly view-only seed)
-- rows, so an admin's permissions matrix looked wrong even though their
-- actual access was "everything" underneath.
--
-- Fix: admin access is now a data fact, not a runtime override.
--   1) Backfill every existing is_admin=true user's module_permissions to
--      full access for every module (matches what the old override was
--      already granting them in practice, so this is a no-op in terms of
--      actual access -- only the rows now say what's true).
--   2) Redefine app_can() back to a plain row-lookup-or-view-default,
--      dropping the is_admin short-circuit. The FastAPI-side mirror
--      (effective_permission() in app/api/deps.py) was changed the same
--      way in the same release. New admins get seeded the same way going
--      forward via users.py's create_user/update_user (_seed_full_permissions),
--      not via a query-time override -- so unchecking a box for an admin
--      afterward now actually restricts them, same as any other user.

insert into module_permissions (user_id, module, can_view, can_create, can_edit, can_delete, can_approve, can_fill_section)
select u.id, m.module, true, true, true, true, true, true
from app_users u
cross join (values
  ('inward_vehicle_inspection'), ('inward_qc'), ('rm_qr_generation'), ('rm_storage'),
  ('material_consumption'), ('production'), ('ipqc'), ('rqc'), ('fg_qr_generation'), ('fg_storage'),
  ('customer_shipment'), ('shipment_picking'), ('outward_vehicle_inspection'), ('machine_downtime')
) as m(module)
where u.is_admin = true
on conflict (user_id, module) do update set
  can_view = true, can_create = true, can_edit = true, can_delete = true, can_approve = true, can_fill_section = true;

create or replace function app_can(_module text, _action text) returns boolean
  language sql stable security definer
  set search_path = public
as $$
  select coalesce(
    (
      select case _action
        when 'view' then can_view
        when 'create' then can_create
        when 'edit' then can_edit
        when 'delete' then can_delete
        when 'approve' then can_approve
        when 'fill_section' then can_fill_section
        else false
      end
      from module_permissions
      where user_id = app_user_id() and module = _module
    ),
    -- No explicit row => view-only default, exactly matching
    -- ModulePermission(can_view=True) in every FastAPI *_get_perms().
    _action = 'view'
  );
$$;
