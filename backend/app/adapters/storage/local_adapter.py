"""
Local filesystem storage adapter — the default until a real Supabase
Storage bucket/credentials exist. Implements the same StoragePort as
SupabaseStorageAdapter, so business logic never notices which one is
active. Files are served back out via the /media static mount in main.py.
"""
import os

from app.core.config import get_settings
from app.adapters.storage.base import StoragePort, StoredFile


class LocalStorageAdapter(StoragePort):
    def __init__(self):
        settings = get_settings()
        self.root = os.path.abspath(settings.local_storage_dir)
        os.makedirs(self.root, exist_ok=True)

    def _full_path(self, path: str) -> str:
        full = os.path.abspath(os.path.join(self.root, path))
        if not full.startswith(self.root):
            raise ValueError("Invalid storage path")
        return full

    def save(self, path: str, content: bytes, content_type: str) -> StoredFile:
        full = self._full_path(path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(content)
        return StoredFile(storage_path=path, public_url=f"/media/{path}")

    def delete(self, path: str) -> None:
        full = self._full_path(path)
        if os.path.exists(full):
            os.remove(full)

    def read(self, path: str) -> bytes:
        full = self._full_path(path)
        with open(full, "rb") as f:
            return f.read()
