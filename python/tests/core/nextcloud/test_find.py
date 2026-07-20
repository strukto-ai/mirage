from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.find_eval import And, Name, Path, Type
from mirage.core.nextcloud.find import find
from mirage.core.nextcloud.search import SearchEntry
from mirage.types import FindType, PathSpec


@pytest.fixture(autouse=True)
def mock_search_files(monkeypatch):
    search = AsyncMock(return_value=None)
    monkeypatch.setitem(find.__globals__, "search_files", search)
    return search


@pytest.mark.asyncio
async def test_find_root_returns_sorted_entries(make_acc):
    acc = make_acc({
        "a.json": b"a",
        "b.json": b"b",
        "data/c.json": b"c",
    })
    out = await find(acc, PathSpec.from_str_path("/"))
    assert out == ["/", "/a.json", "/b.json", "/data", "/data/c.json"]


@pytest.mark.asyncio
async def test_find_subdir_scopes_results(make_acc):
    acc = make_acc({
        "data/a.json": b"a",
        "data/sub/b.json": b"b",
        "other.txt": b"o",
    })
    out = await find(acc, PathSpec.from_str_path("/data"))
    assert out == ["/data", "/data/a.json", "/data/sub", "/data/sub/b.json"]


@pytest.mark.asyncio
async def test_find_missing_returns_empty(make_acc):
    acc = make_acc({})
    out = await find(acc, PathSpec.from_str_path("/nope"))
    assert out == []


@pytest.mark.asyncio
async def test_find_name_filter(make_acc):
    acc = make_acc({
        "a.json": b"a",
        "b.txt": b"b",
        "data/c.json": b"c",
    })
    out = await find(acc, PathSpec.from_str_path("/"), name="*.json")
    assert out == ["/a.json", "/data/c.json"]


@pytest.mark.asyncio
async def test_find_type_filter(make_acc):
    acc = make_acc({
        "a.json": b"a",
        "data/c.json": b"c",
    })
    files = await find(acc, PathSpec.from_str_path("/"), type="f")
    dirs = await find(acc, PathSpec.from_str_path("/"), type="d")
    assert files == ["/a.json", "/data/c.json"]
    assert dirs == ["/", "/data"]


@pytest.mark.asyncio
async def test_find_maxdepth(make_acc):
    acc = make_acc({
        "a.json": b"a",
        "data/c.json": b"c",
        "data/sub/d.json": b"d",
    })
    out = await find(acc, PathSpec.from_str_path("/"), maxdepth=1)
    assert out == ["/", "/a.json", "/data"]


@pytest.mark.asyncio
async def test_find_maxdepth_zero_only_stats_start(make_acc,
                                                   mock_search_files):
    acc = make_acc({"data/a.json": b"a"})
    acc._fake.scan = AsyncMock(
        side_effect=AssertionError("recursive scan should not run"))

    out = await find(acc, PathSpec.from_str_path("/data"), maxdepth=0)

    assert out == ["/data"]
    mock_search_files.assert_not_awaited()


@pytest.mark.asyncio
async def test_find_uses_server_search_for_supported_name_and_type(
        make_acc, mock_search_files):
    acc = make_acc({"Documents/existing.txt": b"x"})
    acc._fake.scan = AsyncMock(
        side_effect=AssertionError("recursive scan should not run"))
    mock_search_files.return_value = [
        SearchEntry(key="/Documents/Invoices",
                    name="Invoices",
                    kind=FindType.DIRECTORY,
                    size=0,
                    modified=100.0),
        SearchEntry(key="/Documents/invoices",
                    name="invoices",
                    kind=FindType.DIRECTORY,
                    size=0,
                    modified=100.0),
        SearchEntry(key="/Documents/Invoices-old",
                    name="Invoices-old",
                    kind=FindType.DIRECTORY,
                    size=0,
                    modified=100.0),
    ]

    out = await find(acc,
                     PathSpec.from_str_path("/Documents"),
                     name="Invoices",
                     type="d")

    assert out == ["/Documents/Invoices"]
    query = mock_search_files.await_args.args[2]
    assert query.tree == And([Name("Invoices"), Type("d")])


