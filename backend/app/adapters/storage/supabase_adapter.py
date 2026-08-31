"""
Real Supabase Storage adapter. Not exercised in this session (no live
Supabase project credentials were available), but implements the same
StoragePort as LocalStorageAdapter so switching FACTORY_STORAGE_PROVIDER
to "supabase" and supplying FACTORY_SUPABASE_URL / FACTORY_SUPABASE_SERVICE_KEY
is the entire migration — no business logic changes.
"""
from app.core.config import get_settings
from app.adapters.storage.base import StoragePort, StoredFile


class SupabaseStorageAdapter(StoragePort):
    def __init__(self):
        settings = get_settings()
        if not settings.supabase_url or not settings.supabase_service_key:
            raise RuntimeError(
                "FACTORY_SUPABASE_URL and FACTORY_SUPABASE_SERVICE_KEY must be set "
                "to use the Supabase storage adapter."
            )
        from supabase import create_client  # imported lazily: optional dependency

        self.client = create_client(settings.supabase_url, settings.supabase_service_key)
        self.bucket = settings.supabase_storage_bucket

    def save(self, path: str, content: bytes, content_type: str) -> StoredFile:
        self.client.storage.from_(self.bucket).upload(
            path, content, {"content-type": content_type, "upsert": "true"}
        )
        public_url = self.client.storage.from_(self.bucket).get_public_url(path)
        return StoredFile(storage_path=path, public_url=public_url)

    def delete(self, path: str) -> None:
        self.client.storage.from_(self.bucket).remove([path])

    def read(self, path: str) -> bytes:
        return self.client.storage.from_(self.bucket).download(path)
