from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from app.core.config import get_settings
from app.api import (
    reference, inward_vehicle_inspections, me, inward_qc,
    rm_qr, rm_storage, fg_qr, fg_storage, production, ipqc, rqc, locations, vendors, skus,
    machines, material_consumption, users, customer_shipment, shipment_picking,
    outward_vehicle_inspection,
)

settings = get_settings()

app = FastAPI(title="Cirkla Factory OS API", version="0.1.0")

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
app.include_router(customer_shipment.router)
app.include_router(shipment_picking.router)
app.include_router(outward_vehicle_inspection.router)
app.include_router(locations.router)
app.include_router(vendors.router)
app.include_router(skus.router)
app.include_router(me.router)
app.include_router(users.router)


@app.get("/api/v1/health")
def health():
    return {"status": "ok"}
