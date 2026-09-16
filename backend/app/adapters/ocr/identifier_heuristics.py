"""
Shared identifier-matching heuristics, factored out of the original
Tesseract-only adapter so a second OCR provider (Google Cloud Vision, see
google_vision_adapter.py) can reuse the exact same, already-tuned matching
logic on top of its own (word, confidence) list -- rather than re-deriving
(and inevitably drifting from) container-number/plate-number pattern
matching a second time. Nothing here talks to any specific OCR engine; it
only classifies a list of recognized (text, confidence) tuples into the
best identifier candidate for a given field_type.
"""
import re

from app.adapters.ocr.base import OcrResult

# ISO 6346 shipping container number: 4 letters (owner code + category id) + 7 digits.
# The digit run is accepted down to 4 digits (not just 6-7) because a real
# photo of the whole container door -- rather than a tight crop of just the
# number -- often has that number small enough in the frame that OCR reads
# only the first several digits of it correctly and drops the rest. Still
# requiring the letters and digits to sit directly next to each other in
# the recognized text (this pattern, unlike the generic fallback below, is
# never allowed to join two unrelated words) keeps this from matching an
# unrelated label -- e.g. "TARE 3700" from a weight-spec line never sits
# adjacent to a 4-letter *owner* code in the actual OCR text.
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
# fallback (see multi_word_candidates) so a correctly-read label word can
# never be mistaken for the container's owner code.
LABEL_WORD_BLOCKLIST = {
    "TARE", "MGW", "GROSS", "NET", "PAYLOAD", "WEIGHT", "MAX", "CAP", "CU",
    "KG", "KGS", "LB", "LBS", "SEACO", "SRL",
}


def looks_like_identifier(token: str) -> bool:
    cleaned = token.replace("-", "").replace(" ", "")
    if len(cleaned) < 4:
        return False
    has_letter = any(c.isalpha() for c in cleaned)
    has_digit = any(c.isdigit() for c in cleaned)
    return has_letter and has_digit


def multi_word_candidates(words: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Vehicle registration plates are very often printed on two separate
    lines/groups -- a letters part (state/series code) and a digits part
    (the number) -- so OCR reads them back as two SEPARATE words, e.g.
    "TAV" and "3657", each of which fails looks_like_identifier on its own
    since neither one word contains both a letter and a digit.

    Rather than blindly concatenating adjacent words -- which is fragile
    the moment a stray misread token (a crest, an emblem, a bolt) sits
    between the real letters and digits in reading order -- take the
    single BEST-confidence all-letters word and the single BEST-confidence
    all-digits word anywhere in the image and join those two.

    Both parts are also length-capped at 6 characters -- plate series
    codes and plate numbers are always short, so this keeps a long,
    unrelated but confidently-read word elsewhere in the photo (a
    stencilled company name, a decal, a slogan painted on the truck bed)
    from being mistaken for part of the plate.

    This same fallback also runs for container photos when CONTAINER_RE
    finds nothing -- LABEL_WORD_BLOCKLIST excludes known non-identifier
    label words from the letters half of the join."""
    letters_words = [
        (w, c) for w, c in words
        if 2 <= len(w) <= 6 and w.isalpha() and w not in LABEL_WORD_BLOCKLIST
    ]
    digit_words = [(w, c) for w, c in words if 2 <= len(w) <= 6 and w.isdigit()]
    if not letters_words or not digit_words:
        return []
    best_letters = max(letters_words, key=lambda x: x[1])
    best_digits = max(digit_words, key=lambda x: x[1])
    joined = best_letters[0] + best_digits[0]
    avg_conf = (best_letters[1] + best_digits[1]) / 2
    return [(joined, avg_conf)]


def extract_from_words(words: list[tuple[str, float]], field_type: str, log=None) -> OcrResult:
    """Classifies an OCR engine's recognized (UPPERCASE text, confidence
    0-1) word list into the best identifier candidate for field_type. Never
    invents a value: returns status='failed' when nothing usable was read
    at all, 'low_confidence' when a candidate exists but doesn't clear
    MIN_CONFIDENCE for this field_type, and 'success' otherwise -- exactly
    the same three-way contract every OcrPort implementation must honor."""
    raw_text = " ".join(w for w, _ in words)

    if not words:
        return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

    best_value = None
    best_conf = 0.0

    if field_type == "container":
        m = CONTAINER_RE.search(raw_text)
        if m:
            candidate = m.group(1).replace(" ", "")
            matching = [c for w, c in words if w.replace(" ", "") in candidate or candidate in w]
            best_value = candidate
            best_conf = max(matching) if matching else 0.5

    if best_value is None:
        candidates = [(w, c) for w, c in words if looks_like_identifier(w)]
        candidates += multi_word_candidates(words)
        if candidates:
            candidates.sort(key=lambda x: x[1], reverse=True)
            best_value, best_conf = candidates[0]

    threshold = MIN_CONFIDENCE.get(field_type, 0.5)

    if best_value is None:
        if log:
            log.warning(
                "OCR found no identifier-shaped candidate for field_type=%s. Words read: %s",
                field_type, [(w, round(c, 2)) for w, c in words],
            )
        return OcrResult(raw_text=raw_text, extracted_value=None, confidence=0.0, status="failed")
    if best_conf < threshold:
        if log:
            log.warning(
                "OCR candidate for field_type=%s below confidence threshold (%.2f < %.2f): best_value=%r.",
                field_type, best_conf, threshold, best_value,
            )
        return OcrResult(raw_text=raw_text, extracted_value=best_value, confidence=best_conf, status="low_confidence")
    return OcrResult(raw_text=raw_text, extracted_value=best_value, confidence=best_conf, status="success")
