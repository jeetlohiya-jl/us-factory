"""
Fallback/local OCR adapter using Tesseract (pytesseract). No filenames, no
hardcoded values — this reads actual pixels and returns actual recognized
text. As of the switch to Google Cloud Vision as the default OCR provider
(see google_vision_adapter.py), this adapter is kept as the automatic
fallback the factory uses when Cloud Vision isn't configured (no API key
set) or a request to it fails -- so the app never simply stops offering OCR
just because cloud credentials aren't set up yet in a given environment.

Extraction heuristic: small/low-resolution photos are upscaled first (see
_maybe_upscale), then read with multiple Tesseract page-segmentation modes
merged together (see _read_words) since a real uploaded photo often has the
plate/seal as a small island of text inside a busier frame rather than a
tight crop. Tesseract returns each recognized word plus a per-word
confidence, which identifier_heuristics.extract_from_words then classifies
into the best identifier candidate -- the same matching logic the Cloud
Vision adapter reuses, so both providers apply identical rules on top of
their own (word, confidence) lists. If nothing clears the confidence bar,
we report low_confidence/failed and leave extraction to the user — we
never invent a value.
"""
import io
import logging
import string

import pytesseract
from PIL import Image, ImageOps

from app.adapters.ocr.base import OcrPort, OcrResult
from app.adapters.ocr.identifier_heuristics import extract_from_words
from app.core.config import get_settings

# Windows Tesseract installers don't add tesseract.exe to PATH the way the
# Linux tesseract-ocr package does -- if FACTORY_TESSERACT_CMD is set,
# point pytesseract at that exact binary instead of relying on PATH.
_tesseract_cmd = get_settings().tesseract_cmd
if _tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = _tesseract_cmd

log = logging.getLogger("factory_os.ocr")

# A photo of a whole vehicle/container (rather than a tight crop of just the
# plate/seal) can have the actual identifier occupying a small fraction of
# the frame. If the source photo itself is low-resolution -- a phone photo
# taken from a distance, or a downscaled/compressed upload -- that small
# region can end up only a few pixels tall, which Tesseract cannot read
# reliably regardless of layout mode. Upscaling first (as long as the photo
# wasn't already high-resolution) consistently recovers text that a raw
# pass misses. Below this size on the longer side, we upscale before OCR.
UPSCALE_BELOW_PX = 900
# Cap how far we'll upscale a tiny image -- beyond this the pixels are just
# blown up blur, not new information, and it slows OCR for no benefit.
MAX_UPSCALE_FACTOR = 6

# Tesseract's page-segmentation mode changes how it looks for text blocks.
# --psm 6 (assume one uniform block of text) is the right default for a
# tightly-cropped plate/seal image, but it can miss text that sits as a
# small, isolated island inside a busier photo (the rest of a truck's
# bumper, decals, background). --psm 11/12 ("sparse text") look for text
# anywhere in the image without assuming a single block, which finds that
# same text when --psm 6 finds nothing. Running all three and merging their
# words costs a bit of extra time per upload but meaningfully improves
# real-world photos over relying on a single mode.
OCR_PSM_MODES = (6, 11, 12)


def _maybe_upscale(image: Image.Image) -> Image.Image:
    longest_side = max(image.size)
    if longest_side >= UPSCALE_BELOW_PX:
        return image
    factor = min(MAX_UPSCALE_FACTOR, max(2, round(1500 / max(longest_side, 1))))
    return image.resize((image.width * factor, image.height * factor), Image.LANCZOS)


def _read_words(image: Image.Image) -> list[tuple[str, float]]:
    """Run Tesseract across every mode in OCR_PSM_MODES and merge the
    recognized words. Trailing/leading punctuation (commas, colons, stray
    marks Tesseract sometimes attaches to a token) is stripped before
    classification, since a correctly-read "3657," should still count as
    the digit sequence "3657" rather than being discarded as non-numeric."""
    words: list[tuple[str, float]] = []
    for psm in OCR_PSM_MODES:
        data = pytesseract.image_to_data(
            image, output_type=pytesseract.Output.DICT, config=f"--psm {psm}"
        )
        for i, text in enumerate(data.get("text", [])):
            text = (text or "").strip()
            if not text:
                continue
            try:
                conf = float(data["conf"][i])
            except (ValueError, TypeError):
                conf = -1.0
            if conf < 0:
                continue
            cleaned = text.strip(string.punctuation)
            if not cleaned:
                continue
            words.append((cleaned.upper(), conf / 100.0))
    return words


class TesseractOcrAdapter(OcrPort):
    def extract_identifier(self, image_bytes: bytes, field_type: str) -> OcrResult:
        try:
            image = Image.open(io.BytesIO(image_bytes))
            image = ImageOps.exif_transpose(image)
            image = image.convert("L")  # grayscale improves OCR accuracy for printed labels
            image = _maybe_upscale(image)
        except Exception:
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        try:
            words = _read_words(image)
        except pytesseract.TesseractNotFoundError:
            log.error(
                "Tesseract binary not found on PATH. Install Tesseract-OCR "
                "and either add it to PATH or set FACTORY_TESSERACT_CMD to "
                "its full executable path (e.g. "
                "C:\\Program Files\\Tesseract-OCR\\tesseract.exe on Windows)."
            )
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        return extract_from_words(words, field_type, log=log)
