-- Portfolio-level access gate, shown as a picker right after sign-in:
-- which top-level product(s) a signed-in email may open. Today there are
-- two: "Factory" (not built yet -- reserved for a future product) and
-- "US Factory" (this app). Deliberately a NEW, standalone table rather
-- than more columns on app_users: a user who only has "Factory" access
-- may never get an app_users row in THIS database at all (this database
-- only ever runs the US Factory app), so the gate that decides "can this
-- email even get in" has to work independently of app_users existing.
--
-- Managed from a new admin-only screen (Setup -> Portfolio Access,
-- backend: app/api/portfolio_access.py) where an admin adds an email and
-- ticks which product(s) it can see. The picker itself
-- (GET /api/v1/portfolio-access/me) only requires a validly signed-in
-- Supabase session -- not an app_users match -- see
-- app/api/deps.py's get_verified_email.
create table if not exists portfolio_access (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  access_factory boolean not null default false,
  access_us_factory boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_portfolio_access_email on portfolio_access(email);

-- Backfill: every existing active app user already has real access to
-- this app (US Factory) today -- this migration must not lock anyone out.
-- "Factory" access is left off for everyone; an admin grants it later via
-- the new Portfolio Access screen, once that product actually exists.
insert into portfolio_access (email, access_factory, access_us_factory)
select email, false, true
from app_users
where is_active = true
on conflict (email) do update set access_us_factory = true;

-- Same defensive default as every table since migration 0009: RLS on with
-- zero policies. The FastAPI service connection owns this table (bypasses
-- RLS regardless), and the frontend never reads/writes it directly via
-- Supabase (it only goes through FastAPI's admin-gated + JWT-verified
-- routes) -- so this is a belt-and-suspenders boundary, not a behaviour
-- change.
alter table portfolio_access enable row level security;
