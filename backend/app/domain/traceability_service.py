"""
Section 15 -- PDF Export by Shipment Number, across the full traceability
chain:

  Inward Vehicle Inspection -> Inward QC -> RM QR Generation -> RM Storage
  -> Material Consumption -> Production -> IPQC -> RQC -> FG QR Generation
  -> FG Storage -> Customer Shipment -> Shipment Picking

Every stage is looked up independently by Shipment Number and rendered if
found -- a shipment that only got as far as, say, Inward QC still produces
a valid (short) PDF instead of erroring, per the task's explicit "tolerant
of incomplete stages" requirement. Nothing here writes to the database;
this is a pure read-and-render.
"""
import io
from datetime import datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from sqlalchemy.orm import Session, joinedload

from app.db import models


def _kv_table(rows: list[tuple[str, str]]) -> Table:
    data = [[r[0], r[1] or "—"] for r in rows]
    t = Table(data, colWidths=[55 * mm, 110 * mm])
    t.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#555555")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#e0e0e0")),
    ]))
    return t


def _list_table(header: list[str], rows: list[list[str]]) -> Table:
    data = [header] + [[c or "—" for c in row] for row in rows]
    t = Table(data, repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0ec")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#dddddd")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def _gather(db: Session, shipment_number: str) -> dict:
    """One shot, best-effort lookup of every stage by shipment_number. Each
    key is None/[] when that stage was never reached for this shipment --
    the caller renders "Not recorded yet" rather than failing."""
    ivi = (
        db.query(models.InwardVehicleInspection)
        .filter(models.InwardVehicleInspection.shipment_number == shipment_number)
        .first()
    )
    qc = (
        db.query(models.InwardQcRecord)
        .options(joinedload(models.InwardQcRecord.sku_code))
        .filter(models.InwardQcRecord.shipment_number == shipment_number)
        .first()
    )
    rm_qr = (
        db.query(models.QrGenerationRecord)
        .filter(models.QrGenerationRecord.qr_type == "rm", models.QrGenerationRecord.shipment_number == shipment_number)
        .first()
    )
    rm_pallets = (
        db.query(models.Pallet)
        .options(joinedload(models.Pallet.storage_record).joinedload(models.StorageRecord.location))
        .filter(models.Pallet.pallet_type == "rm", models.Pallet.shipment_number == shipment_number)
        .order_by(models.Pallet.display_id)
        .all()
    )
    rm_pallet_ids = [p.id for p in rm_pallets]
    material_consumptions = (
        db.query(models.MaterialConsumption)
        .join(models.MaterialConsumptionMachineEntry)
        .join(models.MaterialConsumptionPallet)
        .filter(models.MaterialConsumptionPallet.pallet_id.in_(rm_pallet_ids), models.MaterialConsumptionPallet.role == "primary")
        .distinct()
        .all()
    ) if rm_pallet_ids else []
    production_run = next((mc.production_run for mc in material_consumptions if mc.production_run), None)
    ipqc = (
        db.query(models.IpqcRecord)
        .filter(models.IpqcRecord.shipment_number == shipment_number)
        .first()
    )
    rqc = (
        db.query(models.RqcRecord)
        .filter(models.RqcRecord.shipment_number == shipment_number)
        .first()
    )
    fg_qr = (
        db.query(models.QrGenerationRecord)
        .filter(models.QrGenerationRecord.qr_type == "fg", models.QrGenerationRecord.shipment_number == shipment_number)
        .first()
    )
    fg_pallets = (
        db.query(models.Pallet)
        .options(joinedload(models.Pallet.storage_record).joinedload(models.StorageRecord.location), joinedload(models.Pallet.source_machine))
        .filter(models.Pallet.pallet_type == "fg", models.Pallet.shipment_number == shipment_number)
        .order_by(models.Pallet.display_id)
        .all()
    )
    customer_shipment = (
        db.query(models.CustomerShipment)
        .options(joinedload(models.CustomerShipment.line_items))
        .filter(models.CustomerShipment.shipment_number == shipment_number)
        .first()
    )
    picking_requests = (
        db.query(models.ShipmentPickingRequest)
        .options(joinedload(models.ShipmentPickingRequest.picks))
        .filter(models.ShipmentPickingRequest.shipment_number == shipment_number)
        .all()
    )
    return dict(
        ivi=ivi, qc=qc, rm_qr=rm_qr, rm_pallets=rm_pallets,
        material_consumptions=material_consumptions, production_run=production_run,
        ipqc=ipqc, rqc=rqc, fg_qr=fg_qr, fg_pallets=fg_pallets,
        customer_shipment=customer_shipment, picking_requests=picking_requests,
    )


