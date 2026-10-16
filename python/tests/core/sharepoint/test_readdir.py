import re

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.readdir import readdir, tree
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"

_SITES_RE = re.compile(r".*/sites\??.*")
_DRIVES_RE = re.compile(r".*/sites/.*/drives\??.*")


def _paths(path: PathSpec, rows) -> list[str]:
    return [f"{path.virtual.rstrip('/')}/{row.name}" for row in rows]


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


@pytest.mark.asyncio
async def test_readdir_root_lists_sites():
    with aioresponses() as m:
        m.get(
            _SITES_RE,
            payload={
                "value": [
                    {"id": "s1", "displayName": "Engineering", "name": "eng"},
                    {"id": "s2", "displayName": "Marketing", "name": "mkt"},
                ]
            },
        )
        path = PathSpec(
            vfs_path=mount_key("/sp/", "/sp"), virtual="/sp/", directory="/sp/"
        )
        names = _paths(path, await readdir(_accessor(), path))
    assert "/sp/Engineering" in names
    assert "/sp/Marketing" in names


@pytest.mark.asyncio
async def test_readdir_site_lists_drives():
    with aioresponses() as m:
        m.get(
            _DRIVES_RE,
            payload={
                "value": [
                    {"id": _DRIVE_ID, "name": "Documents"},
                    {"id": "b!other", "name": "Archives"},
                ]
            },
        )
        path = PathSpec(
            vfs_path=mount_key("/sp/Engineering", "/sp"),
            virtual="/sp/Engineering",
            directory="/sp/Engineering",
        )
        names = _paths(path, await readdir(_accessor(), path))
    assert "/sp/Engineering/Archives" in names
    assert "/sp/Engineering/Documents" in names


@pytest.mark.asyncio
async def test_readdir_drive_root_lists_children():
    with aioresponses() as m:
        m.get(
            f"{_BASE}/drives/{_DRIVE_ID}/root/children",
            payload={
                "value": [
                    {
                        "id": "1",
                        "name": "readme.md",
                        "size": 100,
                        "file": {},
                        "lastModifiedDateTime": "2026-06-01T10:00:00Z",
                    },
                    {
                        "id": "2",
                        "name": "src",
                        "size": 0,
                        "folder": {"childCount": 5},
                        "lastModifiedDateTime": "2026-06-02T10:00:00Z",
                    },
                ]
            },
        )
        path = PathSpec(
            vfs_path=mount_key("/sp/Engineering/Documents", "/sp"),
            virtual="/sp/Engineering/Documents",
            directory="/sp/Engineering/Documents",
        )
        names = _paths(path, await readdir(_accessor(), path))
    assert "/sp/Engineering/Documents/readme.md" in names
    assert "/sp/Engineering/Documents/src" in names


@pytest.mark.asyncio
async def test_readdir_rows_carry_metadata():
    with aioresponses() as m:
        m.get(
            f"{_BASE}/drives/{_DRIVE_ID}/root/children",
            payload={
                "value": [
                    {
                        "id": "1",
                        "name": "a.txt",
                        "size": 42,
                        "file": {},
                        "lastModifiedDateTime": "2026-06-15T08:00:00Z",
                    },
                ]
            },
        )
        path = PathSpec(
            vfs_path=mount_key("/sp/Engineering/Documents", "/sp"),
            virtual="/sp/Engineering/Documents",
            directory="/sp/Engineering/Documents",
        )
        rows = await readdir(_accessor(), path)
    assert rows[0].size == 42
    assert rows[0].modified == "2026-06-15T08:00:00Z"


@pytest.mark.asyncio
async def test_readdir_subfolder():
    with aioresponses() as m:
        m.get(
            f"{_BASE}/drives/{_DRIVE_ID}/root:/src:/children",
            payload={
                "value": [
                    {"id": "3", "name": "main.py", "size": 200, "file": {}},
                ]
            },
        )
        path = PathSpec(
            vfs_path=mount_key("/sp/Engineering/Documents/src", "/sp"),
            virtual="/sp/Engineering/Documents/src",
            directory="/sp/Engineering/Documents/src",
        )
        names = _paths(path, await readdir(_accessor(), path))
    assert "/sp/Engineering/Documents/src/main.py" in names


@pytest.mark.asyncio
async def test_readdir_of_file_raises_not_a_directory():
    with aioresponses() as m:
        m.get(
            f"{_BASE}/drives/{_DRIVE_ID}/root:/a.txt:/children",
            status=404,
            payload={"error": {"code": "itemNotFound", "message": "x"}},
        )
        m.get(
            f"{_BASE}/drives/{_DRIVE_ID}/root:/a.txt",
            payload={"id": "1", "name": "a.txt", "size": 3, "file": {}},
        )
        path = PathSpec(
            vfs_path=mount_key("/sp/Engineering/Documents/a.txt", "/sp"),
            virtual="/sp/Engineering/Documents/a.txt",
            directory="/sp/Engineering/Documents",
        )
        with pytest.raises(NotADirectoryError):
            await readdir(_accessor(), path)


def _sp(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/sp"), virtual=virtual, directory=virtual
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("virtual", ["/sp/", "/sp/Engineering"])
async def test_tree_above_the_libraries_is_left_to_the_walk(virtual):
    with aioresponses() as m:
        assert await tree(_accessor(), _sp(virtual)) is None
        assert not m.requests


@pytest.mark.asyncio
async def test_tree_of_a_library_batches_its_folders():
    with aioresponses() as m:
        m.get(
            f"{_BASE}/drives/{_DRIVE_ID}/root/children",
            payload={
                "value": [
                    {"id": "1", "name": "readme.md", "size": 3, "file": {}},
                    {"id": "2", "name": "src", "folder": {"childCount": 1}},
                ]
            },
        )
        m.post(
            f"{_BASE}/$batch",
            payload={
                "responses": [
                    {
                        "id": "0",
                        "status": 200,
                        "body": {
                            "value": [
                                {
                                    "id": "3",
                                    "name": "main.py",
                                    "size": 5,
                                    "file": {},
                                }
                            ]
                        },
                    }
                ]
            },
        )
        found = await tree(_accessor(), _sp("/sp/Engineering/Documents"))
        sent = m.requests[("POST", URL(f"{_BASE}/$batch"))][0].kwargs["json"]
    assert sorted(found) == ["readme.md", "src", "src/main.py"]
    assert sent["requests"][0]["url"] == (
        f"/drives/{_DRIVE_ID}/root:/src:/children"
    )
