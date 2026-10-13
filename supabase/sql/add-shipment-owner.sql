-- Per-admin shipment ownership.
-- Run this in the Supabase SQL Editor AFTER both admin users exist in Auth
-- (create the second admin first with: npm run setup:admin -- <email> <password>).
--
-- What it does:
--   1. Adds shipments.owner_id (the admin who owns the shipment).
--   2. Assigns the existing shipments:
--        - the 5 listed below  -> support@shiptrackgl.com
--        - every other shipment -> shiptrackglobal585@gmail.com
--   3. It is safe to re-run: it only fills rows where owner_id is still NULL.

alter table public.shipments
  add column if not exists owner_id uuid references auth.users(id) on delete set null;

create index if not exists shipments_owner_id_idx on public.shipments (owner_id);

do $$
declare
  admin1_email text := 'support@shiptrackgl.com';
  admin2_email text := 'shiptrackglobal585@gmail.com';
  admin1_id uuid;
  admin2_id uuid;
  n_admin1 int;
  n_toolbox int;
  n_admin2 int;
begin
  select id into admin1_id from auth.users where lower(email) = lower(admin1_email);
  select id into admin2_id from auth.users where lower(email) = lower(admin2_email);

  if admin1_id is null then
    raise exception 'No auth user found for %', admin1_email;
  end if;
  if admin2_id is null then
    raise exception 'No auth user found for % - create it first with npm run setup:admin', admin2_email;
  end if;

  -- Admin 1: the four shipments we know by code
  update public.shipments
  set owner_id = admin1_id
  where owner_id is null
    and upper(code) in ('SHPYC20VD', 'SHP9TOPSH', 'SHP08CGLW', 'SHPG2E672');
  get diagnostics n_admin1 = row_count;

  -- Admin 1: "Tool box" (its code was not provided, so it is matched by name)
  update public.shipments
  set owner_id = admin1_id
  where owner_id is null
    and lower(trim(name)) = 'tool box';
  get diagnostics n_toolbox = row_count;

  -- Admin 2: everything else
  update public.shipments
  set owner_id = admin2_id
  where owner_id is null;
  get diagnostics n_admin2 = row_count;

  raise notice 'Assigned % shipment(s) by code + % "Tool box" shipment(s) to %', n_admin1, n_toolbox, admin1_email;
  raise notice 'Assigned % remaining shipment(s) to %', n_admin2, admin2_email;
end $$;
