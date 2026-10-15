import pytest

from mirage.core.nextcloud.read import read
from mirage.core.nextcloud.readdir import readdir
from mirage.core.nextcloud.search import SearchEntry
from mirage.core.nextcloud.stat import stat, tree
from mirage.types import ContentType, FileStat, FileType, FindType, PathSpec


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
async def test_stat_asks_the_server_once(make_acc):
    acc = make_acc({"data/file.txt": b"x"})
    fake = acc._fake
    asked: list[str] = []
    real_stat = fake.stat

    async def _counted(key):
        asked.append(key)
        return await real_stat(key)

    fake.stat = _counted
    s = await stat(acc, PathSpec.from_str_path("/data"))
    assert s.type == FileType.DIRECTORY
    with pytest.raises(FileNotFoundError):
        await stat(acc, PathSpec.from_str_path("/missing.txt"))
    assert asked == ["data", "missing.txt"]


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
async def test_a_listed_row_carries_modified(make_acc):
    acc = make_acc({"data/file.txt": b"abcde"})
    (s,) = await readdir(acc, PathSpec.from_str_path("/data"))
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
    rows = await readdir(acc, PathSpec.from_str_path("/"))
    entry = next(row for row in rows if row.name == "a.txt")
    assert entry.size == 5
    assert entry.modified


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(make_acc):
    # The fskit invariant behind sizes_always_known: the size stat serves
    # from the listing must equal the byte length a read delivers, 0-byte
    # files included.
    contents = {
        "a.txt": b"hello",
        "empty.txt": b"",
        "docs/b.bin": b"abc",
    }
    acc = make_acc(contents)
    files: list[str] = []
    stack = ["/"]
    while stack:
        current = stack.pop()
        listing = await readdir(acc, PathSpec.from_str_path(current))
        for child in listing:
            trimmed = current.rstrip("/") + "/" + child.name
            info = child
            if info.type == FileType.DIRECTORY:
                stack.append(trimmed)
                continue
            assert info.size is not None, trimmed
            body = await read(acc, PathSpec.from_str_path(trimmed))
            assert info.size == len(body), trimmed
            files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]


def _rows(*entries: SearchEntry):
    async def search_files(_accessor, _path):
        return list(entries)

    return search_files


@pytest.mark.asyncio
async def test_tree_renders_each_row_as_a_listed_stat(make_acc, monkeypatch):
    when = "2026-07-11T12:00:00+00:00"
    monkeypatch.setitem(
        tree.__globals__,
        "search_files",
        _rows(
            SearchEntry("/docs/a.txt", FindType.FILE, 3, when),
            SearchEntry("/docs/sub", FindType.DIRECTORY, None, when),
            SearchEntry("/docs/sub/b.txt", FindType.FILE, 0, None),
            SearchEntry("/other.txt", FindType.FILE, 1, when),
        ),
    )
    found = await tree(make_acc({}), PathSpec.from_str_path("/docs"))
    assert found == {
        "a.txt": FileStat(
            name="a.txt",
            size=3,
            modified=when,
            type=FileType.FILE,
            content=ContentType.TEXT,
        ),
        "sub": FileStat(name="sub", type=FileType.DIRECTORY, modified=when),
        "sub/b.txt": FileStat(
            name="b.txt", size=0, type=FileType.FILE, content=ContentType.TEXT
        ),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rows",
    [None, [SearchEntry("/docs/a.txt", FindType.FILE, None, None)]],
)
async def test_tree_leaves_no_search_or_a_sizeless_file_to_the_walk(
    make_acc, monkeypatch, rows
):
    async def search_files(_accessor, _path):
        return rows

    monkeypatch.setitem(tree.__globals__, "search_files", search_files)
    assert await tree(make_acc({}), PathSpec.from_str_path("/docs")) is None
