import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.onedrive.read import read_bytes
from mirage.core.onedrive.readdir import readdir
from mirage.core.onedrive.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_FILE_URL = ("https://graph.microsoft.com/v1.0/me/drive"
             "/root:/Docs/report.docx")
_DIR_URL = "https://graph.microsoft.com/v1.0/me/drive/root:/Docs"


@pytest.mark.asyncio
async def test_stat_root_is_directory():
    with aioresponses() as m:
        m.get("https://graph.microsoft.com/v1.0/me/drive/root",
              payload={
                  "id": "01ROOT",
                  "name": "root",
                  "size": 4096,
                  "folder": {
                      "childCount": 2
                  },
                  "lastModifiedDateTime": "2026-05-01T10:00:00Z",
              })
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
        m.get(_FILE_URL,
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
        result = await stat(_accessor(),
                            PathSpec.from_str_path("/Docs/report.docx"))
    assert result.name == "report.docx"
    assert result.size == 1234
    assert result.fingerprint == "ctag-abc"
    assert result.extra["id"] == "01ITEM"


@pytest.mark.asyncio
async def test_stat_folder_is_directory():
    with aioresponses() as m:
        m.get(_DIR_URL,
              payload={
                  "id": "01FOLDER",
                  "name": "Docs",
                  "size": 4096,
                  "lastModifiedDateTime": "2026-05-01T10:00:00Z",
                  "folder": {
                      "childCount": 2
                  },
              })
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
        m.get(_FILE_URL,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        with pytest.raises(FileNotFoundError) as exc:
            await stat(
                _accessor(),
                PathSpec.from_str_path(
                    "/od/Docs/report.docx",
                    mount_key("/od/Docs/report.docx", "/od")))
    assert str(exc.value) == "/od/Docs/report.docx"


@pytest.mark.asyncio
async def test_stat_from_index_returns_modified():
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get("https://graph.microsoft.com/v1.0/me/drive/root/children",
              payload={
                  "value": [{
                      "id": "1",
                      "name": "notes.txt",
                      "size": 42,
                      "file": {},
                      "lastModifiedDateTime": "2026-06-19T09:28:00Z",
                  }]
              })
        await readdir(_accessor(), PathSpec.from_str_path("/"), index)
    result = await stat(_accessor(), PathSpec.from_str_path("/notes.txt"),
                        index)
    assert result.name == "notes.txt"
    assert result.size == 42
    assert result.modified == "2026-06-19T09:28:00Z"


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file():
    # The fskit invariant behind SIZES_ALWAYS_KNOWN: the size stat reports
    # from the listing must equal the byte length a read delivers, for
    # every file in the tree, 0-byte files included.
    contents = {
        "/notes.txt": b"hello onedrive",
        "/Docs/empty.bin": b"",
        "/Docs/report.docx": b"docx bytes",
    }
    base = "https://graph.microsoft.com/v1.0/me/drive"
    index = RAMIndexCacheStore()
    accessor = _accessor()
    with aioresponses() as m:
        m.get(base + "/root/children",
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
        m.get(base + "/root:/Docs:/children",
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
            m.get(base + f"/root:{path}:/content", body=body)
        files: list[str] = []
        stack = ["/"]
        while stack:
            current = stack.pop()
            listing = await readdir(accessor, PathSpec.from_str_path(current),
                                    index)
            for child in listing:
                info = await stat(accessor, PathSpec.from_str_path(child),
                                  index)
                if info.type == FileType.DIRECTORY:
                    stack.append(child)
                else:
                    assert info.size is not None, child
                    files.append(child)
                    body = await read_bytes(accessor,
                                            PathSpec.from_str_path(child))
                    assert info.size == len(body), child
    assert sorted(files) == sorted(contents)


@pytest.mark.asyncio
async def test_stat_from_index_folder_returns_modified():
    index = RAMIndexCacheStore()
    with aioresponses() as m:
        m.get("https://graph.microsoft.com/v1.0/me/drive/root/children",
              payload={
                  "value": [{
                      "id": "2",
                      "name": "Docs",
                      "folder": {
                          "childCount": 5
                      },
                      "size": 9000,
                      "lastModifiedDateTime": "2026-05-28T02:10:00Z",
                  }]
              })
        await readdir(_accessor(), PathSpec.from_str_path("/"), index)
    result = await stat(_accessor(), PathSpec.from_str_path("/Docs"), index)
    assert result.type == FileType.DIRECTORY
    assert result.modified == "2026-05-28T02:10:00Z"
    assert result.size is None
    assert result.extra["size_bytes"] == 9000
