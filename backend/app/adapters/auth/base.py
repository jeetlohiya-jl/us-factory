from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class AuthenticatedUser:
    user_id: str
    email: str
    full_name: str


class AuthPort(ABC):
    @abstractmethod
    def resolve_user(self, authorization_header: str | None) -> AuthenticatedUser | None:
        raise NotImplementedError

    @abstractmethod
    def resolve_email(self, authorization_header: str | None) -> str | None:
        """Like resolve_user, but only proves "this is a validly signed-in
        person, and this is their email" -- it does NOT require an
        app_users row to exist. Used by the portfolio-access gate
        (app/api/portfolio_access.py's /me route), which has to work for a
        person who has portfolio access to a product other than this one
        and therefore may have no app_users row in this database at all.
        Every other route in this app should keep using resolve_user."""
        raise NotImplementedError
