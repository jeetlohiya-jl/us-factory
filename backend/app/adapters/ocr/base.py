"""
OCR port. Business logic (the vehicle inspection service) depends only on
this interface, never on a specific OCR library. Swapping Tesseract for a
cloud OCR provider later means writing one new adapter class, not touching
any endpoint or service code.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class OcrResult:
    raw_text: str
    extracted_value: str | None   # the best-guess identifier, or None if nothing usable was found
    confidence: float              # 0.0 - 1.0
    status: str                    # "success" | "low_confidence" | "failed"


class OcrPort(ABC):
    @abstractmethod
    def extract_identifier(self, image_bytes: bytes, field_type: str) -> OcrResult:
        """
        field_type is one of: container, truck, seal — used only to pick a
        matching regex/heuristic for the identifier shape, never to fabricate
        a result. If nothing is confidently extracted, status is
        'low_confidence' or 'failed' and extracted_value is None; the caller
        must leave the field for manual entry in that case.
        """
        raise NotImplementedError
