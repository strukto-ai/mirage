import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.readdir import readdir
from mirage.types import FileStat, FileType, PathSpec


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


def _paths(rows: list[FileStat], base: str = "") -> list[str]:
    return [f"{base}/{row.name}" for row in rows]


_BASE = "https://graph.microsoft.com/v1.0/me/drive"


@pytest.mark.asyncio
async def test_readdir_root_lists_children():
    with aioresponses() as m:
        m.get(
            _BASE + "/root/children",
            payload={
                "value": [
                    {"id": "1", "name": "a.txt", "size": 10, "file": {}},
                    {"id": "2", "name": "Docs", "folder": {"childCount": 0}},
                ]
            },
        )
        names = _paths(await readdir(_accessor(), PathSpec.from_str_path("/")))
    assert names == ["/Docs", "/a.txt"]


@pytest.mark.asyncio
async def test_readdir_folder_records_file_and_folder_entries():
    with aioresponses() as m:
        m.get(
            _BASE + "/root:/Docs:/children",
            payload={
                "value": [
                    {"id": "9", "name": "report.docx", "size": 55, "file": {}}
                ]
            },
        )
        rows = await readdir(_accessor(), PathSpec.from_str_path("/Docs"))
    assert _paths(rows, "/Docs") == ["/Docs/report.docx"]
    assert rows[0].type is FileType.FILE
    assert rows[0].size == 55


@pytest.mark.asyncio
async def test_readdir_of_file_raises_not_a_directory():
    with aioresponses() as m:
        m.get(
            _BASE + "/root:/a.txt:/children",
            status=404,
            payload={"error": {"code": "itemNotFound", "message": "x"}},
        )
        m.get(
            _BASE + "/root:/a.txt",
            payload={"id": "1", "name": "a.txt", "size": 3, "file": {}},
        )
        with pytest.raises(NotADirectoryError):
            await readdir(_accessor(), PathSpec.from_str_path("/a.txt"))


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_not_a_directory():
    # Graph 404s the children of `/a.txt/x` exactly as it does those of a
    # name that is simply absent, so only the ancestor walk can tell GNU's
    # "Not a directory" from "No such file or directory".
    missing = {"error": {"code": "itemNotFound", "message": "x"}}
    with aioresponses() as m:
        m.get(_BASE + "/root:/a.txt/x:/children", status=404, payload=missing)
        # The walk asks each component as a directory and then as a file, so
        # every probe URL answers more than once.
        m.get(
            _BASE + "/root:/a.txt/x", status=404, payload=missing, repeat=True
        )
        m.get(
            _BASE + "/root:/a.txt",
            payload={"id": "1", "name": "a.txt", "size": 3, "file": {}},
            repeat=True,
        )
        with pytest.raises(NotADirectoryError):
            await readdir(_accessor(), PathSpec.from_str_path("/a.txt/x"))


@pytest.mark.asyncio
async def test_readdir_of_a_missing_path_is_not_found():
    missing = {"error": {"code": "itemNotFound", "message": "x"}}
    with aioresponses() as m:
        m.get(
            _BASE + "/root:/nope/deeper:/children", status=404, payload=missing
        )
        m.get(
            _BASE + "/root:/nope/deeper",
            status=404,
            payload=missing,
            repeat=True,
        )
        m.get(_BASE + "/root:/nope", status=404, payload=missing, repeat=True)
        with pytest.raises(FileNotFoundError):
            await readdir(_accessor(), PathSpec.from_str_path("/nope/deeper"))


@pytest.mark.asyncio
async def test_readdir_paginates_nextlink():
    page2 = _BASE + "/root/children?$skiptoken=x"
    with aioresponses() as m:
        m.get(
            _BASE + "/root/children",
            payload={
                "value": [{"id": "1", "name": "a.txt", "file": {}}],
                "@odata.nextLink": page2,
            },
        )
        m.get(
            page2,
            payload={"value": [{"id": "2", "name": "b.txt", "file": {}}]},
        )
        names = _paths(await readdir(_accessor(), PathSpec.from_str_path("/")))
    assert names == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_readdir_stores_remote_time_for_files():
    with aioresponses() as m:
        m.get(
            _BASE + "/root/children",
            payload={
                "value": [
                    {
                        "id": "1",
                        "name": "a.txt",
                        "size": 10,
                        "file": {},
                        "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                    }
                ]
            },
        )
        rows = await readdir(_accessor(), PathSpec.from_str_path("/"))
    assert rows[0].modified == "2026-06-19T09:28:00Z"


@pytest.mark.asyncio
async def test_readdir_stores_remote_time_for_folders():
    with aioresponses() as m:
        m.get(
            _BASE + "/root/children",
            payload={
                "value": [
                    {
                        "id": "2",
                        "name": "Docs",
                        "folder": {"childCount": 3},
                        "size": 5000,
                        "lastModifiedDateTime": "2026-05-28T02:10:00Z",
                    }
                ]
            },
        )
        rows = await readdir(_accessor(), PathSpec.from_str_path("/"))
    assert rows[0].modified == "2026-05-28T02:10:00Z"
    # Graph folder size is aggregate storage metadata, never a rendered
    # content length: it lives in extra, not in the row's size.
    assert rows[0].size is None
    assert rows[0].extra["size_bytes"] == 5000
    assert rows[0].extra["child_count"] == 3


@pytest.mark.asyncio
async def test_a_listing_is_in_code_point_order():
    # Graph may answer in UTF-16 order, which puts an astral name before a
    # private-use one; the rows come back in code-point order, or a walk
    # reorders grep's output.
    with aioresponses() as m:
        m.get(
            _BASE + "/root/children",
            payload={
                "value": [
                    {
                        "id": "1",
                        "name": "\U0001f600.txt",
                        "size": 1,
                        "file": {},
                    },
                    {"id": "2", "name": ".txt", "size": 1, "file": {}},
                ]
            },
        )
        rows = await readdir(_accessor(), PathSpec.from_str_path("/"))
    assert _paths(rows) == ["/\ue000.txt", "/\U0001f600.txt"]
