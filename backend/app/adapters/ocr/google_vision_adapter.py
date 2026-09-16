"""
Google Cloud Vision OCR adapter -- the default OCR provider as of the
"switch to a cloud OCR API" decision (Tesseract was demonstrably unreliable
on real truck/container/seal photos: low-resolution phone photos, glare,
angled/partial shots). Cloud Vision's DOCUMENT_TEXT_DETECTION feature is
built and tuned specifically for exactly this kind of real-world printed
text photo (dense document/label text on varied backgrounds), which is why
it was chosen over a generic web-search-style API.

Uses the plain REST `images:annotate` endpoint with an API key (no service
account JSON, no google-cloud-vision SDK dependency) -- one HTTP call via
httpx, kept consistent with how lightly this codebase depends on any single
cloud vendor's SDK elsewhere. Requires FACTORY_GOOGLE_VISION_API_KEY to be
set to a Cloud Vision-enabled API key (Google Cloud Console -> APIs &
Services -> Credentials -> API key, with the Cloud Vision API enabled on
the project and, ideally, the key restricted to that API).

Word-level confidence: DOCUMENT_TEXT_DETECTION returns a fullTextAnnotation
tree (pages -> blocks -> paragraphs -> words -> symbols), with confidence
scored per symbol (not always populated per-word directly, depending on API
version) -- _words_from_response reconstructs each word's text by joining
its symbols and averages their confidences, giving the same (text,
confidence) shape identifier_heuristics.extract_from_words already expects
from the Tesseract adapter, so both providers are classified by the exact
same, already-tuned matching rules.

Never blocks the form: any failure here (missing/invalid API key, network
error, non-200 response, malformed body) returns status='failed' with
extracted_value=None -- exactly like Tesseract's own failure path -- so the
caller (inward_vehicle_inspections.py) always falls through to manual
entry rather than raising. get_ocr_adapter() in factory.py additionally
falls back to TesseractOcrAdapter entirely when no API key is configured at
all, so a dev/local environment without cloud credentials still gets a
working (if less accurate) OCR path instead of every upload failing OCR
outright.
"""
import base64
import logging

import httpx

from app.adapters.ocr.base import OcrPort, OcrResult
from app.adapters.ocr.identifier_heuristics import extract_from_words
from app.core.config import get_settings

log = logging.getLogger("factory_os.ocr")

VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"
# Real-world photos are taken from a distance / at an angle more often than
# they're tightly cropped, so document-mode detection (built for dense
# printed text in a photo, not just short signage) reads truck plates,
# container doors, and seal labels more reliably than plain TEXT_DETECTION.
VISION_FEATURE = "DOCUMENT_TEXT_DETECTION"
REQUEST_TIMEOUT_SECONDS = 12.0  # a slow OCR call must never hang the upload form indefinitely


def _words_from_response(payload: dict) -> list[tuple[str, float]]:
    """Flattens Cloud Vision's fullTextAnnotation word tree into the same
    (UPPERCASE text, confidence 0-1) shape identifier_heuristics.extract_from_words
    expects, reconstructing each word's text from its symbols (Cloud
    Vision's confidence is scored per-symbol) and averaging their
    confidences for a per-word score."""
    words: list[tuple[str, float]] = []
    responses = payload.get("responses") or []
    if not responses:
        return words
    full_text = responses[0].get("fullTextAnnotation") or {}
    for page in full_text.get("pages", []):
        for block in page.get("blocks", []):
            for paragraph in block.get("paragraphs", []):
                for word in paragraph.get("words", []):
                    symbols = word.get("symbols", [])
                    if not symbols:
                        continue
                    text = "".join(s.get("text", "") for s in symbols).strip()
                    if not text:
                        continue
                    confidences = [s.get("confidence") for s in symbols if s.get("confidence") is not None]
                    conf = (sum(confidences) / len(confidences)) if confidences else float(word.get("confidence") or 0.5)
                    words.append((text.upper(), conf))
    return words


class GoogleVisionOcrAdapter(OcrPort):
    def __init__(self):
        self._api_key = get_settings().google_vision_api_key

    def extract_identifier(self, image_bytes: bytes, field_type: str) -> OcrResult:
        if not self._api_key:
            # get_ocr_adapter() should never construct this adapter without
            # a key configured (see factory.py's fallback), but this stays
            # as a safe, non-crashing guard rather than trusting the caller.
            log.error("GoogleVisionOcrAdapter called with no FACTORY_GOOGLE_VISION_API_KEY configured.")
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        body = {
            "requests": [
                {
                    "image": {"content": base64.b64encode(image_bytes).decode("ascii")},
                    "features": [{"type": VISION_FEATURE}],
                    # US truck plates / shipping container/seal codes are
                    # always Latin-alphabet + digits -- hinting the language
                    # avoids Cloud Vision occasionally guessing a non-Latin
                    # script for a low-quality/angled photo.
                    "imageContext": {"languageHints": ["en"]},
                }
            ]
        }
        try:
            resp = httpx.post(
                VISION_ENDPOINT, params={"key": self._api_key}, json=body, timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as e:
            log.error("Google Cloud Vision request failed: %s", e)
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        if resp.status_code != 200:
            log.error("Google Cloud Vision returned HTTP %s: %s", resp.status_code, resp.text[:500])
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        try:
            payload = resp.json()
        except ValueError:
            log.error("Google Cloud Vision returned a non-JSON response.")
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        response_error = (payload.get("responses") or [{}])[0].get("error")
        if response_error:
            log.error("Google Cloud Vision annotate error: %s", response_error)
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")

        words = _words_from_response(payload)
        return extract_from_words(words, field_type, log=log)
