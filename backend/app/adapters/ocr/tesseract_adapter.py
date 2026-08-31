"""
Real OCR adapter using Tesseract (pytesseract). No filenames, no hardcoded
values — this reads actual pixels and returns actual recognized text.

Extraction heuristic: small/low-resolution photos are upscaled first (see
_maybe_upscale), then read with multiple Tesseract page-segmentation modes
merged together (see _read_words) since a real uploaded photo often has the
plate/seal as a small island of text inside a busier frame rather than a
tight crop. Tesseract returns each recognized word plus a per-word
confidence. We look for tokens shaped like the identifier we expect
(container numbers follow the ISO 6346 pattern of 4 letters + 7 digits;
truck/seal numbers are looser alphanumeric codes), and fall back to the
highest-confidence alphanumeric token of reasonable length. If nothing
clears the confidence bar, we report low_confidence/failed and leave
extraction to the user — we never invent a value.
"""
import io
import logging
import re
import string

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
# The digit run is accepted down to 4 digits (not just 6-7) because a real
# photo of the whole container door -- rather than a tight crop of just the
# number -- often has that number small enough in the frame that Tesseract
# reads only the first several digits of it correctly and drops the rest
# (confirmed against a real container photo: Tesseract read "SEGU 6576" for
# an actual "SEGU 657685" -- the leading 4 digits, correctly adjacent to the
# 4-letter owner code, with the trailing 2 digits lost). Still requiring the
# letters and digits to sit directly next to each other in the recognized
# text (this pattern, unlike the generic fallback below, is never allowed to
# join two unrelated words) keeps this from matching an unrelated label --
# e.g. "TARE 3700" from a weight-spec line never sits adjacent to a 4-letter
# *owner* code in the actual OCR text, so it was never a risk here.
CONTAINER_RE = re.compile(r"\b([A-Z]{4}\s?-?\s?\d{4,7})\b")
# Generic alphanumeric identifier (truck registration, seal number, etc.):
# at least one letter and one digit, 4-15 chars, optionally hyphenated.
GENERIC_ID_RE = re.compile(r"\b([A-Z0-9](?:[A-Z0-9-]{2,13})[A-Z0-9])\b")

MIN_CONFIDENCE = {
    "container": 0.55,
    "truck": 0.45,
    "seal": 0.45,
}

# Words that show up, confidently and legitimately read, on a real shipping
# container photo but are never themselves part of the container number --
# the weight-spec block (Max Gross Weight / Tare / Payload) and the leasing
# company's own printed name. Excluded from the generic letters+digits
# fallback (see _multi_word_candidates) so a correctly-read label word can
# never be mistaken for the container's owner code.
_LABEL_WORD_BLOCKLIST = {
    "TARE", "MGW", "GROSS", "NET", "PAYLOAD", "WEIGHT", "MAX", "CAP", "CU",
    "KG", "KGS", "LB", "LBS", "SEACO", "SRL",
}

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
    from being mistaken for part of the plate.

    This same fallback also runs for container photos when CONTAINER_RE
    finds nothing. A real container door photo is printed all over with
    short, confidently-read weight-spec labels ("TARE", "MGW", "SEACO",
    "SRL") right next to a weight figure -- exactly the letters+digits
    shape this function looks for -- which is how a real photo once had
    Tesseract's cleanly-read "TARE" (0.96 confidence) joined to the
    adjacent "3700" (0.95 confidence) and reported as the container
    number instead of the actual "SEGU 657685" printed elsewhere in the
    same frame. _LABEL_WORD_BLOCKLIST excludes exactly those known
    non-identifier label words from the letters half of the join."""
    letters_words = [
        (w, c) for w, c in words
        if 2 <= len(w) <= 6 and w.isalpha() and w not in _LABEL_WORD_BLOCKLIST
    ]
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
