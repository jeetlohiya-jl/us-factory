"""
Atomic "next sequence number" allocation for every human-facing ID this app
issues (pallet display_ids, QR batch numbers, auto shipment numbers,
Production Run numbers).

Every one of these used to be `SELECT count(*) ... ; seq = count + 1`,
computed in Python between two separate round trips with no lock held in
between -- two concurrent requests reading the same count before either one
commits its insert both compute the same "next" number, so the second
request's row silently collides with (or duplicates) the first's. That was
already a known risk under plain concurrent FastAPI requests; it gets more
likely once more of the app is reachable from multiple browser tabs at once
(see the Phase 0 hybrid-architecture audit).

Fixed with one atomic UPSERT per counter key: `INSERT ... ON CONFLICT DO
UPDATE ... RETURNING` takes Postgres's normal row lock on the counter row
as part of the single statement, so two concurrent callers for the same key
are serialized by Postgres itself -- one of them simply waits for the
other's row lock to release, then reads the already-incremented value.
There's no window between "read the count" and "write the row" for a second
request to land in, because there's only one statement, not two.

`counter_key` namespaces every distinct sequence this app hands out:
  - "pallet:<prefix>"      e.g. "pallet:US-PLT"   (see pallet_service.prefix_for_category)
  - "qr_batch:<qr_type>"   e.g. "qr_batch:rm"
  - "shipment:<category>"  e.g. "shipment:pad"
  - "production_run"       one single global counter
"""
from sqlalchemy import text
from sqlalchemy.orm import Session


def next_seq(db: Session, counter_key: str) -> int:
    """Atomically allocates and returns the next integer for counter_key,
    starting at 1 the first time a given key is used. Must be called inside
    the same transaction that goes on to use the returned number: this is a
    plain row update, not a Postgres SEQUENCE, so if the caller's
    transaction later rolls back, this row's increment rolls back with it --
    the number was never actually issued (nothing that used it was
    persisted either), and the next caller gets it instead of a gap."""
    row = db.execute(
        text(
            """
            insert into display_id_counters (counter_key, next_value)
            values (:key, 2)
            on conflict (counter_key)
            do update set next_value = display_id_counters.next_value + 1
            returning next_value - 1
            """
        ),
        {"key": counter_key},
    ).first()
    return int(row[0])
