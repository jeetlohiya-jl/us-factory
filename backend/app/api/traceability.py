"""
Section 15 -- PDF Export by Shipment Number. A single read-only endpoint
that renders the full traceability chain for a Shipment Number as a PDF
(see app/domain/traceability_service.py). Not owned by any one existing
module (it spans Inward Vehicle Inspection through Shipment Picking), so
this is gated on being logged in only, not a specific module permission --
matching a viewer's ability to already see each individual stage were they
to open every module separately.
"""
from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.api.deps import get_current_user
from app.adapters.auth.base import AuthenticatedUser
from app.domain import traceability_service

router = APIRouter(prefix="/api/v1/traceability", tags=["traceability"])


@router.get("/{shipment_number}/pdf")
def export_traceability_pdf(
    shipment_number: str,
    db: Session = Depends(get_db),
    _current_user: AuthenticatedUser = Depends(get_current_user),
):
    shipment_number = (shipment_number or "").strip()
    if not shipment_number:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Shipment Number is required.")
    pdf_bytes = traceability_service.generate_traceability_pdf(db, shipment_number)
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in shipment_number)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="traceability-{safe_name}.pdf"'},
    )
