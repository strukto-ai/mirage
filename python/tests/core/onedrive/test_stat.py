import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.read import read
from mirage.core.onedrive.readdir import readdir
from mirage.core.onedrive.stat import stat, tree
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_FILE_URL = "https://graph.microsoft.com/v1.0/me/drive/root:/Docs/report.docx"
_DIR_URL = "https://graph.microsoft.com/v1.0/me/drive/root:/Docs"


@pytest.mark.asyncio
async def test_stat_root_is_directory():
    with aioresponses() as m:
        m.get(
            "https://graph.microsoft.com/v1.0/me/drive/root",
            payload={
                "id": "01ROOT",
                "name": "root",
                "size": 4096,
                "folder": {"childCount": 2},
                "lastModifiedDateTime": "2026-05-01T10:00:00Z",
            },
        )
        result = await stat(_accessor(), PathSpec.from_str_path("/"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"
    assert result.modified == "2026-05-01T10:00:00Z"
    # The root's Graph `size` is the aggregate subtree storage number,
    # never a content length: it belongs in extra, like any folder.
    assert result.size is None
    assert result.extra["size_bytes"] == 4096
    assert result.extra["child_count"] == 2


@pytest.mark.asyncio
async def test_stat_file_carries_size_and_ctag_fingerprint():
    with aioresponses() as m:
        m.get(
            _FILE_URL,
            payload={
                "id": "01ITEM",
                "name": "report.docx",
                "size": 1234,
                "lastModifiedDateTime": "2026-05-01T10:00:00Z",
                "cTag": "ctag-abc",
                "eTag": "etag-xyz",
                "file": {"mimeType": "application/vnd.openxml"},
            },
        )
        result = await stat(
            _accessor(), PathSpec.from_str_path("/Docs/report.docx")
        )
    assert result.name == "report.docx"
    assert result.size == 1234
    assert result.fingerprint == "ctag-abc"
    assert result.extra["id"] == "01ITEM"


@pytest.mark.asyncio
async def test_stat_folder_is_directory():
    with aioresponses() as m:
        m.get(
            _DIR_URL,
            payload={
                "id": "01FOLDER",
                "name": "Docs",
                "size": 4096,
                "lastModifiedDateTime": "2026-05-01T10:00:00Z",
                "folder": {"childCount": 2},
            },
        )
        result = await stat(_accessor(), PathSpec.from_str_path("/Docs"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "Docs"
    assert result.size is None
    assert result.extra["size_bytes"] == 4096
    assert result.extra["child_count"] == 2
    assert result.modified == "2026-05-01T10:00:00Z"


@pytest.mark.asyncio
async def test_stat_missing_raises_file_not_found():
    with aioresponses() as m:
        m.get(
            _FILE_URL,
            status=404,
            payload={"error": {"code": "itemNotFound", "message": "no"}},
        )
        with pytest.raises(FileNotFoundError) as exc:
            await stat(
                _accessor(),
                PathSpec.from_str_path(
                    "/od/Docs/report.docx",
                    mount_key("/od/Docs/report.docx", "/od"),
                ),
            )
    assert exc.value.filename == "/od/Docs/report.docx"


@pytest.mark.asyncio
async def test_a_listed_row_carries_modified():
    with aioresponses() as m:
        m.get(
            "https://graph.microsoft.com/v1.0/me/drive/root/children",
            payload={
                "value": [
                    {
                        "id": "1",
                        "name": "notes.txt",
                        "size": 42,
                        "file": {},
                        "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                    }
                ]
            },
        )
        result = (await readdir(_accessor(), PathSpec.from_str_path("/")))[0]
    assert result.name == "notes.txt"
    assert result.size == 42
    assert result.modified == "2026-06-19T09:28:00Z"


@pytest.mark.asyncio
async def test_a_listed_row_carries_the_ctag():
    # A listing already names each file's cTag, so the row the mount
    # answers a stat with carries the same token a network stat does; a
    # delta walk fingerprints on the rows it lists.
    with aioresponses() as m:
        m.get(
            "https://graph.microsoft.com/v1.0/me/drive/root/children",
            payload={
                "value": [
                    {
                        "id": "1",
                        "name": "notes.txt",
                        "size": 42,
                        "file": {},
                        "cTag": "c1",
                        "eTag": "e1",
                        "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                    }
                ]
            },
        )
        result = (await readdir(_accessor(), PathSpec.from_str_path("/")))[0]
    assert result.fingerprint == "c1"
    assert (result.extra["ctag"], result.extra["etag"]) == ("c1", "e1")


@pytest.mark.asyncio
async def test_a_listed_folder_has_no_fingerprint():
    # A folder's cTag describes no bytes anyone reads, and a network stat
    # gives a folder none either.
    with aioresponses() as m:
        m.get(
            "https://graph.microsoft.com/v1.0/me/drive/root/children",
            payload={
                "value": [
                    {
                        "id": "2",
                        "name": "Docs",
                        "folder": {"childCount": 1},
                        "cTag": "cf",
                        "eTag": "ef",
                        "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                    }
                ]
            },
        )
        result = (await readdir(_accessor(), PathSpec.from_str_path("/")))[0]
    assert result.type == FileType.DIRECTORY
    assert result.fingerprint is None


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file():
    # The fskit invariant behind sizes_always_known: the size stat reports
    # from the listing must equal the byte length a read delivers, for
    # every file in the tree, 0-byte files included.
    contents = {
        "/notes.txt": b"hello onedrive",
        "/Docs/empty.bin": b"",
        "/Docs/report.docx": b"docx bytes",
    }
    base = "https://graph.microsoft.com/v1.0/me/drive"
    accessor = _accessor()
    with aioresponses() as m:
        m.get(
            base + "/root/children",
            payload={
                "value": [
                    {
                        "id": "1",
                        "name": "notes.txt",
                        "size": len(contents["/notes.txt"]),
                        "file": {},
                        "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                    },
                    {
                        "id": "2",
                        "name": "Docs",
                        "size": 9000,
                        "folder": {"childCount": 2},
                        "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                    },
                ]
            },
        )
        m.get(
            base + "/root:/Docs:/children",
            payload={
                "value": [
                    {
                        "id": "3",
                        "name": "empty.bin",
                        "size": 0,
                        "file": {},
                        "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                    },
                    {
                        "id": "4",
                        "name": "report.docx",
                        "size": len(contents["/Docs/report.docx"]),
                        "file": {},
                        "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                    },
                ]
            },
        )
        for path, body in contents.items():
            download = f"https://download.example{path}"
            m.get(
                base + f"/root:{path}",
                payload={"@microsoft.graph.downloadUrl": download},
            )
            m.get(download, body=body)
        files: list[str] = []
        stack = ["/"]
        while stack:
            current = stack.pop()
            listing = await readdir(accessor, PathSpec.from_str_path(current))
            for info in listing:
                child = f"{current.rstrip('/')}/{info.name}"
                if info.type == FileType.DIRECTORY:
                    stack.append(child)
                else:
                    assert info.size is not None, child
                    files.append(child)
                    body = await read(accessor, PathSpec.from_str_path(child))
                    assert info.size == len(body), child
    assert sorted(files) == sorted(contents)


@pytest.mark.asyncio
async def test_a_listed_folder_carries_modified():
    with aioresponses() as m:
        m.get(
            "https://graph.microsoft.com/v1.0/me/drive/root/children",
            payload={
                "value": [
                    {
                        "id": "2",
                        "name": "Docs",
                        "folder": {"childCount": 5},
                        "size": 9000,
                        "lastModifiedDateTime": "2026-05-28T02:10:00Z",
                    }
                ]
            },
        )
        result = (await readdir(_accessor(), PathSpec.from_str_path("/")))[0]
    assert result.type == FileType.DIRECTORY
    assert result.modified == "2026-05-28T02:10:00Z"
    assert result.size is None
    assert result.extra["size_bytes"] == 9000


_ME = "https://graph.microsoft.com/v1.0/me/drive"
_FEED = [
    {"id": "R", "name": "root", "root": {}, "folder": {}},
    {
        "id": "D",
        "name": "Docs",
        "parentReference": {"id": "R"},
        "folder": {"childCount": 1},
    },
    {
        "id": "f",
        "name": "report.docx",
        "parentReference": {"id": "D"},
        "size": 4,
        "file": {},
        "cTag": "c-report",
    },
]


@pytest.mark.asyncio
async def test_tree_of_a_personal_drive_root_is_one_feed_read():
    with aioresponses() as m:
        m.get(f"{_ME}?$select=driveType", payload={"driveType": "personal"})
        m.get(
            f"{_ME}/root?$select=id,folder", payload={"id": "R", "folder": {}}
        )
        m.get(f"{_ME}/root/delta", payload={"value": _FEED})
        found = await tree(_accessor(), PathSpec.from_str_path("/"))
    assert sorted(found) == ["Docs", "Docs/report.docx"]
    assert found["Docs/report.docx"].size == 4
    assert found["Docs/report.docx"].fingerprint == "c-report"


@pytest.mark.asyncio
async def test_tree_below_the_root_reads_the_feed_of_a_personal_drive():
    accessor = _accessor()
    with aioresponses() as m:
        m.get(f"{_ME}?$select=driveType", payload={"driveType": "personal"})
        m.get(
            f"{_DIR_URL}?$select=id,folder", payload={"id": "D", "folder": {}}
        )
        m.get(f"{_DIR_URL}:/delta", payload={"value": _FEED[1:]})
        found = await tree(accessor, PathSpec.from_str_path("/Docs"))
    assert list(found) == ["report.docx"]
    assert accessor.drive_type == "personal"


_BATCH = "https://graph.microsoft.com/v1.0/$batch"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["business", "documentLibrary"])
async def test_tree_of_a_business_drive_batches_its_folders(kind):
    accessor = _accessor()
    with aioresponses() as m:
        m.get(f"{_ME}?$select=driveType", payload={"driveType": kind})
        m.get(f"{_ME}/root/children", payload={"value": [_FEED[1]]})
        m.post(
            _BATCH,
            payload={
                "responses": [
                    {"id": "0", "status": 200, "body": {"value": [_FEED[2]]}}
                ]
            },
        )
        found = await tree(accessor, PathSpec.from_str_path("/"))
        sent = m.requests[("POST", URL(_BATCH))][0].kwargs["json"]
    assert sorted(found) == ["Docs", "Docs/report.docx"]
    assert found["Docs/report.docx"].fingerprint == "c-report"
    assert sent == {
        "requests": [
            {
                "id": "0",
                "method": "GET",
                "url": "/me/drive/root:/Docs:/children",
            }
        ]
    }


@pytest.mark.asyncio
async def test_tree_batches_while_the_drive_type_is_refused():
    accessor = _accessor()
    with aioresponses() as m:
        m.get(f"{_ME}?$select=driveType", status=403, payload={})
        m.get(f"{_DIR_URL}:/children", payload={"value": [_FEED[2]]})
        found = await tree(accessor, PathSpec.from_str_path("/Docs"))
    assert list(found) == ["report.docx"]
    assert accessor.drive_type is None


@pytest.mark.asyncio
async def test_tree_of_a_personal_drive_batches_when_the_feed_is_refused():
    accessor = _accessor()
    with aioresponses() as m:
        m.get(f"{_ME}?$select=driveType", payload={"driveType": "personal"})
        m.get(
            f"{_DIR_URL}?$select=id,folder", payload={"id": "D", "folder": {}}
        )
        m.get(f"{_DIR_URL}:/delta", status=403, payload={})
        m.get(f"{_DIR_URL}:/children", payload={"value": [_FEED[2]]})
        found = await tree(accessor, PathSpec.from_str_path("/Docs"))
    assert list(found) == ["report.docx"]