def generate_traceability_pdf(db: Session, shipment_number: str) -> bytes:
    data = _gather(db, shipment_number)
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=16, spaceAfter=4)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontSize=11.5, spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#1a1a1a"))
    normal = styles["Normal"]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, topMargin=18 * mm, bottomMargin=16 * mm, leftMargin=16 * mm, rightMargin=16 * mm,
    )
    story: list = []
    story.append(Paragraph("Shipment Traceability Report", h1))
    story.append(Paragraph(f"Shipment Number: <b>{shipment_number}</b>", normal))
    story.append(Paragraph(f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", normal))
    story.append(Spacer(1, 6))

    def stage_missing(title: str):
        story.append(Paragraph(title, h2))
        story.append(Paragraph("Not recorded yet for this Shipment Number.", normal))

    # 1. Inward Vehicle Inspection
    ivi = data["ivi"]
    if ivi:
        story.append(Paragraph("1. Inward Vehicle Inspection", h2))
        story.append(_kv_table([
            ("Category", ivi.category), ("Status", ivi.status),
            ("Vendor", ivi.vendor_name), ("Truck Number", ivi.truck_number),
            ("Container Number", ivi.container_number), ("Invoice Number", ivi.invoice_number),
        ]))
    else:
        stage_missing("1. Inward Vehicle Inspection")

    # 2. Inward QC
    qc = data["qc"]
    if qc:
        story.append(Paragraph("2. Inward QC", h2))
        story.append(_kv_table([
            ("Status", qc.status), ("Category", qc.category),
            ("SKU Code", qc.sku_code_snapshot), ("Quantity", f"{qc.quantity} {qc.quantity_unit}" if qc.quantity is not None else None),
        ]))
    else:
        stage_missing("2. Inward QC")

    # 3. RM QR Generation + RM Storage
    rm_qr = data["rm_qr"]
    rm_pallets = data["rm_pallets"]
    if rm_qr or rm_pallets:
        story.append(Paragraph("3. RM QR Generation &amp; RM Storage", h2))
        if rm_qr:
            story.append(_kv_table([("Batch", rm_qr.batch_display_id), ("Status", rm_qr.status), ("Quantity", str(rm_qr.quantity))]))
        if rm_pallets:
            story.append(_list_table(
                ["Pallet ID", "Status", "Location"],
                [[p.display_id, p.lifecycle_status, p.storage_record.location.display_id if p.storage_record and p.storage_record.location else "—"] for p in rm_pallets],
            ))
    else:
        stage_missing("3. RM QR Generation & RM Storage")

    # 4. Material Consumption / Production
    mcs = data["material_consumptions"]
    run = data["production_run"]
    if mcs or run:
        story.append(Paragraph("4. Material Consumption &amp; Production", h2))
        if run:
            story.append(_kv_table([
                ("Production Run", run.run_number), ("Status", run.status),
                ("Shift", run.shift), ("Date", run.production_date),
                ("Machines", ", ".join(sorted({rm.machine.code for rm in run.machines if rm.machine})) or None),
            ]))
        if mcs:
            story.append(_list_table(
                ["Material Consumption", "Status", "Date"],
                [[mc.id.hex[:8], mc.status, mc.consumption_date] for mc in mcs],
            ))
    else:
        stage_missing("4. Material Consumption & Production")

    # 5. IPQC
    ipqc = data["ipqc"]
    if ipqc:
        story.append(Paragraph("5. IPQC", h2))
        story.append(_kv_table([("Status", ipqc.status), ("Batch Code", ipqc.batch_code), ("Manufacturer", ipqc.manufacturer)]))
    else:
        stage_missing("5. IPQC")

    # 6. RQC
    rqc = data["rqc"]
    if rqc:
        story.append(Paragraph("6. RQC", h2))
        story.append(_kv_table([
            ("Status", rqc.status), ("Overall Result", rqc.overall_result),
            ("FG Pallets Generated", str(rqc.fg_pallets_generated) if rqc.fg_pallets_generated is not None else None),
            ("Table/Person Number", rqc.table_person_number),
        ]))
    else:
        stage_missing("6. RQC")

    # 7. FG QR Generation + FG Storage
    fg_qr = data["fg_qr"]
    fg_pallets = data["fg_pallets"]
    if fg_qr or fg_pallets:
        story.append(Paragraph("7. FG QR Generation &amp; FG Storage", h2))
        if fg_qr:
            story.append(_kv_table([("Batch", fg_qr.batch_display_id), ("Status", fg_qr.status), ("Quantity", str(fg_qr.quantity)), ("Combo Number", str(fg_qr.combo_number) if fg_qr.combo_number else None)]))
        if fg_pallets:
            story.append(_list_table(
                ["Pallet ID", "Batch Code", "Machine", "Status", "Location"],
                [[
                    p.display_id, p.batch_code, p.source_machine.code if p.source_machine else "—",
                    p.lifecycle_status, p.storage_record.location.display_id if p.storage_record and p.storage_record.location else "—",
                ] for p in fg_pallets],
            ))
    else:
        stage_missing("7. FG QR Generation & FG Storage")

    # 8. Customer Shipment + Shipment Picking
    cs = data["customer_shipment"]
    picks = data["picking_requests"]
    if cs or picks:
        story.append(Paragraph("8. Customer Shipment &amp; Shipment Picking", h2))
        if cs:
            story.append(_kv_table([("Container Number", cs.container_number), ("Customer", cs.customer)]))
        if picks:
            story.append(_list_table(
                ["SKU", "Pallets Required", "Pallets Picked", "Status"],
                [[r.sku_code_snapshot, str(r.pallets_required), str(len(r.picks)), r.status] for r in picks],
            ))
    else:
        stage_missing("8. Customer Shipment & Shipment Picking")

    doc.build(story)
    return buf.getvalue()
