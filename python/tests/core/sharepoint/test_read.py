import re

import pytest
from aioresponses import CallbackResult, aioresponses
from yarl import URL

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.read import read_bytes
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_BYTES = "https://download.example/item"


def _item(download: str | None = _BYTES) -> dict:
    item = {"id": "01", "cTag": "ctag-xyz", "eTag": "etag-xyz"}
    if download is not None:
        item["@microsoft.graph.downloadUrl"] = download
    return item


def _calls(m: aioresponses, url: str) -> int:
    return len(m.requests.get(("GET", URL(url)), []))


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


@pytest.mark.asyncio
async def test_read_returns_content():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.txt"
    with aioresponses() as m:
        m.get(url, payload=_item())
        m.get(_BYTES, body=b"file content")
        path = PathSpec(vfs_path=mount_key(
            "/sp/Engineering/Documents/report.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/report.txt",
                        directory="/sp/Engineering/Documents/report.txt")
        data = await read_bytes(_accessor(), path)
        assert (_calls(m, url), _calls(m, _BYTES)) == (1, 1)
    assert data == b"file content"


@pytest.mark.asyncio
async def test_an_unrecorded_read_fetches_the_item_then_its_download_url():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.txt"
    seen: list[tuple[str, str | None]] = []

    def item(url, **kwargs):
        seen.append(("item", kwargs["headers"].get("Authorization")))
        return CallbackResult(payload=_item())

    def download(url, **kwargs):
        seen.append(("download", kwargs["headers"].get("Authorization")))
        return CallbackResult(body=b"file content")

    with aioresponses() as m:
        m.get(url, callback=item)
        m.get(_BYTES, callback=download)
        path = PathSpec(vfs_path=mount_key(
            "/sp/Engineering/Documents/report.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/report.txt",
                        directory="/sp/Engineering/Documents/report.txt")
        data = await read_bytes(_accessor(), path)
    assert data == b"file content"
    # Token first, then the pre-signed download without the bearer token.
    assert seen == [("item", "Bearer tok"), ("download", None)]


@pytest.mark.asyncio
async def test_a_read_falls_back_to_content_when_graph_omits_the_download_url():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.txt"
    with aioresponses() as m:
        m.get(url, payload=_item(download=None))
        m.get(f"{url}:/content", body=b"file content")
        path = PathSpec(vfs_path=mount_key(
            "/sp/Engineering/Documents/report.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/report.txt",
                        directory="/sp/Engineering/Documents/report.txt")
        data = await read_bytes(_accessor(), path)
        assert (_calls(m, url), _calls(m, f"{url}:/content")) == (1, 1)
    assert data == b"file content"


@pytest.mark.asyncio
async def test_read_missing_raises_file_not_found():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/nope.txt"
    with aioresponses() as m:
        m.get(url,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        path = PathSpec(vfs_path=mount_key(
            "/sp/Engineering/Documents/nope.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/nope.txt",
                        directory="/sp/Engineering/Documents/nope.txt")
        with pytest.raises(FileNotFoundError):
            await read_bytes(_accessor(), path)


@pytest.mark.asyncio
async def test_read_range():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/data.bin"
    captured = {}

    def _cb(url, **kwargs):
        captured["range"] = kwargs["headers"].get("Range")
        return CallbackResult(body=b"llo", status=206)

    with aioresponses() as m:
        m.get(url, payload=_item())
        m.get(_BYTES, callback=_cb)
        path = PathSpec(vfs_path=mount_key(
            "/sp/Engineering/Documents/data.bin", "/sp"),
                        virtual="/sp/Engineering/Documents/data.bin",
                        directory="/sp/Engineering/Documents/data.bin")
        data = await read_bytes(_accessor(), path, offset=2, size=3)
    assert captured["range"] == "bytes=2-4"
    assert data == b"llo"


@pytest.mark.asyncio
async def test_recorded_read_names_the_virtual_path():
    # The site is named like its mount, so m/Documents/k.txt is not virtual.
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["m"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    spec = PathSpec(virtual="/m/m/Documents/k.txt",
                    directory="/m/m/Documents/",
                    vfs_path="m/Documents/k.txt")
    scope = RecordingScope()
    try:
        with aioresponses() as m:
            m.get(re.compile(r".*/root:/k\.txt(\?.*)?$"),
                  payload={
                      "id": "01",
                      "cTag": "c1",
                      "versions": []
                  })
            m.get(f"{_BASE}/drives/{_DRIVE_ID}/root:/k.txt:/content",
                  body=b"bytes")
            data = await read_bytes(accessor, spec)
    finally:
        scope.close()
    assert data == b"bytes"
    assert [r.path for r in scope.records] == ["/m/m/Documents/k.txt"]
