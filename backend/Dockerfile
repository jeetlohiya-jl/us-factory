# Cirkla Factory OS backend — Render deployment image.
#
# A plain Python buildpack (Render's "native runtime") can't install the
# system binaries OCR/COA-parsing depend on: pytesseract shells out to the
# `tesseract` binary and pdf2image shells out to poppler's `pdftoppm`/
# `pdfinfo`. Neither is a pip package. Docker is what lets us apt-get them
# in reliably, so this image is required, not optional, for Render.
FROM python:3.11-slim

# tesseract-ocr and poppler-utils put their binaries on PATH automatically
# on Linux (see backend/app/core/config.py's tesseract_cmd/poppler_path
# comment) -- no extra path configuration needed once they're installed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render sets $PORT at runtime and expects the service to bind to it.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
