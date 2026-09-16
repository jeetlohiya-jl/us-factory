import logging

from app.core.config import get_settings
from app.adapters.ocr.base import OcrPort
from app.adapters.ocr.tesseract_adapter import TesseractOcrAdapter
from app.adapters.ocr.google_vision_adapter import GoogleVisionOcrAdapter

log = logging.getLogger("factory_os.ocr")


def get_ocr_adapter() -> OcrPort:
    settings = get_settings()
    if settings.ocr_provider == "google_vision":
        if not settings.google_vision_api_key:
            # Never let a missing cloud credential make OCR simply stop
            # working -- fall back to the local Tesseract adapter (less
            # accurate, but functional with zero configuration) rather than
            # raising, which would otherwise 500 every single image upload
            # in any environment that hasn't set the key yet.
            log.warning(
                "FACTORY_OCR_PROVIDER=google_vision but FACTORY_GOOGLE_VISION_API_KEY "
                "is not set -- falling back to the local Tesseract OCR adapter. "
                "Set FACTORY_GOOGLE_VISION_API_KEY to use Google Cloud Vision."
            )
            return TesseractOcrAdapter()
        return GoogleVisionOcrAdapter()
    if settings.ocr_provider == "tesseract":
        return TesseractOcrAdapter()
    raise ValueError(f"Unknown OCR provider: {settings.ocr_provider}")
