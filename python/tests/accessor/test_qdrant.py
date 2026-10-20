import asyncio

from mirage.accessor.qdrant import QdrantAccessor
from mirage.vfs.qdrant.config import QdrantConfig


class _Client:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def test_each_loop_opens_its_own_client_and_close_releases_it(monkeypatch):
    # Keyed by the loop object, not id(loop): a second asyncio.run must
    # not reach the client the first run's closed loop opened.
    monkeypatch.setattr("mirage.accessor.qdrant.AsyncQdrantClient", _Client)
    accessor = QdrantAccessor(QdrantConfig(url="http://qdrant:6333"))

    async def twice() -> _Client:
        client = await accessor.client()
        assert await accessor.client() is client
        return client

    first = asyncio.run(twice())
    second = asyncio.run(twice())
    assert second is not first and first.closed
    assert second.kwargs["url"] == "http://qdrant:6333"
    asked: list[str] = []

    async def search() -> list:
        asked.append("q")
        return []

    asyncio.run(accessor.searches.get(("c", "q", 1), search))
    accessor.indexes_ensured.add("c")
    asyncio.run(accessor.close())
    asyncio.run(accessor.searches.get(("c", "q", 1), search))
    assert second.closed
    assert asked == ["q", "q"] and accessor.indexes_ensured == set()
