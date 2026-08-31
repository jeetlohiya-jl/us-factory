"""
Central configuration. Everything infra-specific (DB URL, storage mode,
auth mode) is read from environment variables so swapping the local
Postgres/local-storage/dev-auth stand-ins for the real Supabase project
is a config change, not a code change.
"""
from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database — point this at the Supabase Postgres connection string in production.
    database_url: str = "postgresql+psycopg2://factory_app:factory_dev_pw@localhost:5432/factory_os"

    # Storage adapter selection: "local" (filesystem, dev/default) or "supabase".
    storage_provider: str = "local"
    local_storage_dir: str = "./storage_data"
    supabase_url: str | None = None
    supabase_service_key: str | None = None
    supabase_storage_bucket: str = "inward-vehicle-inspection"

    # Auth adapter selection: "dev" (static bearer-token users, default while
    # Supabase Google OAuth isn't wired up) or "supabase".
    auth_provider: str = "dev"
    supabase_jwt_secret: str | None = None

    # OCR adapter selection: "tesseract" (real, local, default) or "none".
    ocr_provider: str = "tesseract"

    # On Linux the "tesseract-ocr" / "poppler-utils" system packages put
    # these binaries on PATH automatically, so pytesseract/pdf2image find
    # them with no configuration. Windows installers don't add themselves
    # to PATH by default, so pytesseract.TesseractNotFoundError (or
    # pdf2image's "poppler not installed" error) there is an environment
    # setup step, not a code bug — set these to the full path once (e.g.
    # the tesseract.exe path / poppler's \bin folder from the installers)
    # instead of editing the System PATH.
    tesseract_cmd: str | None = None
    poppler_path: str | None = None

    cors_origins: list[str] = ["http://localhost:3000"]

    class Config:
        env_file = ".env"
        env_prefix = "FACTORY_"


@lru_cache
def get_settings() -> Settings:
    return Settings()
