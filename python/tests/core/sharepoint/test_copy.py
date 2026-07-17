import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint._client import GraphError
from mirage.core.sharepoint._resolver import _drive_cache, _site_cache
from mirage.core.sharepoint.copy import copy
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_DRIVE = f"{_BASE}/drives/{_DRIVE_ID}"
_CONFLICT = {
    "status": "failed",
    "error": {
        "code": "nameAlreadyExists",
        "message": "x"
    },
}


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
async def test_copy_posts_copy_action_with_name():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=202, payload={})

    with aioresponses() as m:
        m.post(_DRIVE + "/root:/a.txt:/copy", callback=_cb)
        await copy(_accessor(), _spec("a.txt"), _spec("sub/b.txt"))
    assert body["name"] == "b.txt"
    assert body["parentReference"]["path"].endswith("/root:/sub")
    assert "driveId" not in body["parentReference"]


@pytest.mark.asyncio
async def test_copy_raises_when_monitor_reports_failed():
    monitor = "https://monitor.example/sp/0"
    with aioresponses() as m:
        m.post(_DRIVE + "/root:/a.txt:/copy",
               status=202,
               headers={"Location": monitor})
        m.get(monitor,
              payload={
                  "status": "failed",
                  "error": {
                      "code": "generalException",
                      "message": "x"
                  }
              })
        with pytest.raises(GraphError):
            await copy(_accessor(), _spec("a.txt"), _spec("b.txt"))


@pytest.mark.asyncio
async def test_copy_file_conflict_deletes_destination_and_retries():
    monitor = "https://monitor.example/sp/1"
    with aioresponses() as m:
        m.post(_DRIVE + "/root:/a.txt:/copy",
               status=202,
               headers={"Location": monitor})
        m.get(monitor, payload=_CONFLICT)
        m.get(_DRIVE + "/root:/a.txt",
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 1,
                  "file": {}
              })
        m.get(_DRIVE + "/root:/b.txt",
              payload={
                  "id": "2",
                  "name": "b.txt",
                  "size": 1,
                  "file": {}
              })
        m.delete(_DRIVE + "/root:/b.txt", status=204)
        m.post(_DRIVE + "/root:/a.txt:/copy", status=202, payload={})
        await copy(_accessor(), _spec("a.txt"), _spec("b.txt"))


@pytest.mark.asyncio
async def test_copy_dir_conflict_merges_per_child():
    monitor = "https://monitor.example/sp/2"
    with aioresponses() as m:
        m.post(_DRIVE + "/root:/src:/copy",
               status=202,
               headers={"Location": monitor})
        m.get(monitor, payload=_CONFLICT)
        m.get(_DRIVE + "/root:/src",
              payload={
                  "id": "1",
                  "name": "src",
                  "folder": {
                      "childCount": 1
                  }
              })
        m.get(_DRIVE + "/root:/dst",
              payload={
                  "id": "2",
                  "name": "dst",
                  "folder": {
                      "childCount": 0
                  }
              })
        m.get(_DRIVE + "/root:/src:/children",
              payload={
                  "value": [{
                      "id": "3",
                      "name": "f.txt",
                      "size": 1,
                      "file": {}
                  }]
              })
        m.post(_DRIVE + "/root:/src/f.txt:/copy", status=202, payload={})
        await copy(_accessor(), _spec("src"), _spec("dst"))
