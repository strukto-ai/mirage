import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.nextcloud.read import read_bytes
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


@pytest.mark.asyncio
async def test_readdir_backfills_lister_omitted_size(make_acc):
    # When PROPFIND metadata is missing, readdir does one stat per affected
    # file instead of caching an unknown size.
    acc = make_acc({"a.txt": b"hello", "b.txt": b"abc"})
    fake = acc._fake
    real_list = fake.list

    async def _stripped_list(path, **kw):
        entries = await real_list(path, **kw)

        async def _iter():
            async for entry in entries:
                if entry.path == "a.txt":
                    entry.metadata = None
                yield entry

        return _iter()

    acc.operator = lambda: fake
    fake.list = _stripped_list
    index = RAMIndexCacheStore()
    await readdir(acc, PathSpec.from_str_path("/"), index)
    entry = (await index.get("/a.txt")).entry
    assert entry is not None
    assert entry.size == 5
    assert entry.remote_time != ""


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(make_acc):
    # The fskit invariant behind SIZES_ALWAYS_KNOWN: the size stat serves
    # from the listing must equal the byte length a read delivers, 0-byte
    # files included.
    contents = {
        "a.txt": b"hello",
        "empty.txt": b"",
        "docs/b.bin": b"abc",
    }
    acc = make_acc(contents)
    index = RAMIndexCacheStore()
    files: list[str] = []
    stack = ["/"]
    while stack:
        current = stack.pop()
        listing = await readdir(acc, PathSpec.from_str_path(current), index)
        for child in listing:
            trimmed = child.rstrip("/")
            info = await stat(acc, PathSpec.from_str_path(trimmed), index)
            if info.type == FileType.DIRECTORY:
                stack.append(trimmed)
                continue
            assert info.size is not None, trimmed
            body = await read_bytes(acc, PathSpec.from_str_path(trimmed),
                                    index)
            assert info.size == len(body), trimmed
            files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]
