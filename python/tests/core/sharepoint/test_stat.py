import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.sharepoint.read import read_bytes
from mirage.core.sharepoint.readdir import readdir
from mirage.core.sharepoint.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


def _ps(virtual: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(virtual, "/sp"),
                    virtual=virtual,
                    directory=virtual)


@pytest.mark.asyncio
async def test_stat_root_is_directory():
    path = PathSpec(resource_path=mount_key("/sp/", "/sp"),
                    virtual="/sp/",
                    directory="/sp/")
    result = await stat(_accessor(), path)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_site_is_directory():
    with aioresponses() as m:
        m.get(f"{_BASE}/sites",
              payload={
                  "value": [
                      {
                          "id": _SITE_ID,
                          "displayName": "Engineering",
                          "name": "eng"
                      },
                  ]
              })
        path = PathSpec(resource_path=mount_key("/sp/Engineering", "/sp"),
                        virtual="/sp/Engineering",
                        directory="/sp/Engineering")
        result = await stat(_accessor(), path)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_drive_is_directory():
    path = PathSpec(resource_path=mount_key("/sp/Engineering/Documents",
                                            "/sp"),
                    virtual="/sp/Engineering/Documents",
                    directory="/sp/Engineering/Documents")
    result = await stat(_accessor(), path)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_file_from_api():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.docx"
    with aioresponses() as m:
        m.get(url,
              payload={
                  "id": "01ITEM",
                  "name": "report.docx",
                  "size": 1234,
                  "lastModifiedDateTime": "2026-05-01T10:00:00Z",
                  "cTag": "ctag-abc",
                  "eTag": "etag-xyz",
                  "file": {
                      "mimeType": "application/vnd.openxml"
                  },
              })
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/report.docx", "/sp"),
                        virtual="/sp/Engineering/Documents/report.docx",
                        directory="/sp/Engineering/Documents/report.docx")
        result = await stat(_accessor(), path)
    assert result.name == "report.docx"
    assert result.size == 1234
    assert result.modified == "2026-05-01T10:00:00Z"
    assert result.fingerprint == "ctag-abc"


@pytest.mark.asyncio
async def test_stat_folder_from_api():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/src"
    with aioresponses() as m:
        m.get(url,
              payload={
                  "id": "02FOLDER",
                  "name": "src",
                  "size": 4096,
                  "lastModifiedDateTime": "2026-05-01T10:00:00Z",
                  "folder": {
                      "childCount": 2
                  },
              })
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/src", "/sp"),
                        virtual="/sp/Engineering/Documents/src",
                        directory="/sp/Engineering/Documents/src")
        result = await stat(_accessor(), path)
    assert result.type == FileType.DIRECTORY
    assert result.name == "src"


@pytest.mark.asyncio
async def test_stat_missing_raises_file_not_found():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/nope.txt"
    with aioresponses() as m:
        m.get(url,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/nope.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/nope.txt",
                        directory="/sp/Engineering/Documents/nope.txt")
        with pytest.raises(FileNotFoundError):
            await stat(_accessor(), path)


@pytest.mark.asyncio
async def test_stat_from_index_after_readdir():
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get(f"{_BASE}/drives/{_DRIVE_ID}/root/children",
              payload={
                  "value": [
                      {
                          "id": "1",
                          "name": "notes.txt",
                          "size": 42,
                          "file": {},
                          "lastModifiedDateTime": "2026-06-19T09:28:00Z"
                      },
                  ]
              })
        parent = PathSpec(resource_path=mount_key("/sp/Engineering/Documents",
                                                  "/sp"),
                          virtual="/sp/Engineering/Documents",
                          directory="/sp/Engineering/Documents")
        await readdir(_accessor(), parent, index)
    path = PathSpec(resource_path=mount_key(
        "/sp/Engineering/Documents/notes.txt", "/sp"),
                    virtual="/sp/Engineering/Documents/notes.txt",
                    directory="/sp/Engineering/Documents/notes.txt")
    result = await stat(_accessor(), path, index)
    assert result.name == "notes.txt"
    assert result.size == 42
    assert result.modified == "2026-06-19T09:28:00Z"


@pytest.mark.asyncio
async def test_stat_site_and_drive_have_no_metadata():
    site_path = PathSpec(resource_path=mount_key("/sp/Engineering", "/sp"),
                         virtual="/sp/Engineering",
                         directory="/sp/Engineering")
    result = await stat(_accessor(), site_path)
    assert result.size is None
    assert result.modified is None

    drive_path = PathSpec(resource_path=mount_key("/sp/Engineering/Documents",
                                                  "/sp"),
                          virtual="/sp/Engineering/Documents",
                          directory="/sp/Engineering/Documents")
    result = await stat(_accessor(), drive_path)
    assert result.size is None
    assert result.modified is None


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file():
    # The fskit invariant behind SIZES_ALWAYS_KNOWN: the size stat reports
    # from the listing must equal the byte length a read delivers, for
    # every file in the tree, 0-byte files included.
    contents = {
        "/notes.txt": b"hello sharepoint",
        "/Docs/empty.bin": b"",
        "/Docs/report.docx": b"docx bytes",
    }
    drive = f"{_BASE}/drives/{_DRIVE_ID}"
    index = RAMIndexCacheStore()
    accessor = _accessor()
    with aioresponses() as m:
        m.get(drive + "/root/children",
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
                          "folder": {
                              "childCount": 2
                          },
                          "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                      },
                  ]
              })
        m.get(drive + "/root:/Docs:/children",
              payload={
                  "value": [{
                      "id": "3",
                      "name": "empty.bin",
                      "size": 0,
                      "file": {},
                      "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                  }, {
                      "id": "4",
                      "name": "report.docx",
                      "size": len(contents["/Docs/report.docx"]),
                      "file": {},
                      "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                  }]
              })
        for path, body in contents.items():
            m.get(drive + f"/root:{path}:/content", body=body)
        files: list[str] = []
        stack = ["/sp/Engineering/Documents"]
        while stack:
            current = stack.pop()
            listing = await readdir(accessor, _ps(current), index)
            for child in listing:
                info = await stat(accessor, _ps(child), index)
                if info.type == FileType.DIRECTORY:
                    stack.append(child)
                else:
                    assert info.size is not None, child
                    files.append(child)
                    body = await read_bytes(accessor, _ps(child))
                    assert info.size == len(body), child
    expected = sorted("/sp/Engineering/Documents" + p for p in contents)
    assert sorted(files) == expected
