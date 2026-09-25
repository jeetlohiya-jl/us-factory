"""
Goods Outward -- "Print Packing List" (2026-09-25).

Replicates Cirkla's own "Last Mile Packing List" document exactly (same
layout, colors, fonts, placement -- built from a real sample the business
supplied), using reportlab, the same PDF library already used for the
Traceability export (traceability_service.py) -- no new dependency.

Two entry points, called in sequence by api/customer_shipment.py:
  1. save_packing_list_fields -- persists the operator-entered fields (PO
     No./PO Date/PI No./Ship To + each line item's UOM/Total Combo) onto
     the Customer Shipment / its line items, so a later reprint needs no
     re-entry.
  2. generate_packing_list_pdf -- pure read-and-render off whatever is
     currently saved, computing the two derived columns (Trays/Combo,
     Total Quantity (Trays)) at render time rather than storing them again.

Everything else on the goods-details table (SKU No., Description, HS Code,
Case Size, Trays/Sleeve, Sleeves/Combo) is read straight from the SKU
Version / SKU Code reference data an operator already filled in once via
the SKU Names admin screen (migration 0058) -- never re-entered here.
"""
import io
import os
import uuid
from decimal import Decimal, InvalidOperation

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Image, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy.orm import Session, joinedload

from app.db import models

ASSETS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets")
LOGO_PATH = os.path.join(ASSETS_DIR, "cirkla_logo.png")
# 2026-09-25 -- no seal/signature asset here by design: the corporate stamp
# and signature are filled in by hand on the printed copy, never replicated
# into the generated PDF. See generate_packing_list_pdf's footer.

# Colors sampled directly from the supplied sample document.
NAVY = colors.HexColor("#1F3864")
SECTION_BG = colors.HexColor("#D9E2F3")
BLACK = colors.black

COMPANY_NAME = "Cirkla Inc."
COMPANY_ADDRESS_LINES = ["16192 Coastal Highway, Lewes, Delaware 19958,", "U.S.A"]

GOODS_COL_WIDTHS_PCT = [0.07, 0.19, 0.08, 0.07, 0.07, 0.13, 0.08, 0.08, 0.08, 0.15]


def _sized_image(path: str, width: float) -> Image:
    """An Image flowable scaled to `width` with its native aspect ratio
    preserved (avoids distorting the logo/seal)."""
    from PIL import Image as PILImage
    with PILImage.open(path) as im:
        ratio = im.height / im.width
    return Image(path, width=width, height=width * ratio)


def _num(v) -> Decimal | None:
    if v is None:
        return None
    if isinstance(v, Decimal):
        return v
    try:
        return Decimal(str(v).strip())
    except (InvalidOperation, ValueError):
        return None


def save_packing_list_fields(
    db: Session,
    shipment: models.CustomerShipment,
    *,
    po_number: str | None,
    po_date,
    pi_number: str | None,
    ship_to_address: str | None,
    line_items: list[dict],
) -> models.CustomerShipment:
    """Persists the operator-entered packing-list fields. Caller commits,
    same convention as every other *_service.py save function here."""
    shipment.po_number = (po_number or "").strip() or None
    shipment.po_date = po_date
    shipment.pi_number = (pi_number or "").strip() or None
    shipment.ship_to_address = (ship_to_address or "").strip() or None

    by_id = {str(li.id): li for li in shipment.line_items}
    for entry in line_items:
        li = by_id.get(str(entry.get("id")))
        if not li:
            continue
        uom = entry.get("uom")
        li.uom = (uom or "").strip() or None
        li.total_combo = _num(entry.get("total_combo"))

    db.flush()
    return shipment


def _kv_row_style():
    return TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Times-Bold"),
        ("FONTNAME", (1, 0), (1, -1), "Times-Roman"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.75, BLACK),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ])


def _section_bar(title: str, width: float):
    style = ParagraphStyle("section", fontName="Helvetica-Bold", fontSize=11, textColor=NAVY, leading=13)
    t = Table([[Paragraph(title, style)]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), SECTION_BG),
        ("GRID", (0, 0), (-1, -1), 0.75, BLACK),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def _addr_paragraph(text: str | None, bold_first_line: bool = False):
    style = ParagraphStyle("addr", fontName="Times-Roman", fontSize=10, leading=12)
    if not text:
        return Paragraph("—", style)
    lines = [l.strip() for l in text.replace("\r\n", "\n").split("\n") if l.strip()]
    return Paragraph("<br/>".join(lines) or "—", style)


