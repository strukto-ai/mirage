import pytest

import mirage.core.msgraph.drive_ops as drive_ops
from mirage.core.msgraph.client import GraphError
from mirage.core.msgraph.config import MsGraphConfig
from mirage.core.msgraph.drive_ops import (DriveLoc, _move_body,
                                           _parent_reference, identity_item,
                                           iter_tree)


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


@pytest.mark.asyncio
async def test_identity_item_found_returns_ctag_fingerprint(monkeypatch):

    async def fake_graph_get(config, url, params=None, session=None):
        return {"id": "1", "name": "a.txt", "cTag": "ctag-1", "file": {}}

    monkeypatch.setattr(drive_ops, "graph_get", fake_graph_get)
    result = await identity_item(MsGraphConfig(access_token="token"),
                                 _loc("d1", "a.txt"), "/a.txt")
    assert result.exists is True
    assert result.fingerprint == "ctag-1"
    # Bounded per the identity contract: identity_item never issues the
    # $expand=versions call capture_item_metadata makes, so revision stays
    # None until a bounded revision call is proven safe.
    assert result.revision is None


@pytest.mark.asyncio
async def test_identity_item_404_reports_exists_false(monkeypatch):

    async def fake_graph_get(config, url, params=None, session=None):
        raise GraphError(404, "itemNotFound", "no")

    monkeypatch.setattr(drive_ops, "graph_get", fake_graph_get)
    result = await identity_item(MsGraphConfig(access_token="token"),
                                 _loc("d1", "missing.txt"), "/missing.txt")
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


@pytest.mark.asyncio
async def test_identity_item_folder_raises_eisdir(monkeypatch):

    async def fake_graph_get(config, url, params=None, session=None):
        return {"id": "2", "name": "dir", "folder": {"childCount": 0}}

    monkeypatch.setattr(drive_ops, "graph_get", fake_graph_get)
    with pytest.raises(IsADirectoryError):
        await identity_item(MsGraphConfig(access_token="token"),
                            _loc("d1", "dir"), "/dir")


@pytest.mark.asyncio
async def test_identity_item_non_404_error_propagates(monkeypatch):

    async def fake_graph_get(config, url, params=None, session=None):
        raise GraphError(500, "serviceUnavailable", "boom")

    monkeypatch.setattr(drive_ops, "graph_get", fake_graph_get)
    with pytest.raises(GraphError):
        await identity_item(MsGraphConfig(access_token="token"),
                            _loc("d1", "a.txt"), "/a.txt")
