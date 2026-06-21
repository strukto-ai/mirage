import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.nextcloud.readdir import readdir
from mirage.core.nextcloud.stat import stat
from mirage.types import FileType, PathSpec


@pytest.mark.asyncio
async def test_stat_file_returns_size_and_etag(make_acc):
    acc = make_acc({"data/file.txt": b"abcde"})
    s = await stat(acc, PathSpec.from_str_path("/data/file.txt"))
    assert s.name == "file.txt"
    assert s.size == 5
    assert s.fingerprint == "etag-data/file.txt"
    assert s.type != FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_directory_via_dir_probe(make_acc):
    acc = make_acc({"data/file.txt": b"x"})
    s = await stat(acc, PathSpec.from_str_path("/data"))
    assert s.type == FileType.DIRECTORY
    assert s.name == "data"


@pytest.mark.asyncio
async def test_stat_missing_raises_filenotfound(make_acc):
    acc = make_acc({})
    with pytest.raises(FileNotFoundError):
        await stat(acc, PathSpec.from_str_path("/missing.txt"))


@pytest.mark.asyncio
async def test_stat_root_is_directory(make_acc):
    acc = make_acc({})
    s = await stat(acc, PathSpec.from_str_path("/"))
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_returns_modified_from_index(make_acc):
    acc = make_acc({"data/file.txt": b"abcde"})
    cache = RAMIndexCacheStore(ttl=60)
    await readdir(acc, PathSpec.from_str_path("/data"), cache)
    s = await stat(acc, PathSpec.from_str_path("/data/file.txt"), index=cache)
    assert s.modified == "2026-01-01T00:00:00+00:00"
    assert s.size == 5
    assert s.type != FileType.DIRECTORY
