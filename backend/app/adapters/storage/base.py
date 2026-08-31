from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class StoredFile:
    storage_path: str
    public_url: str


class StoragePort(ABC):
    @abstractmethod
    def save(self, path: str, content: bytes, content_type: str) -> StoredFile:
        raise NotImplementedError

    @abstractmethod
    def delete(self, path: str) -> None:
        raise NotImplementedError

    @abstractmethod
    def read(self, path: str) -> bytes:
        raise NotImplementedError
