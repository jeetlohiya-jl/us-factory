"""
Shared vendor_name -> vendor_id resolution (see migration 0010 and the
database audit for the full reasoning). vendor_name is the permanent
display snapshot everywhere it already appears; vendor_id is the real
relationship, resolved here at write time from the exact same
(category, name) match the Vendors dropdown already guarantees a match
for -- the same match qr_generation_service.py used to have to redo at
read time via fuzzy text lookup.
"""
from sqlalchemy.orm import Session

from app.db import models


def resolve_vendor_id(db: Session, category: str | None, vendor_name: str | None):
    if not category or not vendor_name:
        return None
    vendor = (
        db.query(models.Vendor)
        .filter(models.Vendor.category == category, models.Vendor.name == vendor_name)
        .first()
    )
    return vendor.id if vendor else None
