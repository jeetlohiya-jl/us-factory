"""
Keeps Factory and US Factory records apart in every ORM query.

Every SELECT the ORM runs -- route queries, relationship loads, counts,
existence checks inside domain services -- gets
`WHERE <table>.product = <current unit>` for each ProductScoped table it
touches (SQLAlchemy's with_loader_criteria). So a Factory request can never
see, match, number against, scan or edit a US Factory record, or the
reverse, without any route having to remember to filter. New rows are
stamped by the column default (models.ProductScoped).

Examples of what this covers without any other code change:
  - Production Runs are found-or-created per unit + date + shift, so the two
    units' Material Consumption on the same shift never merge.
  - Scanning a pallet, location or machine from the other unit resolves to
    "not found".
  - Duplicate checks (shipment numbers, SKU names, machine codes...) and the
    batch-code combo count only look at the current unit.

Bulk UPDATE/DELETE statements get the same criteria. Pass
execution_options(all_products=True) only for deliberate cross-unit reads
(none exist today).
"""
from sqlalchemy import event
from sqlalchemy.orm import Session, with_loader_criteria

from app.core.product import current_unit
from app.db.models import ProductScoped


@event.listens_for(Session, "do_orm_execute")
def _scope_to_current_product(state):
    if state.execution_options.get("all_products"):
        return
    if not (state.is_select or state.is_update or state.is_delete):
        return
    unit = current_unit()
    state.statement = state.statement.options(
        with_loader_criteria(ProductScoped, lambda cls: cls.product == unit, include_aliases=True)
    )


class CrossUnitReference(Exception):
    """A record of one unit would point at a record of the other unit (e.g. a
    Factory Material Consumption given a US Factory machine id). Turned into
    a 422 by main.py's exception handler."""
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _scoped_tables() -> dict:
    return {m.__tablename__: m for m in ProductScoped.__subclasses__()}


@event.listens_for(Session, "before_flush")
def _reject_cross_unit_references(session, flush_context, instances):
    """Reads are scoped automatically, but a route can also store an id it
    was sent without ever loading that row (machine_id, sku_code_id, ...).
    Before anything is written, every changed foreign key that points at a
    per-unit table must point at a row of the CURRENT unit."""
    unit = current_unit()
    scoped = _scoped_tables()
    wanted: dict[str, set] = {}
    for obj in list(session.new) + list(session.dirty):
        mapper = getattr(obj, "__mapper__", None)
        if mapper is None:
            continue
        state = obj._sa_instance_state
        for col in mapper.columns:
            for fk in col.foreign_keys:
                target = fk.column.table.name
                if target not in scoped:
                    continue
                attr = mapper.get_property_by_column(col).key
                if obj not in session.new and not state.attrs[attr].history.has_changes():
                    continue
                value = getattr(obj, attr, None)
                if value is not None:
                    wanted.setdefault(target, set()).add(value)
    for table, ids in wanted.items():
        model = scoped[table]
        foreign = (
            session.query(model.id)
            .filter(model.id.in_(ids), model.product != unit)
            .execution_options(all_products=True)
            .first()
        )
        if foreign:
            label = table.replace("_", " ")
            raise CrossUnitReference(
                f"That {label[:-1] if label.endswith('s') else label} belongs to the other unit "
                f"({'US Factory' if unit == 'factory' else 'Factory'}) and can't be used here."
            )
