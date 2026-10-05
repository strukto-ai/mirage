import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.nextcloud.readdir import readdir
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_readdir_root_returns_children(make_acc):
    acc = make_acc({"hello.txt": b"x", "data/file.txt": b"y"})
    entries = await readdir(
        acc, PathSpec.from_str_path("/"), RAMIndexCacheStore(ttl=60)
    )
    assert "/data" in entries
    assert "/hello.txt" in entries


@pytest.mark.asyncio
async def test_readdir_subdir(make_acc):
    acc = make_acc(
        {"data/a.txt": b"a", "data/sub/b.txt": b"b", "other.txt": b"o"}
    )
    entries = await readdir(
        acc, PathSpec.from_str_path("/data"), RAMIndexCacheStore(ttl=60)
    )
    assert sorted(entries) == ["/data/a.txt", "/data/sub"]


@pytest.mark.asyncio
async def test_readdir_file_raises_enotdir(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(
            acc,
            PathSpec.from_str_path("/data/a.txt"),
            RAMIndexCacheStore(ttl=60),
        )


@pytest.mark.asyncio
async def test_readdir_populates_index_cache(make_acc):
    acc = make_acc({"f.txt": b"hello"})
    cache = RAMIndexCacheStore(ttl=60)
    await readdir(acc, PathSpec.from_str_path("/"), cache)
    lookup = await cache.get("/f.txt")
    assert lookup.entry is not None
    assert lookup.entry.size == 5
    assert lookup.entry.resource_type == "file"


@pytest.mark.asyncio
async def test_readdir_stores_remote_time_for_files(make_acc):
    acc = make_acc({"f.txt": b"hello"})
    cache = RAMIndexCacheStore(ttl=60)
    await readdir(acc, PathSpec.from_str_path("/"), cache)
    lookup = await cache.get("/f.txt")
    assert lookup.entry is not None
    assert lookup.entry.remote_time == "2026-01-01T00:00:00+00:00"


@pytest.mark.asyncio
async def test_readdir_missing_path_is_enoent(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(FileNotFoundError):
        await readdir(
            acc,
            PathSpec.from_str_path("/never.txt"),
            RAMIndexCacheStore(ttl=60),
        )


@pytest.mark.asyncio
async def test_readdir_missing_path_stats_each_component_once(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    fake = acc._fake
    asked: list[str] = []
    real_stat = fake.stat

    async def _counted(key):
        asked.append(key)
        return await real_stat(key)

    fake.stat = _counted
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/data/never"))
    assert asked == ["data/never", "data"]


@pytest.mark.asyncio
async def test_readdir_missing_nested_path_is_enoent(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(FileNotFoundError):
        await readdir(
            acc,
            PathSpec.from_str_path("/nodir/deep"),
            RAMIndexCacheStore(ttl=60),
        )


@pytest.mark.asyncio
async def test_readdir_below_a_file_is_enotdir(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(
            acc,
            PathSpec.from_str_path("/data/a.txt/x"),
            RAMIndexCacheStore(ttl=60),
        )


@pytest.mark.asyncio
async def test_readdir_empty_directory_is_empty_not_missing(make_acc):
    # PROPFIND lists the collection itself, which is the only thing that
    # tells an empty directory apart from a path the server does not have.
    acc = make_acc({})
    await acc.operator().create_dir("empty/")
    entries = await readdir(
        acc, PathSpec.from_str_path("/empty"), RAMIndexCacheStore(ttl=60)
    )
    assert entries == []
