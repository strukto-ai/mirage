import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive._client import GraphError
from mirage.core.onedrive.rename import rename
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0/me/drive"

_CONFLICT = {"error": {"code": "nameAlreadyExists", "message": "x"}}


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


@pytest.mark.asyncio
async def test_rename_patches_name_and_parent():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"id": "1"})

    with aioresponses() as m:
        m.patch(_BASE + "/root:/a.txt", callback=_cb)
        await rename(_accessor(), PathSpec.from_str_path("/a.txt"),
                     PathSpec.from_str_path("/sub/b.txt"))
    assert body["name"] == "b.txt"
    assert "/root:/sub" in body["parentReference"]["path"]


@pytest.mark.asyncio
async def test_rename_same_parent_omits_parent_reference():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=200, payload={"id": "1"})

    with aioresponses() as m:
        m.patch(_BASE + "/root:/a.txt", callback=_cb)
        await rename(_accessor(), PathSpec.from_str_path("/a.txt"),
                     PathSpec.from_str_path("/b.txt"))
    assert body == {"name": "b.txt"}


@pytest.mark.asyncio
async def test_rename_conflict_deletes_file_destination_and_retries():
    with aioresponses() as m:
        m.patch(_BASE + "/root:/a.txt", status=409, payload=_CONFLICT)
        m.get(_BASE + "/root:/b.txt",
              payload={
                  "id": "2",
                  "name": "b.txt",
                  "size": 1,
                  "file": {}
              })
        m.delete(_BASE + "/root:/b.txt", status=204)
        m.patch(_BASE + "/root:/a.txt", status=200, payload={"id": "1"})
        await rename(_accessor(), PathSpec.from_str_path("/a.txt"),
                     PathSpec.from_str_path("/b.txt"))


@pytest.mark.asyncio
async def test_rename_conflict_replaces_empty_dir_destination():
    with aioresponses() as m:
        m.patch(_BASE + "/root:/src", status=409, payload=_CONFLICT)
        m.get(_BASE + "/root:/dst",
              payload={
                  "id": "2",
                  "name": "dst",
                  "folder": {
                      "childCount": 0
                  }
              })
        m.get(_BASE + "/root:/dst:/children", payload={"value": []})
        m.delete(_BASE + "/root:/dst", status=204)
        m.patch(_BASE + "/root:/src", status=200, payload={"id": "1"})
        await rename(_accessor(), PathSpec.from_str_path("/src"),
                     PathSpec.from_str_path("/dst"))


@pytest.mark.asyncio
async def test_rename_conflict_keeps_error_for_nonempty_dir():
    with aioresponses() as m:
        m.patch(_BASE + "/root:/src", status=409, payload=_CONFLICT)
        m.get(_BASE + "/root:/dst",
              payload={
                  "id": "2",
                  "name": "dst",
                  "folder": {
                      "childCount": 1
                  }
              })
        m.get(_BASE + "/root:/dst:/children",
              payload={
                  "value": [{
                      "id": "3",
                      "name": "kid",
                      "size": 0,
                      "file": {}
                  }]
              })
        with pytest.raises(GraphError):
            await rename(_accessor(), PathSpec.from_str_path("/src"),
                         PathSpec.from_str_path("/dst"))
