import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint._client import GraphError
from mirage.core.sharepoint._resolver import _drive_cache, _site_cache
from mirage.core.sharepoint.rename import rename
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_DRIVE = f"{_BASE}/drives/{_DRIVE_ID}"
_CONFLICT = {"error": {"code": "nameAlreadyExists", "message": "x"}}


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


def _spec(rel: str) -> PathSpec:
    virtual = f"/sp/Engineering/Documents/{rel}"
    return PathSpec(resource_path=mount_key(virtual, "/sp"),
                    virtual=virtual,
                    directory=virtual)


@pytest.fixture(autouse=True)
def _seeded_caches():
    _site_cache.clear()
    _drive_cache.clear()
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    yield
    _site_cache.clear()
    _drive_cache.clear()


@pytest.mark.asyncio
async def test_rename_patches_name_and_parent():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"id": "1"})

    with aioresponses() as m:
        m.patch(_DRIVE + "/root:/a.txt", callback=_cb)
        await rename(_accessor(), _spec("a.txt"), _spec("sub/b.txt"))
    assert body["name"] == "b.txt"
    assert body["parentReference"]["path"].endswith("/root:/sub")


@pytest.mark.asyncio
async def test_rename_same_parent_omits_parent_reference():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"id": "1"})

    with aioresponses() as m:
        m.patch(_DRIVE + "/root:/a.txt", callback=_cb)
        await rename(_accessor(), _spec("a.txt"), _spec("b.txt"))
    assert body == {"name": "b.txt"}


@pytest.mark.asyncio
async def test_rename_conflict_deletes_file_destination_and_retries():
    with aioresponses() as m:
        m.patch(_DRIVE + "/root:/a.txt", status=409, payload=_CONFLICT)
        m.get(_DRIVE + "/root:/b.txt",
              payload={
                  "id": "2",
                  "name": "b.txt",
                  "size": 1,
                  "file": {}
              })
        m.delete(_DRIVE + "/root:/b.txt", status=204)
        m.patch(_DRIVE + "/root:/a.txt", status=200, payload={"id": "1"})
        await rename(_accessor(), _spec("a.txt"), _spec("b.txt"))


@pytest.mark.asyncio
async def test_rename_conflict_keeps_error_for_nonempty_dir():
    with aioresponses() as m:
        m.patch(_DRIVE + "/root:/src", status=409, payload=_CONFLICT)
        m.get(_DRIVE + "/root:/dst",
              payload={
                  "id": "2",
                  "name": "dst",
                  "folder": {
                      "childCount": 1
                  }
              })
        m.get(_DRIVE + "/root:/dst:/children",
              payload={
                  "value": [{
                      "id": "3",
                      "name": "kid",
                      "size": 0,
                      "file": {}
                  }]
              })
        with pytest.raises(GraphError):
            await rename(_accessor(), _spec("src"), _spec("dst"))