@pytest.mark.asyncio
async def test_find_applies_exact_name_depth_and_mtime_after_search(
        make_acc, mock_search_files):
    acc = make_acc({"Projects/existing.txt": b"x"})
    acc._fake.scan = AsyncMock(
        side_effect=AssertionError("recursive scan should not run"))
    mock_search_files.return_value = [
        SearchEntry(key="/Projects/a.pdf",
                    name="a.pdf",
                    kind=FindType.FILE,
                    size=5,
                    modified=200.0),
        SearchEntry(key="/Projects/a.PDF",
                    name="a.PDF",
                    kind=FindType.FILE,
                    size=5,
                    modified=200.0),
        SearchEntry(key="/Projects/old.pdf",
                    name="old.pdf",
                    kind=FindType.FILE,
                    size=5,
                    modified=50.0),
        SearchEntry(key="/Projects/deep/b.pdf",
                    name="b.pdf",
                    kind=FindType.FILE,
                    size=5,
                    modified=200.0),
    ]

    out = await find(acc,
                     PathSpec.from_str_path("/Projects"),
                     name="*.pdf",
                     mtime_min=100.0,
                     mtime_max=250.0,
                     maxdepth=1)

    assert out == ["/Projects/a.pdf"]
    query = mock_search_files.await_args.args[2]
    assert query.tree == Name("*.pdf")
    assert query.modified.lower == 100.0
    assert query.modified.upper == 250.0


@pytest.mark.asyncio
async def test_find_pushes_size_and_keeps_directories(make_acc,
                                                      mock_search_files):
    acc = make_acc({"Accounting/existing.txt": b"x"})
    acc._fake.scan = AsyncMock(
        side_effect=AssertionError("recursive scan should not run"))
    mock_search_files.return_value = [
        SearchEntry(key="/Accounting/folder",
                    name="folder",
                    kind=FindType.DIRECTORY,
                    size=100,
                    modified=200.0),
        SearchEntry(key="/Accounting/small.txt",
                    name="small.txt",
                    kind=FindType.FILE,
                    size=5,
                    modified=200.0),
        SearchEntry(key="/Accounting/exact.txt",
                    name="exact.txt",
                    kind=FindType.FILE,
                    size=10,
                    modified=200.0),
    ]

    out = await find(acc,
                     PathSpec.from_str_path("/Accounting"),
                     min_size=10,
                     max_size=10)

    assert out == ["/Accounting/exact.txt"]
    query = mock_search_files.await_args.args[2]
    assert query.size.lower == 10
    assert query.size.upper == 10


@pytest.mark.asyncio
async def test_find_mtime_root_semantics_match_scan_fallback(
        make_acc, mock_search_files):
    acc = make_acc({"Accounting/report.pdf": b"report"})

    fallback = await find(acc,
                          PathSpec.from_str_path("/Accounting"),
                          mtime_min=1.0,
                          mtime_max=9_999_999_999.0)

    mock_search_files.return_value = [
        SearchEntry(key="/Accounting/report.pdf",
                    name="report.pdf",
                    kind=FindType.FILE,
                    size=6,
                    modified=100.0)
    ]
    server = await find(acc,
                        PathSpec.from_str_path("/Accounting"),
                        mtime_min=1.0,
                        mtime_max=9_999_999_999.0)

    assert fallback == ["/Accounting/report.pdf"]
    assert server == fallback


@pytest.mark.asyncio
async def test_find_falls_back_for_unsupported_path_predicate(
        make_acc, mock_search_files):
    acc = make_acc({
        "Projects/a.pdf": b"a",
        "Projects/deep/b.pdf": b"b",
    })

    out = await find(acc,
                     PathSpec.from_str_path("/Projects"),
                     path_pattern="*/deep/*")

    assert out == ["/Projects/deep/b.pdf"]
    mock_search_files.assert_not_awaited()


@pytest.mark.asyncio
async def test_find_falls_back_for_bracket_name_glob(make_acc,
                                                     mock_search_files):
    acc = make_acc({
        "Projects/a.pdf": b"a",
        "Projects/b.pdf": b"b",
        "Projects/c.pdf": b"c",
    })

    out = await find(acc, PathSpec.from_str_path("/Projects"), name="[ab].pdf")

    assert out == ["/Projects/a.pdf", "/Projects/b.pdf"]
    mock_search_files.assert_not_awaited()


@pytest.mark.asyncio
async def test_find_falls_back_for_mixed_supported_and_unsupported_predicates(
        make_acc, mock_search_files):
    acc = make_acc({
        "Projects/a.pdf": b"a",
        "Projects/deep/b.pdf": b"b",
        "Projects/deep/c.txt": b"c",
    })

    out = await find(acc,
                     PathSpec.from_str_path("/Projects"),
                     tree=And([Name("*.pdf"), Path("*/deep/*")]))

    assert out == ["/Projects/deep/b.pdf"]
    mock_search_files.assert_not_awaited()


@pytest.mark.asyncio
async def test_find_empty_matches_zero_length_file(make_acc):
    acc = make_acc({"empty.txt": b"", "full.txt": b"x"})
    out = await find(acc, PathSpec.from_str_path("/"), empty=True)
    assert out == ["/empty.txt"]
