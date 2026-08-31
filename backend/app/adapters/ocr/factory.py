from app.core.config import get_settings
from app.adapters.ocr.base import OcrPort
from app.adapters.ocr.tesseract_adapter import TesseractOcrAdapter


def get_ocr_adapter() -> OcrPort:
    settings = get_settings()
    if settings.ocr_provider == "tesseract":
        return TesseractOcrAdapter()
    raise ValueError(f"Unknown OCR provider: {settings.ocr_provider}")
