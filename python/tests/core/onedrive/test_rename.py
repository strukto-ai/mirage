import re

import pytest
from aioresponses import CallbackResult, aioresponses
from yarl import URL

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.msgraph.client import GraphError
from mirage.core.onedrive.rename import rename
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0/me/drive"

_CONFLICT = {"error": {"code": "nameAlreadyExists", "message": "x"}}


def _staged(name: str, action: str = "") -> re.Pattern[str]:
    return re.compile(
        "^"
        + re.escape(f"{_BASE}/root:/{name}.mirage-")
        + "[0-9a-f]{32}"
        + re.escape(action)
        + "$"
    )


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
        await rename(
            _accessor(),
            PathSpec.from_str_path("/a.txt"),
            PathSpec.from_str_path("/sub/b.txt"),
        )
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
        await rename(
            _accessor(),
            PathSpec.from_str_path("/a.txt"),
            PathSpec.from_str_path("/b.txt"),
        )
    assert body == {"name": "b.txt"}


@pytest.mark.asyncio
async def test_rename_conflict_sets_the_file_aside_then_deletes_it(
    exact_cloud_paths,
):
    staged = _staged("b.txt")
    with aioresponses() as m:
        m.patch(_BASE + "/root:/a.txt", status=409, payload=_CONFLICT)
        m.get(
            _BASE + "/root:/b.txt",
            payload={"id": "2", "name": "b.txt", "size": 1, "file": {}},
        )
        m.get(_BASE + "/root:/a.txt", payload={"id": "1", "file": {}})
        m.patch(_BASE + "/root:/b.txt", status=200, payload={"id": "2"})
        m.patch(_BASE + "/root:/a.txt", status=200, payload={"id": "1"})
        m.delete(staged, status=204)
        await rename(
            _accessor(),
            PathSpec.from_str_path("/a.txt"),
            PathSpec.from_str_path("/b.txt"),
        )
        # aioresponses' __exit__ only calls stop(), so registering the
        # DELETE proves nothing on its own: without these the test passes
        # when rename swallows the 409 and neither sets the file aside nor
        # deletes it.
        (aside,) = m.requests[("PATCH", URL(_BASE + "/root:/b.txt"))]
        assert aside.kwargs["json"]["name"].startswith("b.txt.mirage-")
        moves = m.requests[("PATCH", URL(_BASE + "/root:/a.txt"))]
        assert [mv.kwargs["json"]["name"] for mv in moves] == ["b.txt"] * 2
        deleted = [u for verb, u in m.requests if verb == "DELETE"]
        assert len(deleted) == 1 and staged.match(str(deleted[0]))


@pytest.mark.asyncio
async def test_rename_conflict_replaces_empty_dir_destination(
    exact_cloud_paths,
):
    with aioresponses() as m:
        m.patch(_BASE + "/root:/src", status=409, payload=_CONFLICT)
        m.get(
            _BASE + "/root:/dst",
            payload={"id": "2", "name": "dst", "folder": {"childCount": 0}},
        )
        m.get(_BASE + "/root:/dst:/children", payload={"value": []})
        m.get(_BASE + "/root:/src", payload={"id": "1", "folder": {}})
        m.patch(_BASE + "/root:/dst", status=200, payload={"id": "2"})
        m.patch(_BASE + "/root:/src", status=200, payload={"id": "1"})
        m.get(_staged("dst", ":/children"), payload={"value": []})
        m.delete(_staged("dst"), status=204)
        await rename(
            _accessor(),
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path("/dst"),
        )
        # The folder is asked for children twice: before it moves aside,
        # and again, where it was set aside, just before its delete.
        probes = [
            u
            for verb, u in m.requests
            if verb == "GET" and str(u).endswith(":/children")
        ]
        assert str(probes[0]) == _BASE + "/root:/dst:/children"
        assert _staged("dst", ":/children").match(str(probes[1]))
        deleted = [u for verb, u in m.requests if verb == "DELETE"]
        assert len(deleted) == 1 and _staged("dst").match(str(deleted[0]))
        assert len(m.requests[("PATCH", URL(_BASE + "/root:/src"))]) == 2


@pytest.mark.asyncio
async def test_rename_conflict_keeps_error_for_nonempty_dir():
    with aioresponses() as m:
        m.patch(_BASE + "/root:/src", status=409, payload=_CONFLICT)
        m.get(
            _BASE + "/root:/dst",
            payload={"id": "2", "name": "dst", "folder": {"childCount": 1}},
        )
        m.get(
            _BASE + "/root:/dst:/children",
            payload={
                "value": [{"id": "3", "name": "kid", "size": 0, "file": {}}]
            },
        )
        with pytest.raises(GraphError):
            await rename(
                _accessor(),
                PathSpec.from_str_path("/src"),
                PathSpec.from_str_path("/dst"),
            )


pytestmark = pytest.mark.usefixtures("exact_cloud_paths")
