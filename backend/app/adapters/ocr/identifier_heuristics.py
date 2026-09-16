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
    # Indian vehicle plates carry a fixed "IND" country badge printed
    # directly on the plate itself (distinct from the registration number),
    # per the Indian Motor Vehicles Act's international-identification
    # requirement -- it's read confidently and legitimately, but it's never
    # part of the plate number and must never be joined into it.
    "IND",
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


def full_plate_candidate(words: list[tuple[str, float]]) -> tuple[str, float] | None:
    """Indian (and many other) vehicle registration plates print in FOUR
    groups -- state code, district/series code, series letters, and the
    number -- e.g. "KL 87 AB 1234". A tightly-cropped or angled photo often
    has OCR read each group as its own short word (sometimes two groups
    fuse, e.g. "KL87" + "AB1234", sometimes all four stay separate). Picking
    only the single highest-confidence SHORT identifier-shaped word (the old
    behaviour) systematically returns just one fragment -- e.g. "KL87" --
    and silently drops the rest of the plate, which is the exact symptom
    reported against real uploads.

    This walks every short (<=6 char) alphanumeric-ish fragment in the
    OCR engine's own reading order (top-to-bottom, left-to-right -- the
    order `words` already arrives in) and joins ALL of them into one
    candidate. Reading order is what makes this safe: a plate's four
    groups are printed left-to-right/top-to-bottom as one visual unit, so
    joining consecutive short fragments in that order reconstructs the
    plate even when OCR has split it into 2, 3, or 4 pieces -- whereas
    picking "the single best word" can never do better than one fragment.
    Only fragments that are themselves plausible plate pieces (<=6 chars,
    alnum, not a known non-identifier label word) are included, so an
    unrelated long word elsewhere in the frame (a company name, a road
    sign) never gets pulled in. A pure-letters fragment (no digit of its
    own -- e.g. a country badge like "IND" stamped on many Indian plates,
    separate from the plate itself) is only pulled in when it sits directly
    next to a digit-bearing fragment in reading order -- a real plate group
    is always adjacent to the rest of the plate, whereas a badge/stamp
    elsewhere in the frame is not."""
    short = [
        (i, w, c) for i, (w, c) in enumerate(words)
        if 1 <= len(w) <= 6 and w.isalnum() and w not in LABEL_WORD_BLOCKLIST
    ]
    has_digit = {i for i, w, _ in short if any(ch.isdigit() for ch in w)}
    fragments = [
        (w, c) for i, w, c in short
        if any(ch.isdigit() for ch in w) or (i - 1 in has_digit) or (i + 1 in has_digit)
    ]
    if len(fragments) < 2:
        return None
    joined = "".join(w for w, _ in fragments)
    if not looks_like_identifier(joined):
        return None
    avg_conf = sum(c for _, c in fragments) / len(fragments)
    return (joined, avg_conf)


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
        # Track each word's character span within raw_text (words are
        # joined with single spaces) so a regex match can be mapped back to
        # exactly which word index(es) it came from -- needed below to find
        # the word that comes right AFTER the match, not just any word that
        # happens to share a substring with it (a lone "7" is a substring of
        # almost any digit run, so naive substring matching picks the wrong
        # word).
        spans: list[tuple[int, int]] = []
        pos = 0
        for w, _ in words:
            spans.append((pos, pos + len(w)))
            pos += len(w) + 1

        m = CONTAINER_RE.search(raw_text)
        if m:
            candidate = m.group(1).replace(" ", "")
            match_word_idxs = [i for i, (s, e) in enumerate(spans) if s < m.end() and e > m.start()]
            matching = [words[i][1] for i in match_word_idxs]
            best_value = candidate
            best_conf = max(matching) if matching else 0.5
            # ISO 6346 codes are 4 letters + 7 digits (the last digit is a
            # check digit); CONTAINER_RE accepts 4-7 digits so it already
            # matches on a partial read, but a photo of the whole container
            # door often has that trailing check digit printed/boxed
            # separately and so OCR reads it as its OWN word right after the
            # rest of the number (e.g. "SEGU 657685" + "7"). Complete the
            # number to 7 digits from the word immediately following the
            # match (by position, not by a fuzzy substring check) when it's
            # a bare 1-2 digit run, rather than silently returning a
            # truncated container number.
            digits_only = "".join(ch for ch in candidate if ch.isdigit())
            if len(digits_only) < 7 and match_word_idxs:
                idx = match_word_idxs[-1]
                if idx + 1 < len(words):
                    nxt, nxt_conf = words[idx + 1]
                    if nxt.isdigit() and len(digits_only) + len(nxt) <= 7:
                        candidate = candidate + nxt
                        best_value = candidate
                        best_conf = (best_conf + nxt_conf) / 2

    if field_type == "truck":
        # Vehicle plates routinely split into several short fragments (see
        # full_plate_candidate) -- try that reconstruction FIRST and prefer
        # it over any single fragment whenever it's actually more complete,
        # since a longer joined reading is never a worse answer than one
        # isolated piece of the same plate.
        joined = full_plate_candidate(words)
        if joined:
            best_value, best_conf = joined

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
