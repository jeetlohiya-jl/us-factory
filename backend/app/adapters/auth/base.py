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
