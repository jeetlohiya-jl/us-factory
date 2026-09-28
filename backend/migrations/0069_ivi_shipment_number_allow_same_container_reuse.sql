-- Fixes a regression from migration 0068: "Inward remaining" now opens a
-- fresh Inward Inspection for a Goods Receipt entry that's already been
-- inwarded once, and that new inspection inherits the SAME shipment_number
-- as the entry's own already-approved first inspection (both are simply
-- the container's shipment number, e.g. "V8" -- see create_draft in
-- inward_vehicle_inspections.py). That collided with migration 0010's
-- uq_ivi_shipment_number, which requires every non-blank shipment_number to
-- be globally unique across the whole table.
--
-- The fix is deliberately narrow, per the actual (rare) real-world case:
-- the SAME container can legitimately arrive in more than one truck, and
-- each of ITS deliveries should be allowed to share ITS OWN shipment
-- number -- but two genuinely DIFFERENT containers (different Goods
-- Receipt entries, or a standalone US Factory inspection) must still never
-- collide on the same shipment number, exactly as migration 0010 intended.
-- (goods_receipt_entries' own uniqueness constraint is scoped per-PO --
-- uq_goods_receipt_entries_container_sku -- so two different POs can
-- legitimately reuse the same shipment number for unrelated containers;
-- this rule has to keep telling those apart from a true repeat delivery.)
--
-- A plain (or partial) unique index can only express "no two rows share
-- this value" or "...among rows matching this fixed predicate" -- neither
-- can express "no two rows share this value UNLESS they belong to the same
-- entry", which is what's actually needed here. That requires comparing a
-- candidate row against every other row sharing its value, so this becomes
-- a trigger (the first in this codebase; every other cross-row invariant
-- so far has been enforced inside a plpgsql RPC function instead, but
-- shipment_number is written directly by the FastAPI backend via
-- SQLAlchemy -- create_draft and the PUT /{id} update route -- not through
-- an RPC, so a trigger is the only place that covers every write path
-- atomically without duplicating the check in application code and racing
-- concurrent requests).
--
-- Additive and re-runnable.

drop index if exists uq_ivi_shipment_number;
create index if not exists idx_ivi_shipment_number
  on inward_vehicle_inspections (shipment_number) where shipment_number != '';

create or replace function ivi_enforce_shipment_number_uniqueness() returns trigger
  language plpgsql as $$
declare
  _group uuid;
  _conflict uuid;
begin
  if coalesce(btrim(NEW.shipment_number), '') = '' then
    return NEW;
  end if;
  -- Every row's "identity group" is the Goods Receipt entry it belongs to,
  -- or -- for a standalone US Factory inspection with no source entry --
  -- itself alone (NEW.id is always already populated here: SQLAlchemy
  -- assigns it client-side before the INSERT is sent). Two rows may share
  -- a shipment_number only when they're in the same group.
  _group := coalesce(NEW.source_goods_receipt_entry_id, NEW.id);
  select id into _conflict
    from inward_vehicle_inspections
    where shipment_number = NEW.shipment_number
      and id <> NEW.id
      and coalesce(source_goods_receipt_entry_id, id) <> _group
    limit 1;
  if _conflict is not null then
    raise exception using errcode = '23505',
      message = format('Shipment Number "%s" is already used by another inspection.', NEW.shipment_number);
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_ivi_shipment_number_unique on inward_vehicle_inspections;
create trigger trg_ivi_shipment_number_unique
  before insert or update of shipment_number, source_goods_receipt_entry_id
  on inward_vehicle_inspections
  for each row execute function ivi_enforce_shipment_number_uniqueness();
