import pytest
from aioresponses import aioresponses
from yarl import URL

import mirage.core.msgraph.drive_ops as drive_ops
from mirage.core.msgraph.client import GraphError
from mirage.core.msgraph.config import MsGraphConfig
from mirage.core.msgraph.drive_ops import (DriveLoc, _move_body,
                                           _parent_reference, copy_tree,
                                           iter_tree, rename_replace)

_CONFLICT = {"error": {"code": "nameAlreadyExists", "message": "x"}}


def _url(path: str, action: str = "") -> str:
    return f"https://graph.example/drives/d1/root:/{path}:{action}"


def _ref(folder: str) -> str:
    return f"/drives/d1/root:/{folder}"


def _loc(drive: str, path: str) -> DriveLoc:
    return DriveLoc(drive=drive,
                    path=path,
                    virt=f"/{path}",
                    url=_url,
                    ref=_ref)


async def _list_one_file(config: MsGraphConfig,
                         url: str,
                         session=None) -> list[dict]:
    return [{"name": "a.txt", "size": 3, "file": {}}]


def test_child_extends_path_and_virt():
    child = _loc("d1", "a/b").child("c.txt")
    assert child.path == "a/b/c.txt"
    assert child.virt == "/a/b/c.txt"
    assert child.drive == "d1"


def test_parent_of_top_level_item_is_empty():
    assert _loc("d1", "a.txt").parent() == ""
    assert _loc("d1", "a/b.txt").parent() == "a"


def test_parent_reference_same_drive_has_no_drive_id():
    ref = _parent_reference(_loc("d1", "a.txt"), _loc("d1", "sub/b.txt"))
    assert ref == {"path": _ref("sub")}


def test_parent_reference_cross_drive_adds_drive_id():
    ref = _parent_reference(_loc("d1", "a.txt"), _loc("d2", "sub/b.txt"))
    assert ref["driveId"] == "d2"


def test_move_body_same_parent_is_rename_only():
    body = _move_body(_loc("d1", "a.txt"), _loc("d1", "b.txt"))
    assert body == {"name": "b.txt"}


def test_move_body_new_parent_includes_reference():
    body = _move_body(_loc("d1", "a.txt"), _loc("d1", "sub/b.txt"))
    assert body["parentReference"] == {"path": _ref("sub")}


@pytest.mark.asyncio
async def test_iter_tree_emits_virtual_not_backend_path(monkeypatch):
    monkeypatch.setattr(drive_ops, "graph_list", _list_one_file)
    loc = DriveLoc(drive="d1",
                   path="team/reports",
                   virt="reports",
                   url=_url,
                   ref=_ref)
    entries = [
        entry
        async for entry in iter_tree(MsGraphConfig(access_token="token"), loc)
    ]
    assert entries == [("reports/a.txt", {
        "name": "a.txt",
        "size": 3,
        "file": {}
    }, False)]


# The six request-sequence cases below are the twins of
# `core/src/core/msgraph/drive.test.ts`. The shared drive layer implements
# copy-with-monitor-polling and replace-on-409 for two VFS in two
# languages, and OneDrive/SharePoint are not in the conformance matrix, so
# nothing cross-language covered it (issue #1089 item 16b). They mock at the
# HTTP layer so each case pins a request sequence, not an internal call.


def _config() -> MsGraphConfig:
    return MsGraphConfig(access_token="tok")


@pytest.mark.asyncio
async def test_copy_polls_the_monitor_the_202_pointed_at():
    monitor = "https://monitor.example/op/1"
    with aioresponses() as m:
        m.post(_url("a.txt", "/copy"),
               status=202,
               headers={"Location": monitor})
        m.get(monitor, payload={"status": "completed"})
        await copy_tree(_config(), _loc("d1", "a.txt"), _loc("d1", "b.txt"))
        # Without this the case passes when copy returns straight after the
        # 202 and never confirms the operation finished.
        assert ("GET", URL(monitor)) in m.requests


@pytest.mark.asyncio
async def test_copy_raises_the_provider_code_when_the_monitor_fails():
    monitor = "https://monitor.example/op/2"
    with aioresponses() as m:
        m.post(_url("a.txt", "/copy"),
               status=202,
               headers={"Location": monitor})
        m.get(monitor,
              payload={
                  "status": "failed",
                  "error": {
                      "code": "generalException",
                      "message": "boom"
                  }
              })
        with pytest.raises(GraphError) as exc:
            await copy_tree(_config(), _loc("d1", "a.txt"),
                            _loc("d1", "b.txt"))
    assert exc.value.code == "generalException"
    assert exc.value.status == 500


