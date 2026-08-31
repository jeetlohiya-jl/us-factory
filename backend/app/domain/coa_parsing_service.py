"""
COA (Certificate of Analysis) parsing — upload a COA PDF/JPG for a manual
Inward QC record (Glue, Soaker Pad, Polybag, CFB) and get back suggested
values for that category's Observation attributes, instead of retyping
every number from the vendor's document by hand.

Mapping model: an Inward QC category has a fixed, ordered set of
InwardQcAttributeDefinition rows (label, field_type, is_required — e.g.
Soaker Pad has "Weight (g)", "Length (mm) (±2)", "Absorption Rate (0.2%
Saline Water, ml) (±5)", "Color (Beige / White)", ...). A real-world COA is
a loose table of "parameter: value" rows using the vendor's own wording,
which never matches our attribute labels character-for-character and has
no guaranteed structure Claude/pdfplumber can rely on as a real table. So
rather than a rigid table-column parser, this does per-line label matching:
for each attribute definition, strip its label down to the meaningful
content words (dropping units/tolerances in parentheses), then scan the
document's text lines for the line whose words best overlap that core
label, and pull the value out of that line (first number for a numeric
field, matching dropdown option or trailing text otherwise).

This is a heuristic, same spirit as the existing Tesseract identifier
adapter: it never invents a value, reports "not_found" when nothing clears
the bar, and every extracted value lands in the Observations table as an
editable, overridable suggestion — never a silent auto-submit. Works on
text-layer PDFs directly (pdfplumber); falls back to rasterizing pages and
running real OCR (the same Tesseract engine used for photos, via
pdf2image + pytesseract) for scanned/image-based COAs and plain JPG/PNG
uploads, so both paths go through one shared line-matching step.
"""
from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass

import pdfplumber
import pytesseract
from PIL import Image, ImageOps

from app.core.config import get_settings

log = logging.getLogger("factory_os.coa_parsing")

_settings = get_settings()
# Same Windows-vs-Linux PATH gap as the photo OCR adapter (see
# app/adapters/ocr/tesseract_adapter.py) -- set explicitly here too since
# this module also calls pytesseract directly for scanned COAs/images.
if _settings.tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = _settings.tesseract_cmd

PDF_EXTS = {"pdf"}
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "bmp", "tiff"}

# A page with fewer than this many extractable characters is treated as a
# scanned/image PDF page (no real text layer) rather than a text PDF.
MIN_TEXT_CHARS_PER_PAGE = 20

NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?\s*%?")

# Words that carry no matching signal — units, tolerance markers, generic
# filler that appears in almost every label and would make every line look
# like a match if left in.
STOPWORDS = {
    "mm", "ml", "cp", "kg", "g", "microns", "units", "unit", "of", "the",
    "on", "and", "avg", "rate", "no", "no.",
}

# Bare unit tokens that appear as a WHOLE parenthetical, e.g. "(mm)", "(g)":
# safe to drop the entire group. A tolerance marker like "(±2)" or "(±5)"
# is dropped the same way, matched separately below.
_UNIT_PAREN_TOKENS = {"mm", "g", "kg", "ml", "cp", "microns", "units", "unit", "cm", "%"}
_TOLERANCE_PAREN_RE = re.compile(r"^\s*±?\s*\d+(\.\d+)?\s*%?\s*$")


