import pytest

from mirage.cache.file.ram import RAMFileCacheStore


class RefusingStore(RAMFileCacheStore):
    """A store whose server refuses every fill, and every drop when down."""

    def __init__(self, down: bool = False) -> None:
        super().__init__()
        self._down = down

    async def set(
        self,
        key: str,
        data: bytes,
        fingerprint: str | None = None,
        ttl: int | None = None,
    ) -> None:
        raise ConnectionError("OOM command not allowed")

    async def remove(self, key: str) -> None:
        if self._down:
            raise ConnectionError("connection refused")
        await super().remove(key)


@pytest.fixture
def refusing_store():
    return RefusingStore
