-- Adds an admin flag to app_users, backing the new in-app user-management
-- screen (Setup -> Users). Until now every app_users/module_permissions
-- row was created by hand via SQL in the Supabase dashboard -- there was
-- no "admin" concept at all, just is_active. This column is the gate for
-- who may open /users and create/edit other users' accounts and module
-- permissions (enforced server-side in FastAPI's new require_admin
-- dependency, app/api/deps.py -- not by RLS, since the users API writes
-- through the FastAPI service connection exactly like every other
-- privileged multi-table endpoint in this app).
--
-- Defaults to false for every existing row, including the two dev seed
-- users from migration 0001 -- nobody is silently promoted to admin by
-- this migration. Whoever runs this should manually flip one real user's
-- row to is_admin = true afterward (e.g. via the SQL editor once) so
-- there's a first admin able to reach the new screen at all:
--   update app_users set is_admin = true where email = '<your email>';

alter table app_users
  add column if not exists is_admin boolean not null default false;