def generate_packing_list_pdf(db: Session, shipment: models.CustomerShipment) -> bytes:
    # Re-load with everything needed in one shot.
    shipment = (
        db.query(models.CustomerShipment)
        .options(
            joinedload(models.CustomerShipment.line_items).joinedload(models.CustomerShipmentLineItem.sku_code),
            joinedload(models.CustomerShipment.line_items).joinedload(models.CustomerShipmentLineItem.sku_version),
        )
        .filter(models.CustomerShipment.id == shipment.id)
        .one()
    )
    customer = db.query(models.Customer).filter(models.Customer.name == shipment.customer).first()

    page_size = landscape(A4)
    usable_width = page_size[0] - 20 * mm

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=page_size,
        topMargin=10 * mm, bottomMargin=10 * mm, leftMargin=10 * mm, rightMargin=10 * mm,
    )

    # -- Header: logo left, company name/address centered -------------------
    company_style = ParagraphStyle("company", fontName="Times-Bold", fontSize=11, leading=14, alignment=TA_CENTER)
    company_html = "<br/>".join([COMPANY_NAME] + COMPANY_ADDRESS_LINES)
    header_cells = []
    if os.path.exists(LOGO_PATH):
        header_cells.append(_sized_image(LOGO_PATH, 34 * mm))
    else:
        header_cells.append(Paragraph("CIRKLA", ParagraphStyle("logo", fontName="Helvetica-Bold", fontSize=16)))
    header_cells.append(Paragraph(company_html, company_style))
    header_table = Table([header_cells], colWidths=[45 * mm, usable_width - 45 * mm])
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))

    # -- Title band -----------------------------------------------------------
    title_style = ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=20, textColor=NAVY, alignment=TA_CENTER)
    title_table = Table([[Paragraph("PACKING LIST", title_style)]], colWidths=[usable_width])
    title_table.setStyle(TableStyle([
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))

    # -- Shipment Details -------------------------------------------------
    label_w = usable_width * 0.22
    value_w = usable_width - label_w
    ship_date = shipment.po_date.strftime("%-d-%b-%y") if shipment.po_date else "—"
    consignee_address = customer.address if customer else None
    ship_to = shipment.ship_to_address or consignee_address

    label_style = ParagraphStyle("lbl", fontName="Times-Bold", fontSize=10)
    shipment_rows = [
        [Paragraph("Consignee", label_style), _addr_paragraph(shipment.customer)],
        [Paragraph("Address", label_style), _addr_paragraph(consignee_address)],
        [Paragraph("Ship To", label_style), _addr_paragraph(ship_to)],
        [Paragraph("PO No.", label_style), _addr_paragraph(shipment.po_number)],
        [Paragraph("PO Date", label_style), _addr_paragraph(ship_date if shipment.po_date else None)],
        [Paragraph("PI No.", label_style), _addr_paragraph(shipment.pi_number)],
    ]
    shipment_table = Table(shipment_rows, colWidths=[label_w, value_w])
    shipment_table.setStyle(_kv_row_style())

    # -- Goods Details ------------------------------------------------------
    goods_widths = [usable_width * p for p in GOODS_COL_WIDTHS_PCT]
    hdr_style = ParagraphStyle("gh", fontName="Times-Bold", fontSize=9.5, alignment=TA_CENTER, leading=12)
    cell_c = ParagraphStyle("gc", fontName="Times-Roman", fontSize=9.5, alignment=TA_CENTER, leading=12)
    cell_l = ParagraphStyle("gl", fontName="Times-Roman", fontSize=9.5, alignment=TA_LEFT, leading=12)
    bold_c = ParagraphStyle("gbc", fontName="Times-Bold", fontSize=9.5, alignment=TA_CENTER, leading=12)

    headers = [
        "SKU No.", "Description Of Goods", "HS Code", "UOM", "Total Combo",
        "Case Size (inch)", "Trays/ Sleeve", "Sleeves/ Combo", "Trays/ Combo", "Total Quantity (Trays)",
    ]
    goods_data = [[Paragraph(h, hdr_style) for h in headers]]

    def fmt(v):
        if v is None:
            return "—"
        v = v.quantize(Decimal(1)) if v == v.to_integral_value() else v
        return f"{v:,}"

    total_combo_sum = Decimal(0)
    total_qty_sum = Decimal(0)
    for li in sorted(shipment.line_items, key=lambda x: x.sku_code_snapshot or ""):
        sc = li.sku_code
        sv = li.sku_version
        sku_no = (sc.sku_code if sc and sc.sku_code else None) or li.sku_code_snapshot or "—"
        description = (sc.description if sc else None) or li.sku_code_snapshot or "—"
        hs_code = (sv.hs_code if sv else None) or "—"
        case_size = (sv.case_size if sv else None) or "—"
        trays_per_sleeve = _num(sv.prod_pcs_per_sleeve) if sv else None
        sleeves_per_combo = _num(sv.prod_sleeve_per_case) if sv else None
        trays_per_combo = (
            trays_per_sleeve * sleeves_per_combo
            if trays_per_sleeve is not None and sleeves_per_combo is not None
            else None
        )
        total_combo = li.total_combo
        total_qty = total_combo * trays_per_combo if total_combo is not None and trays_per_combo is not None else None

        if total_combo is not None:
            total_combo_sum += total_combo
        if total_qty is not None:
            total_qty_sum += total_qty

        goods_data.append([
            Paragraph(sku_no, cell_c),
            Paragraph(description, cell_l),
            Paragraph(hs_code, cell_c),
            Paragraph(li.uom or "—", cell_c),
            Paragraph(fmt(total_combo), cell_c),
            Paragraph(case_size, cell_c),
            Paragraph(fmt(trays_per_sleeve), cell_c),
            Paragraph(fmt(sleeves_per_combo), cell_c),
            Paragraph(fmt(trays_per_combo), cell_c),
            Paragraph(fmt(total_qty), cell_c),
        ])

    def fmt_total(v):
        return f"{v:,.0f}" if v else "—"

    goods_data.append([
        Paragraph("Total", bold_c), "", "", "",
        Paragraph(fmt_total(total_combo_sum), bold_c), "", "", "", "",
        Paragraph(fmt_total(total_qty_sum), bold_c),
    ])
    last_row = len(goods_data) - 1

    goods_table = Table(goods_data, colWidths=goods_widths, repeatRows=1)
    goods_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), SECTION_BG),
        ("GRID", (0, 0), (-1, -1), 0.75, BLACK),
        ("SPAN", (0, last_row), (1, last_row)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
    ]))

    # -- Footer: signature line -------------------------------------------
    # 2026-09-25 -- the corporate seal/signature are deliberately NOT
    # rendered here: they get filled in by hand on the printed copy, not
    # replicated onto every auto-generated PDF. Leave "For Cirkla Inc." plus
    # blank space for that physical stamp/signature instead.
    footer_style = ParagraphStyle("footer", fontName="Times-Bold", fontSize=11, alignment=TA_RIGHT)
    footer_inner = [Spacer(1, 10 * mm), Paragraph("For Cirkla Inc.", footer_style), Spacer(1, 20 * mm)]
    footer_flowables = [KeepTogether(footer_inner)]

    story = [
        header_table,
        Table([[""]], colWidths=[usable_width], style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1.5, NAVY)])),
        title_table,
        _section_bar("SHIPMENT DETAILS", usable_width),
        shipment_table,
        _section_bar("GOODS DETAILS", usable_width),
        Spacer(1, 0),
        goods_table,
        *footer_flowables,
    ]

    def _border(canvas, _doc):
        canvas.saveState()
        canvas.setStrokeColor(BLACK)
        canvas.setLineWidth(1.5)
        canvas.rect(
            _doc.leftMargin - 2, _doc.bottomMargin - 2,
            _doc.width + 4, _doc.height + 4,
        )
        canvas.restoreState()

    doc.build(story, onFirstPage=_border, onLaterPages=_border)
    return buf.getvalue()
