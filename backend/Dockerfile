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
# libgl1: OpenCV (pulled in by the RapidOCR photo reader) needs libGL.so.1
# at import if the desktop opencv-python build is installed -- python:3.11-
# slim has none, which made the backend fail to start ("libGL.so.1: cannot
# open shared object file"). libgomp1: OpenMP runtime used by the OCR
# engine. (Both names exist on Debian bookworm and trixie.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    libgl1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# rapidocr pulls in the desktop opencv-python, which needs GUI/libGL
# libraries; swap it for the server build (opencv-python-headless). Both
# install into the same cv2/ folder, so the headless one is reinstalled
# after the other is removed.
RUN pip uninstall -y opencv-python opencv-contrib-python; \
    pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless

# Fail the build -- not the running service -- if the OCR libraries can't load.
RUN python -c "import cv2, onnxruntime, rapidocr_onnxruntime; print('OCR libraries OK: OpenCV', cv2.__version__)"

COPY . .

# Render sets $PORT at runtime and expects the service to bind to it.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
