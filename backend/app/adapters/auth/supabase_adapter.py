"""
Real Supabase Auth adapter (validates a Supabase-issued JWT from Google
OAuth). Not exercised in this session — no live Supabase project — but
matches the AuthPort interface so enabling it later is configuration only:
FACTORY_AUTH_PROVIDER=supabase, FACTORY_SUPABASE_JWT_SECRET=<project jwt secret>.
"""
from jose import jwt, JWTError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.adapters.auth.base import AuthPort, AuthenticatedUser
from app.db import models


class SupabaseAuthAdapter(AuthPort):
    def __init__(self, db: Session):
        self.db = db
        self.settings = get_settings()

    def resolve_user(self, authorization_header: str | None) -> AuthenticatedUser | None:
        if not authorization_header or not authorization_header.startswith("Bearer "):
            return None
        token = authorization_header[len("Bearer "):].strip()
        if not self.settings.supabase_jwt_secret:
            return None
        try:
            payload = jwt.decode(
                token, self.settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated"
            )
        except JWTError:
            return None
        auth_user_id = payload.get("sub")
        email = payload.get("email")
        if not auth_user_id or not email:
            return None
        user = self.db.query(models.AppUser).filter(models.AppUser.email == email, models.AppUser.is_active.is_(True)).first()
        if not user:
            return None
        return AuthenticatedUser(user_id=str(user.id), email=user.email, full_name=user.full_name)
