"""
Real OCR adapter using Tesseract (pytesseract). No filenames, no hardcoded
values — this reads actual pixels and returns actual recognized text.

Extraction heuristic: Tesseract returns each recognized word plus a
per-word confidence. We look for tokens shaped like the identifier we
expect (container numbers follow the ISO 6346 pattern of 4 letters + 7
digits; truck/seal numbers are looser alphanumeric codes), and fall back to
the highest-confidence alphanumeric token of reasonable length. If nothing
clears the confidence bar, we report low_confidence/failed and leave
extraction to the user — we never invent a value.
"""
import io
import logging
import re

import pytesseract
from PIL import Image, ImageOps

from app.adapters.ocr.base import OcrPort, OcrResult
from app.core.config import get_settings

# Windows Tesseract installers don't add tesseract.exe to PATH the way the
# Linux tesseract-ocr package does -- if FACTORY_TESSERACT_CMD is set,
# point pytesseract at that exact binary instead of relying on PATH.
_tesseract_cmd = get_settings().tesseract_cmd
if _tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = _tesseract_cmd

log = logging.getLogger("factory_os.ocr")

# ISO 6346 shipping container number: 4 letters (owner code + category id) + 7 digits.
CONTAINER_RE = re.compile(r"\b([A-Z]{4}\s?-?\s?\d{6,7})\b")
# Generic alphanumeric identifier (truck registration, seal number, etc.):
# at least one letter and one digit, 4-15 chars, optionally hyphenated.
GENERIC_ID_RE = re.compile(r"\b([A-Z0-9](?:[A-Z0-9-]{2,13})[A-Z0-9])\b")

MIN_CONFIDENCE = {
    "container": 0.55,
    "truck": 0.45,
    "seal": 0.45,
}


def _looks_like_identifier(token: str) -> bool:
    cleaned = token.replace("-", "").replace(" ", "")
    if len(cleaned) < 4:
        return False
    has_letter = any(c.isalpha() for c in cleaned)
    has_digit = any(c.isdigit() for c in cleaned)
    return has_letter and has_digit


def _multi_word_candidates(words: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Vehicle registration plates are very often printed on two separate
    lines/groups -- a letters part (state/series code) and a digits part
    (the number) -- so Tesseract reads them back as two SEPARATE words,
    e.g. "TAV" and "3657", each of which fails _looks_like_identifier on
    its own since neither one word contains both a letter and a digit.
    Without this, a plate OCR read perfectly well (high confidence on
    both words) was reported as a total failure just because no single
    word happened to mix letters and digits.

    Rather than blindly concatenating adjacent words -- which is fragile
    the moment a stray misread token (a crest, an emblem, a bolt) sits
    between the real letters and digits in Tesseract's reading order --
    take the single BEST-confidence all-letters word and the single
    BEST-confidence all-digits word anywhere in the image and join those
    two. This still finds the plate when noise words are present, since
    a stray misread emblem token is rarely the single highest-confidence
    letters-only word once compared against the plate's own bold, crisp
    engraved lettering.

    Both parts are also length-capped at 6 characters -- plate series
    codes and plate numbers are always short, so this keeps a long,
    unrelated but confidently-read word elsewhere in the photo (a
    stencilled company name, a decal, a slogan painted on the truck bed)
    from being mistaken for part of the plate."""
    letters_words = [(w, c) for w, c in words if 2 <= len(w) <= 6 and w.isalpha()]
    digit_words = [(w, c) for w, c in words if 2 <= len(w) <= 6 and w.isdigit()]
    if not letters_words or not digit_words:
        return []
    best_letters = max(letters_words, key=lambda x: x[1])
    best_digits = max(digit_words, key=lambda x: x[1])
    joined = best_letters[0] + best_digits[0]
    avg_conf = (best_letters[1] + best_digits[1]) / 2
    return [(joined, avg_conf)]


class TesseractOcrAdapter(OcrPort):
    def extract_identifier(self, image_bytes: bytes, field_type: str) -> OcrResult:
        try:
            image = Image.open(io.BytesIO(image_bytes))
            image = ImageOps.exif_transpose(image)
            image = image.convert("L")  # grayscale improves OCR accuracy for printed labels
        except Exception:
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        try:
            data = pytesseract.image_to_data(
                image, output_type=pytesseract.Output.DICT, config="--psm 6"
            )
        except pytesseract.TesseractNotFoundError:
            log.error(
                "Tesseract binary not found on PATH. Install Tesseract-OCR "
                "and either add it to PATH or set FACTORY_TESSERACT_CMD to "
                "its full executable path (e.g. "
                "C:\\Program Files\\Tesseract-OCR\\tesseract.exe on Windows)."
            )
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        words = []
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
            words.append((text.upper(), conf / 100.0))

        raw_text = " ".join(w for w, _ in words)

        if not words:
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        best_value = None
        best_conf = 0.0

        if field_type == "container":
            m = CONTAINER_RE.search(raw_text)
            if m:
                candidate = m.group(1).replace(" ", "")
                # find the confidence of the words that make up this match
                matching = [c for w, c in words if w.replace(" ", "") in candidate or candidate in w]
                best_value = candidate
                best_conf = max(matching) if matching else 0.5

        if best_value is None:
            # Generic fallback: the best-scoring candidate that looks like an
            # identifier, considering both single words (a seal number that
            # really is one contiguous alphanumeric code) and 2-3 word runs
            # joined together (a vehicle plate split across separate words
            # by Tesseract -- see _multi_word_candidates).
            candidates = [(w, c) for w, c in words if _looks_like_identifier(w)]
            candidates += _multi_word_candidates(words)
            if candidates:
                candidates.sort(key=lambda x: x[1], reverse=True)
                best_value, best_conf = candidates[0]

        threshold = MIN_CONFIDENCE.get(field_type, 0.5)

        if best_value is None:
            log.warning(
                "OCR found no identifier-shaped candidate for field_type=%s. "
                "Words Tesseract actually read (word, confidence): %s",
                field_type, [(w, round(c, 2)) for w, c in words],
            )
            return OcrResult(raw_text=raw_text, extracted_value=None, confidence=0.0, status="failed")
        if best_conf < threshold:
            log.warning(
                "OCR candidate for field_type=%s below confidence threshold "
                "(%.2f < %.2f): best_value=%r. All words read: %s",
                field_type, best_conf, threshold, best_value,
                [(w, round(c, 2)) for w, c in words],
            )
            return OcrResult(raw_text=raw_text, extracted_value=best_value, confidence=best_conf, status="low_confidence")
        return OcrResult(raw_text=raw_text, extracted_value=best_value, confidence=best_conf, status="success")
