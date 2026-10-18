from unittest.mock import AsyncMock

import pytest

from mirage.cache.context import push_cache_manager
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.core.generic.find import walk_find
from mirage.core.generic.find_eval import FindArgs
from mirage.types import FileStat, FileType, PathSpec


async def _children(path: PathSpec) -> list[str]:
    return ["/entry"] if path.virtual == "/" else []


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [FileType.DIRECTORY, FileType.SYMLINK])
async def test_walk_does_not_read_cached_bytes_for_non_files(
    kind, monkeypatch
):
    cache = RAMFileCacheStore()
    get = AsyncMock(wraps=cache.get)
    monkeypatch.setattr(cache, "get", get)
    manager = CacheManager(cache, RAMIndexCacheStore(), "", True)
    stats = {
        "/": FileStat(name="", type=FileType.DIRECTORY, size=0),
        "/entry": FileStat(name="entry", type=kind),
    }

    async def stat(path: PathSpec) -> FileStat:
        return stats[path.virtual]

    previous = push_cache_manager(manager)
    try:
        result = await walk_find(
            PathSpec.from_str_path("/"),
            readdir=_children,
            stat=stat,
            args=FindArgs(),
        )
    finally:
        push_cache_manager(previous)

    assert result == ["/", "/entry"]
    get.assert_not_awaited()


@pytest.mark.asyncio
async def test_walk_backfills_an_unknown_file_size_from_cached_bytes(
    monkeypatch,
):
    cache = RAMFileCacheStore()
    await cache.set("/entry", b"cached")
    get = AsyncMock(wraps=cache.get)
    monkeypatch.setattr(cache, "get", get)
    manager = CacheManager(cache, RAMIndexCacheStore(), "", True)
    stats = {
        "/": FileStat(name="", type=FileType.DIRECTORY, size=0),
        "/entry": FileStat(name="entry", type=FileType.FILE),
    }

    async def stat(path: PathSpec) -> FileStat:
        return stats[path.virtual]

    previous = push_cache_manager(manager)
    try:
        result = await walk_find(
            PathSpec.from_str_path("/"),
            readdir=_children,
            stat=stat,
            args=FindArgs(min_size=6, max_size=6),
        )
    finally:
        push_cache_manager(previous)

    assert result == ["/entry"]
    assert get.await_count > 0
