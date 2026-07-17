import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.onedrive import COMMANDS
from mirage.core.onedrive._client import GraphError
from mirage.core.onedrive.copy import copy
from mirage.core.onedrive.truncate import truncate
from mirage.types import PathSpec


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_BASE = "https://graph.microsoft.com/v1.0/me/drive"

_cp = next(c for c in COMMANDS if any(
    rc.name == "cp" for rc in getattr(c, "_registered_commands", [])))


@pytest.mark.asyncio
async def test_copy_posts_copy_action_with_name():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=202, payload={})

    with aioresponses() as m:
        m.post(_BASE + "/root:/a.txt:/copy", callback=_cb)
        await copy(_accessor(), PathSpec.from_str_path("/a.txt"),
                   PathSpec.from_str_path("/sub/b.txt"))
    assert body["name"] == "b.txt"
    assert "/root:/sub" in body["parentReference"]["path"]


@pytest.mark.asyncio
async def test_copy_polls_monitor_until_completed():
    monitor = "https://monitor.example/op/123"
    with aioresponses() as m:
        m.post(_BASE + "/root:/a.txt:/copy",
               status=202,
               headers={"Location": monitor})
        m.get(monitor, payload={"status": "completed"})
        await copy(_accessor(), PathSpec.from_str_path("/a.txt"),
                   PathSpec.from_str_path("/b.txt"))


@pytest.mark.asyncio
async def test_copy_raises_when_monitor_reports_failed():
    monitor = "https://monitor.example/op/456"
    with aioresponses() as m:
        m.post(_BASE + "/root:/a.txt:/copy",
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
            await copy(_accessor(), PathSpec.from_str_path("/a.txt"),
                       PathSpec.from_str_path("/b.txt"))


@pytest.mark.asyncio
async def test_copy_file_conflict_deletes_destination_and_retries():
    monitor = "https://monitor.example/op/789"
    with aioresponses() as m:
        m.post(_BASE + "/root:/a.txt:/copy",
               status=202,
               headers={"Location": monitor})
        m.get(monitor,
              payload={
                  "status": "failed",
                  "error": {
                      "code": "nameAlreadyExists",
                      "message": "x"
                  }
              })
        m.get(_BASE + "/root:/a.txt",
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 1,
                  "file": {}
              })
        m.get(_BASE + "/root:/b.txt",
              payload={
                  "id": "2",
                  "name": "b.txt",
                  "size": 1,
                  "file": {}
              })
        m.delete(_BASE + "/root:/b.txt", status=204)
        m.post(_BASE + "/root:/a.txt:/copy", status=202, payload={})
        await copy(_accessor(), PathSpec.from_str_path("/a.txt"),
                   PathSpec.from_str_path("/b.txt"))


@pytest.mark.asyncio
async def test_copy_dir_conflict_merges_per_child():
    monitor = "https://monitor.example/op/m1"
    with aioresponses() as m:
        m.post(_BASE + "/root:/src:/copy",
               status=202,
               headers={"Location": monitor})
        m.get(monitor,
              payload={
                  "status": "failed",
                  "error": {
                      "code": "nameAlreadyExists",
                      "message": "x"
                  }
              })
        m.get(_BASE + "/root:/src",
              payload={
                  "id": "1",
                  "name": "src",
                  "folder": {
                      "childCount": 1
                  }
              })
        m.get(_BASE + "/root:/dst",
              payload={
                  "id": "2",
                  "name": "dst",
                  "folder": {
                      "childCount": 0
                  }
              })
        m.get(_BASE + "/root:/src:/children",
              payload={
                  "value": [{
                      "id": "3",
                      "name": "f.txt",
                      "size": 1,
                      "file": {}
                  }]
              })
        m.post(_BASE + "/root:/src/f.txt:/copy", status=202, payload={})
        await copy(_accessor(), PathSpec.from_str_path("/src"),
                   PathSpec.from_str_path("/dst"))


@pytest.mark.asyncio
async def test_cp_recursive_uses_server_side_folder_copy():
    src = PathSpec.from_str_path("/src")
    dst = PathSpec.from_str_path("/dst")
    with aioresponses() as m:
        m.get(_BASE + "/root:/src:/children",
              payload={
                  "value": [
                      {
                          "id": "1",
                          "name": "a.txt",
                          "size": 3,
                          "file": {}
                      },
                      {
                          "id": "2",
                          "name": "sub",
                          "folder": {
                              "childCount": 1
                          }
                      },
                  ]
              })
        m.get(_BASE + "/root:/src/sub:/children",
              payload={
                  "value": [{
                      "id": "3",
                      "name": "b.txt",
                      "size": 4,
                      "file": {}
                  }]
              })
        m.get(_BASE + "/root:/dst",
              status=404,
              payload={"error": {
                  "code": "itemNotFound"
              }})
        m.get(_BASE + "/root:/src",
              payload={
                  "id": "0",
                  "name": "src",
                  "folder": {
                      "childCount": 2
                  }
              })
        m.post(_BASE + "/root:/src:/copy", status=202, payload={})
        _out, io = await _cp.__wrapped__(_accessor(), [src, dst],
                                         r=True,
                                         index=NULL_INDEX)
    assert set(io.writes) == {"/dst/a.txt", "/dst/sub/b.txt"}


@pytest.mark.asyncio
async def test_truncate_shrinks_content():
    captured = {}

    def _put_cb(url, **kwargs):
        captured["body"] = kwargs.get("data")
        return CallbackResult(status=200, payload={"id": "X"})

    content = _BASE + "/root:/a.txt:/content"
    with aioresponses() as m:
        m.get(content, body=b"hello")
        m.put(content, callback=_put_cb)
        await truncate(_accessor(), PathSpec.from_str_path("/a.txt"), 3)
    assert captured["body"] == b"hel"
