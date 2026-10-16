"""
File attachments for Falcon IPQC (migration 0090): images, PDF and DOCX.

Used by three owners -- an IPQC record, a Burst Test and a Pinhole Test -- so
the checks live in one place. The file's real type is decided from its first
bytes (not from the filename or the browser-supplied content type), and that
detected type is what gets stored, so a renamed file can't be served as
something else. The same file (same SHA-256) cannot be attached twice to one
record, which also makes a retried upload harmless.
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import uuid
import zipfile

MAX_BYTES = 15 * 1024 * 1024
MAX_FILES_PER_RECORD = 30

# extension -> (content type shown/served, magic check)
ALLOWED_EXTENSIONS = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
ACCEPT_LABEL = "images (JPG, PNG, GIF, WebP), PDF or DOCX"


class AttachmentError(Exception):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _magic_ok(ext: str, data: bytes) -> bool:
    if ext in (".jpg", ".jpeg"):
        return data.startswith(b"\xff\xd8\xff")
    if ext == ".png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if ext == ".gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    if ext == ".webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if ext == ".pdf":
        return b"%PDF-" in data[:1024]
    if ext == ".docx":
        if not data.startswith(b"PK\x03\x04"):
            return False
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = z.namelist()
            return "[Content_Types].xml" in names and any(n.startswith("word/") for n in names)
        except zipfile.BadZipFile:
            return False
    return False


def safe_display_name(filename: str | None) -> str:
    name = os.path.basename((filename or "").replace("\\", "/")).strip()
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    return (name[:150] or "attachment")


def validate_upload(filename: str | None, content: bytes) -> dict:
    """Returns {filename, content_type, size_bytes, sha256, ext} or raises AttachmentError."""
    display = safe_display_name(filename)
    ext = os.path.splitext(display)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise AttachmentError(f"Unsupported file type. Upload {ACCEPT_LABEL}.")
    if not content:
        raise AttachmentError("The file is empty.")
    if len(content) > MAX_BYTES:
        raise AttachmentError(f"The file is larger than {MAX_BYTES // (1024 * 1024)} MB.", status_code=413)
    if not _magic_ok(ext, content):
        raise AttachmentError(f"This file's contents do not match its {ext} extension. Upload {ACCEPT_LABEL}.")
    return {
        "filename": display, "ext": ext, "content_type": ALLOWED_EXTENSIONS[ext],
        "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
    }


def storage_path_for(owner_kind: str, owner_id: uuid.UUID, display_name: str, ext: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.splitext(display_name)[0])[:60].strip("._") or "file"
    return f"ipqc/{owner_kind}/{owner_id}/{uuid.uuid4().hex[:8]}_{stem}{ext}"
