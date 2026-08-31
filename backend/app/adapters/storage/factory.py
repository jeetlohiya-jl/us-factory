from app.core.config import get_settings
from app.adapters.storage.base import StoragePort
from app.adapters.storage.local_adapter import LocalStorageAdapter


def get_storage_adapter() -> StoragePort:
    settings = get_settings()
    if settings.storage_provider == "local":
        return LocalStorageAdapter()
    if settings.storage_provider == "supabase":
        from app.adapters.storage.supabase_adapter import SupabaseStorageAdapter
        return SupabaseStorageAdapter()
    raise ValueError(f"Unknown storage provider: {settings.storage_provider}")
