"""
Real Supabase Auth adapter (validates a Supabase-issued JWT from Google
OAuth).

Supabase used to sign every project's access tokens with a single shared
HS256 "JWT secret" (still shown on the dashboard as the "Legacy" option).
Newer/migrated projects sign with an asymmetric key instead (ES256 in
practice) and publish the matching *public* key at the project's JWKS
endpoint -- there's no shared secret to configure at all in that mode,
and verifying against one (as this file used to) fails for every token
regardless of what's pasted in, because the token was never signed with
that secret to begin with. This adapter verifies against the JWKS
endpoint instead, keyed by the token header's `kid`, which works for
both signing modes without needing to know in advance which one a given
project uses. It only requires FACTORY_SUPABASE_URL (already set for the
storage adapter) -- FACTORY_SUPABASE_JWT_SECRET is no longer read.

The JWKS response is cached in memory for _JWKS_TTL_SECONDS to avoid a
network round trip on every request; a `kid` miss (e.g. Supabase rotated
its signing key) forces one cache refresh before giving up.
"""
import logging
import time
import urllib.error
import urllib.request
import json
import uuid as uuid_lib

from jose import jwt, JWTError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.adapters.auth.base import AuthPort, AuthenticatedUser
from app.db import models

logger = logging.getLogger(__name__)

_JWKS_TTL_SECONDS = 3600
_jwks_cache: dict = {"keys": [], "fetched_at": 0.0}


def _fetch_jwks(supabase_url: str) -> list[dict]:
    url = f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
    with urllib.request.urlopen(url, timeout=5) as resp:
        data = json.loads(resp.read())
    return data.get("keys", [])


def _get_jwk_for_kid(supabase_url: str, kid: str | None) -> dict | None:
    now = time.time()
    if not _jwks_cache["keys"] or (now - _jwks_cache["fetched_at"]) >= _JWKS_TTL_SECONDS:
        _jwks_cache["keys"] = _fetch_jwks(supabase_url)
        _jwks_cache["fetched_at"] = now

    for key in _jwks_cache["keys"]:
        if key.get("kid") == kid:
            return key

    # Not found -- could be a just-rotated signing key our cache predates.
    # Force one refresh and check again before giving up.
    _jwks_cache["keys"] = _fetch_jwks(supabase_url)
    _jwks_cache["fetched_at"] = time.time()
    for key in _jwks_cache["keys"]:
        if key.get("kid") == kid:
            return key
    return None


class SupabaseAuthAdapter(AuthPort):
    def __init__(self, db: Session):
        self.db = db
        self.settings = get_settings()

    def resolve_user(self, authorization_header: str | None) -> AuthenticatedUser | None:
        if not authorization_header or not authorization_header.startswith("Bearer "):
            return None
        token = authorization_header[len("Bearer "):].strip()
        if not self.settings.supabase_url:
            logger.warning("Supabase auth: FACTORY_SUPABASE_URL is not configured.")
            return None

        try:
            header = jwt.get_unverified_header(token)
            alg = header.get("alg", "ES256")
            jwk = _get_jwk_for_kid(self.settings.supabase_url, header.get("kid"))
            if jwk is None:
                logger.warning("Supabase auth: no matching JWKS key for kid=%s", header.get("kid"))
                return None
            payload = jwt.decode(token, jwk, algorithms=[alg], audience="authenticated")
        except (JWTError, urllib.error.URLError, ValueError) as e:
            logger.warning("Supabase auth: token rejected (%s)", e)
            return None

        auth_user_id = payload.get("sub")
        email = payload.get("email")
        if not auth_user_id or not email:
            return None
        user = self.db.query(models.AppUser).filter(models.AppUser.email == email, models.AppUser.is_active.is_(True)).first()
        if not user:
            logger.warning("Supabase auth: token valid but no active app_users row for email=%s", email)
            return None
        # Self-healing auth_user_id backfill: this app's permission model
        # keys everything off app_users.id (matched here by email), but
        # Phase 1's Row-Level Security policies need auth_user_id populated
        # with Supabase's own auth.users.id (the value auth.uid() returns)
        # to resolve a request back to that same app_users row -- see
        # app_user_id() in migration 0009. Nothing ever wrote this column
        # before; the first successful login after this change writes it
        # for every existing user, so no manual SQL backfill is needed.
        try:
            parsed_auth_user_id = uuid_lib.UUID(str(auth_user_id))
        except ValueError:
            logger.warning("Supabase auth: token 'sub' is not a valid UUID (%s)", auth_user_id)
            return None
        if user.auth_user_id != parsed_auth_user_id:
            user.auth_user_id = parsed_auth_user_id
            try:
                self.db.commit()
            except IntegrityError:
                # Some other app_users row already claims this Supabase
                # auth user id (the unique index from migration 0009) --
                # e.g. an email change on the Supabase side. Don't fail the
                # request over it; email-based resolution above already
                # succeeded, so auth still works. Just leave the RLS
                # linkage stale and let an operator sort out the duplicate.
                self.db.rollback()
                logger.warning(
                    "Supabase auth: auth_user_id=%s is already linked to a different app_users row; "
                    "not updating email=%s's linkage.", parsed_auth_user_id, email,
                )
        return AuthenticatedUser(user_id=str(user.id), email=user.email, full_name=user.full_name)