def _extension(filename: str) -> str:
    return (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""


def _core_words(label: str) -> list[str]:
    """'Absorption Rate (0.2% Saline Water, ml) (±5)' -> ['absorption','saline','water']

    Only drops a parenthetical group when it's PURELY a unit or a tolerance
    marker (e.g. "(mm)", "(±2)", "(g)") -- a descriptive parenthetical like
    "(Normal Water, ml)" is kept (minus the unit token inside it, filtered
    out below by STOPWORDS), because "Normal" vs "Saline" there is the only
    thing that tells two otherwise-identically-worded attributes apart."""
    def _strip_if_unit_or_tolerance(m: re.Match) -> str:
        inner = m.group(1).strip()
        if _TOLERANCE_PAREN_RE.match(inner) or inner.lower() in _UNIT_PAREN_TOKENS:
            return " "
        return " " + inner + " "

    cleaned = re.sub(r"\(([^)]*)\)", _strip_if_unit_or_tolerance, label)
    words = re.findall(r"[a-zA-Z]+", cleaned.lower())
    return [w for w in words if w not in STOPWORDS and len(w) > 1]


def extract_text(content: bytes, filename: str, content_type: str | None) -> str:
    """Real text extraction / OCR — never a placeholder. Returns the
    document's text as newline-separated lines, in reading order."""
    ext = _extension(filename)
    is_pdf = ext in PDF_EXTS or (content_type or "") == "application/pdf"

    if is_pdf:
        lines: list[str] = []
        scanned_pages: list[int] = []
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                if len(text.strip()) < MIN_TEXT_CHARS_PER_PAGE:
                    scanned_pages.append(i)
                else:
                    lines.extend(l for l in text.splitlines() if l.strip())

                # Also pull any text sitting inside the page's own tables —
                # pdfplumber's line-based extract_text() can miss text that
                # only exists inside table cells on some vendor COA layouts.
                for table in page.extract_tables() or []:
                    for row in table:
                        cells = [str(c) for c in row if c]
                        if cells:
                            lines.append(" ".join(cells))

        if scanned_pages:
            # No text layer on some/all pages -> rasterize just those pages
            # and run real OCR on them, same engine as the photo pipeline.
            from pdf2image import convert_from_bytes
            from pdf2image.exceptions import PDFInfoNotInstalledError
            try:
                images = convert_from_bytes(content, poppler_path=_settings.poppler_path)
            except PDFInfoNotInstalledError:
                log.error(
                    "poppler (pdftoppm/pdfinfo) not found. Install poppler "
                    "and either add its bin/ folder to PATH or set "
                    "FACTORY_POPPLER_PATH to that folder (e.g. "
                    "C:\\poppler-24.x\\Library\\bin on Windows)."
                )
                images = []
            for i in scanned_pages:
                if i < len(images):
                    lines.extend(_ocr_image(images[i]).splitlines())
        return "\n".join(l for l in lines if l.strip())

    # Plain image upload (JPG/PNG/etc of a printed or scanned COA page).
    image = Image.open(io.BytesIO(content))
    return _ocr_image(image)


def _ocr_image(image: Image.Image) -> str:
    image = ImageOps.exif_transpose(image).convert("L")
    try:
        return pytesseract.image_to_string(image, config="--psm 6")
    except pytesseract.TesseractNotFoundError:
        log.error(
            "Tesseract binary not found on PATH -- COA image/scanned-PDF "
            "OCR cannot run. Install Tesseract-OCR and either add it to "
            "PATH or set FACTORY_TESSERACT_CMD to its full executable path."
        )
        return ""


@dataclass
class AttrDefLike:
    id: object
    label: str
    field_type: str
    options_json: list[str] | None


def parse_coa_values(text: str, attribute_defs: list[AttrDefLike]) -> list[dict]:
    """For each attribute definition, find the best-matching line in the
    document and pull a value out of it. Returns one suggestion per
    attribute, always — status is "matched" or "not_found" so the frontend
    can show exactly which fields it filled in versus left for manual
    entry, mirroring how OCR-on-photo failures are already surfaced."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    lines_lower = [l.lower() for l in lines]

    results = []
    for d in attribute_defs:
        core = _core_words(d.label)
        best_line, best_score = None, 0.0
        if core:
            for line, line_lower in zip(lines, lines_lower):
                hits = sum(1 for w in core if w in line_lower)
                score = hits / len(core)
                if score > best_score:
                    best_score, best_line = score, line

        value = None
        # Require at least half the label's meaningful words to appear on
        # the line before trusting it — otherwise "not_found" is honest,
        # a wrong guess from a vendor's differently-worded COA is not.
        if best_line and best_score >= 0.5:
            value = _extract_value(best_line, d)

        results.append({
            "attribute_definition_id": d.id,
            "label": d.label,
            "extracted_value": value,
            "status": "matched" if value else "not_found",
            "source_line": best_line if value else None,
        })
    return results


def _extract_value(line: str, d: AttrDefLike) -> str | None:
    if d.field_type == "number":
        # Prefer a number that isn't part of the label itself (e.g. skip
        # "0.2%" inside "Absorption Rate (0.2% Saline...)" style labels
        # that leaked into the line) by taking the LAST number on the
        # line — vendor COA rows are almost always "Parameter .... value".
        matches = NUMBER_RE.findall(line)
        return matches[-1].strip() if matches else None

    if d.field_type == "dropdown" and d.options_json:
        for opt in d.options_json:
            if opt.lower() in line.lower():
                return opt
        return None

    # Free-text field (e.g. Color, Base Material, Fold on Pad): take
    # whatever follows the last separator on the line as the value.
    for sep in (":", "-", "\t"):
        if sep in line:
            tail = line.rsplit(sep, 1)[-1].strip()
            if tail:
                return tail
    # No separator — nothing safe to extract without risking grabbing the
    # label text itself back as the "value".
    return None
