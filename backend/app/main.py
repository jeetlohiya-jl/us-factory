from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from app.core.config import get_settings
from app.api import deps
from app.db import product_scope  # noqa: F401  (registers the per-unit query scoping)
from app.api import (
    reference, inward_vehicle_inspections, me, inward_qc,
    rm_qr, rm_storage, fg_qr, fg_storage, production, ipqc, rqc, rqc_coa, locations, vendors, skus,
    machines, material_consumption, users, customer_shipment, shipment_picking,
    outward_vehicle_inspection, traceability, hold_release, portfolio_access, customers,
)

settings = get_settings()

app = FastAPI(title="Cirkla Factory OS API", version="0.1.0")

@app.middleware("http")
async def product_context(request, call_next):
    """Which product (Factory / US Factory) this request comes from -- see
    deps.current_product. Set before the route runs so every permission
    check in the request sees it."""
    token = deps.current_product.set((request.headers.get("x-product") or "").strip().lower())
    try:
        return await call_next(request)
    finally:
        deps.current_product.reset(token)


@app.exception_handler(product_scope.CrossUnitReference)
async def _cross_unit_reference(request, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=422, content={"detail": exc.message})


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(settings.local_storage_dir, exist_ok=True)
if settings.storage_provider == "local":
    app.mount("/media", StaticFiles(directory=settings.local_storage_dir), name="media")

app.include_router(reference.router)
app.include_router(inward_vehicle_inspections.router)
app.include_router(inward_qc.router)
app.include_router(rm_qr.router)
app.include_router(rm_storage.router)
app.include_router(machines.router)
app.include_router(material_consumption.router)
app.include_router(fg_qr.router)
app.include_router(fg_storage.router)
app.include_router(production.router)
app.include_router(ipqc.router)
app.include_router(rqc.router)
app.include_router(rqc_coa.router)
app.include_router(customer_shipment.router)
app.include_router(shipment_picking.router)
app.include_router(outward_vehicle_inspection.router)
app.include_router(traceability.router)
app.include_router(locations.router)
app.include_router(vendors.router)
app.include_router(skus.router)
app.include_router(me.router)
app.include_router(users.router)
app.include_router(hold_release.router)
app.include_router(portfolio_access.router)
app.include_router(customers.router)


@app.get("/api/v1/health")
def health():
    return {"status": "ok"}
