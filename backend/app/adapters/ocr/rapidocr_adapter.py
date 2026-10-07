"""OcrPort adapter on the tested RapidOCR pipeline (rapidocr_pipeline.py).

Container: ISO 6346 -- a number is only reported 'success' when its check
digit was read and verifies (or a vertical stencil verifies); when the
boxed check digit wasn't readable it is computed and reported
'low_confidence' so the inspector glances at it.
Seal: voted across rotations; 'success' when read consistently.
Truck: RapidOCR's words fed to the existing Indian-plate heuristics
(identifier_heuristics.extract_from_words).
"""
import logging
import threading

import cv2
import numpy as np

from app.adapters.ocr.base import OcrPort, OcrResult
from app.adapters.ocr import identifier_heuristics

log = logging.getLogger("factory_os.ocr")
_lock = threading.Lock()   # one recognition at a time per process (engine isn't documented thread-safe)


class RapidOcrAdapter(OcrPort):
    def extract_identifier(self, image_bytes: bytes, field_type: str) -> OcrResult:
        from app.adapters.ocr import rapidocr_pipeline as p   # lazy: loads the models on first use
        im = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        if im is None:
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")
        try:
            with _lock:
                if field_type == "truck":
                    return self._truck(p, im)
                kind = "container" if field_type == "container" else "seal"
                r = p.read(im, kind)
        except Exception as e:   # OCR must never break an upload
            log.warning("RapidOCR failed for %s: %s", field_type, e)
            return OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")
        raw = f"{r['how']}; candidates: {', '.join(r['candidates'])}"
        if not r["value"]:
            return OcrResult(raw_text=raw, extracted_value=None, confidence=0.0, status="failed")
        if r["confidence"] == "high":
            return OcrResult(raw_text=raw, extracted_value=r["value"], confidence=0.95, status="success")
        return OcrResult(raw_text=raw, extracted_value=r["value"], confidence=0.7, status="low_confidence")

    def _truck(self, p, im) -> OcrResult:
        im = p._prep(im, 2400)
        best = None
        for variant in (im, p._clahe(im)):
            for rot in (None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE):
                x = variant if rot is None else cv2.rotate(variant, rot)
                words = [(b["t"], b["c"]) for b in p._boxes(x)]
                r = identifier_heuristics.extract_from_words(words, "truck", log)
                if r.extracted_value and (best is None or r.confidence > best.confidence):
                    best = r
                if best and best.status == "success":
                    return best
        return best or OcrResult(raw_text="", extracted_value=None, confidence=0.0, status="failed")
