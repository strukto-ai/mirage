import asyncio
from types import SimpleNamespace

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.vfs.lancedb.config import LanceDBConfig


class _Db:
    def __init__(self) -> None:
        self.opened: list[str] = []
        self.closed = False

    async def open_table(self, name: str) -> str:
        self.opened.append(name)
        return f"table:{name}"

    def close(self) -> None:
        self.closed = True


async def _connect(uri: str, **kwargs) -> _Db:
    return _Db()


def test_each_loop_opens_its_own_db_and_close_releases_it(monkeypatch):
    # Keyed by the loop object, not id(loop): a second asyncio.run must
    # not reach the db or tables the first run's closed loop opened.
    monkeypatch.setattr(
        "mirage.accessor.lancedb.lancedb",
        SimpleNamespace(connect_async=_connect),
    )
    accessor = LanceDBAccessor(LanceDBConfig(uri="/tmp/test-lancedb"))

    async def open_items() -> _Db:
        assert await accessor.table("items") == "table:items"
        assert await accessor.table("items") == "table:items"
        return await accessor.db()

    first = asyncio.run(open_items())
    second = asyncio.run(open_items())
    assert second is not first and first.closed
    assert first.opened == second.opened == ["items"]
    asked: list[str] = []

    async def search() -> list:
        asked.append("q")
        return []

    asyncio.run(accessor.searches.get(("items", "q", 1), search))
    asyncio.run(accessor.close())
    asyncio.run(accessor.searches.get(("items", "q", 1), search))
    assert second.closed and asked == ["q", "q"]
