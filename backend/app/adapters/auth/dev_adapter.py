"""
Dev auth adapter — a stand-in for Supabase Auth with Google OAuth, which
isn't wired up yet (no Supabase project exists for this task). Accepts a
bearer token of the literal form "dev:<app_users.email>" and resolves it to
a real row in app_users, so permission checks run against real, persisted
per-user rows exactly as they will once Supabase Auth is live — only the
"how do we know who's calling" step is fake here, everything downstream
(the users table, module_permissions) is real.

Switching to SupabaseAuthAdapter is a one-line change to FACTORY_AUTH_PROVIDER
plus FACTORY_SUPABASE_JWT_SECRET.
"""
from sqlalchemy.orm import Session

from app.adapters.auth.base import AuthPort, AuthenticatedUser
from app.db import models


class DevAuthAdapter(AuthPort):
    def __init__(self, db: Session):
        self.db = db

    def resolve_user(self, authorization_header: str | None) -> AuthenticatedUser | None:
        if not authorization_header or not authorization_header.startswith("Bearer "):
            return None
        token = authorization_header[len("Bearer "):].strip()
        if not token.startswith("dev:"):
            return None
        email = token[len("dev:"):]
        user = self.db.query(models.AppUser).filter(models.AppUser.email == email, models.AppUser.is_active.is_(True)).first()
        if not user:
            return None
        return AuthenticatedUser(user_id=str(user.id), email=user.email, full_name=user.full_name)
