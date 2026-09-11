import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.read import read_bytes
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


@pytest.mark.asyncio
async def test_read_returns_content():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.txt:/content"
    with aioresponses() as m:
        m.get(url, body=b"file content")
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/report.txt", "/sp"),
                        virtual="/sp/Engineering/Documents/report.txt",
                        directory="/sp/Engineering/Documents/report.txt")
        data = await read_bytes(_accessor(), path)
    assert data == b"file content"


@pytest.mark.asyncio
async def test_read_missing_raises_file_not_found():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/nope.txt:/content"
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
            await read_bytes(_accessor(), path)


@pytest.mark.asyncio
async def test_read_range():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/data.bin:/content"
    captured = {}

    def _cb(url, **kwargs):
        captured["range"] = kwargs["headers"].get("Range")
        return CallbackResult(body=b"llo", status=206)

    with aioresponses() as m:
        m.get(url, callback=_cb)
        path = PathSpec(resource_path=mount_key(
            "/sp/Engineering/Documents/data.bin", "/sp"),
                        virtual="/sp/Engineering/Documents/data.bin",
                        directory="/sp/Engineering/Documents/data.bin")
        data = await read_bytes(_accessor(), path, offset=2, size=3)
    assert captured["range"] == "bytes=2-4"
    assert data == b"llo"
