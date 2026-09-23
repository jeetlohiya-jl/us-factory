"""
Which working unit the current request belongs to: Factory or US Factory.

Factory and US Factory are two independent working units -- separate
records, sequence numbers, master data and permissions -- that share one
database and several screens. The frontend sends the unit on every request
(X-Product header); main.py's middleware puts it in `current_product` for
the duration of the request. Everything that needs to know the unit reads it
from here:

  - app/db/product_scope.py: every ORM query only sees the current unit's
    rows, and every new row is stamped with it.
  - app/domain/id_counters.py: each unit has its own number sequences.
  - app/api/deps.py: permission checks use the unit's own permission rows.

No header (or anything other than "factory") means US Factory -- exactly the
behaviour every request had before the two units were separated.
"""
import contextvars

current_product: contextvars.ContextVar[str] = contextvars.ContextVar("current_product", default="")

FACTORY = "factory"
US_FACTORY = "us_factory"


def current_unit() -> str:
    """'factory' or 'us_factory' -- the value stored in every `product` column."""
    return FACTORY if current_product.get() == FACTORY else US_FACTORY