@pytest.mark.asyncio
async def test_copy_deletes_a_conflicting_file_destination_and_retries():
    monitor = "https://monitor.example/op/3"
    retry = "https://monitor.example/op/3-retry"
    with aioresponses() as m:
        m.post(_url("a.txt", "/copy"),
               status=202,
               headers={"Location": monitor})
        m.get(monitor, payload={"status": "failed", **_CONFLICT})
        m.get(_url("a.txt"),
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 1,
                  "file": {}
              })
        m.get(_url("b.txt"),
              payload={
                  "id": "2",
                  "name": "b.txt",
                  "size": 1,
                  "file": {}
              })
        m.delete(_url("b.txt"), status=204)
        m.post(_url("a.txt", "/copy"), status=202, headers={"Location": retry})
        m.get(retry, payload={"status": "completed"})
        await copy_tree(_config(), _loc("d1", "a.txt"), _loc("d1", "b.txt"))
        assert ("DELETE", URL(_url("b.txt"))) in m.requests
        assert len(m.requests[("POST", URL(_url("a.txt", "/copy")))]) == 2
        assert ("GET", URL(retry)) in m.requests


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["monitor", "http"])
async def test_copy_normalizes_a_failed_replacement_retry(transport):
    retry = "https://monitor.example/op/retry-failed"
    with aioresponses() as m:
        m.post(_url("a.txt", "/copy"), status=409, payload=_CONFLICT)
        m.get(_url("a.txt"), payload={"id": "1", "file": {}})
        m.get(_url("b.txt"), payload={"id": "2", "file": {}})
        m.delete(_url("b.txt"), status=204)
        if transport == "monitor":
            m.post(_url("a.txt", "/copy"),
                   status=202,
                   headers={"Location": retry})
            m.get(retry, payload={"status": "failed", **_CONFLICT})
        else:
            m.post(_url("a.txt", "/copy"), status=409, payload=_CONFLICT)
        with pytest.raises(GraphError) as exc:
            await copy_tree(_config(), _loc("d1", "a.txt"),
                            _loc("d1", "b.txt"))
        assert exc.value.status == 500
        assert exc.value.code == "nameAlreadyExists"
        assert str(exc.value).endswith(": x")
        assert len(m.requests[("DELETE", URL(_url("b.txt")))]) == 1
        assert len(m.requests[("POST", URL(_url("a.txt", "/copy")))]) == 2
        if transport == "monitor":
            assert ("GET", URL(retry)) in m.requests


@pytest.mark.asyncio
async def test_copy_merges_two_folders_per_child_and_deletes_nothing():
    monitor = "https://monitor.example/op/4"
    child_monitor = "https://monitor.example/op/4-child"
    with aioresponses() as m:
        m.post(_url("src", "/copy"), status=202, headers={"Location": monitor})
        m.get(monitor, payload={"status": "failed", **_CONFLICT})
        m.get(_url("src"), payload={"id": "1", "name": "src", "folder": {}})
        m.get(_url("dst"), payload={"id": "2", "name": "dst", "folder": {}})
        m.get(_url("src", "/children"),
              payload={
                  "value": [{
                      "id": "3",
                      "name": "f.txt",
                      "size": 1,
                      "file": {}
                  }]
              })
        m.post(_url("src/f.txt", "/copy"),
               status=202,
               headers={"Location": child_monitor})
        m.get(child_monitor, payload={"status": "completed"})
        await copy_tree(_config(), _loc("d1", "src"), _loc("d1", "dst"))
        assert ("POST", URL(_url("src/f.txt", "/copy"))) in m.requests
        assert ("GET", URL(child_monitor)) in m.requests
        assert not [k for k in m.requests if k[0] == "DELETE"]


@pytest.mark.asyncio
async def test_copy_refuses_a_file_onto_folder_conflict_as_409():
    """The mixed file/folder refusal is a conflict, not a server error.

    TypeScript re-raised the conflict as `copy_once` had produced it, so
    the same refusal carried 500 when it came from a failed monitor and
    409 when it came from a thrown one; python states 409 outright and is
    the side the TypeScript twin was corrected to.
    """
    monitor = "https://monitor.example/op/5"
    with aioresponses() as m:
        m.post(_url("a.txt", "/copy"),
               status=202,
               headers={"Location": monitor})
        m.get(monitor, payload={"status": "failed", **_CONFLICT})
        m.get(_url("a.txt"),
              payload={
                  "id": "1",
                  "name": "a.txt",
                  "size": 1,
                  "file": {}
              })
        m.get(_url("dst"), payload={"id": "2", "name": "dst", "folder": {}})
        with pytest.raises(GraphError) as exc:
            await copy_tree(_config(), _loc("d1", "a.txt"), _loc("d1", "dst"))
        assert not [k for k in m.requests if k[0] == "DELETE"]
    assert exc.value.status == 409
    assert exc.value.code == "nameAlreadyExists"


@pytest.mark.asyncio
async def test_rename_keeps_the_conflict_for_a_non_empty_folder():
    with aioresponses() as m:
        m.patch(_url("src"), status=409, payload=_CONFLICT)
        m.get(_url("dst"), payload={"id": "2", "name": "dst", "folder": {}})
        m.get(_url("dst", "/children"),
              payload={
                  "value": [{
                      "id": "3",
                      "name": "kid",
                      "size": 0,
                      "file": {}
                  }]
              })
        with pytest.raises(GraphError):
            await rename_replace(_config(), _loc("d1", "src"),
                                 _loc("d1", "dst"))
        assert not [k for k in m.requests if k[0] == "DELETE"]
        assert len(m.requests[("PATCH", URL(_url("src")))]) == 1
