-- "Admin must have full access to everything, not just View" (spec point
-- 3) needs to hold on the Supabase-direct read/write path too, not just
-- FastAPI (see app/api/deps.py's effective_permission, migration-adjacent
-- change in the same release) -- app_can() is the single function every
-- RLS policy in this app calls, so this is the one place that needs it.
--
-- An admin (app_users.is_admin) now short-circuits app_can() to true for
-- every module/action, before falling back to the existing
-- module_permissions row lookup (unchanged) and the existing
-- view-only-by-default fallback (unchanged) for everyone else.

create or replace function app_can(_module text, _action text) returns boolean
  language sql stable security definer
  set search_path = public
as $$
  select coalesce(
    (select is_admin from app_users where id = app_user_id()),
    false
  )
  or coalesce(
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
