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


def _staged(name: str) -> re.Pattern[str]:
    return re.compile(
        "^" + re.escape(f"{_BASE}/root:/{name}.mirage-") + "[0-9a-f]{32}$"
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
async def test_rename_conflict_lands_beside_then_deletes_file_destination(
    exact_cloud_paths,
):
    staged = _staged("b.txt")
    with aioresponses() as m:
        m.patch(_BASE + "/root:/a.txt", status=409, payload=_CONFLICT)
        m.get(
            _BASE + "/root:/b.txt",
            payload={"id": "2", "name": "b.txt", "size": 1, "file": {}},
        )
        m.patch(_BASE + "/root:/a.txt", status=200, payload={"id": "1"})
        m.delete(_BASE + "/root:/b.txt", status=204)
        m.patch(staged, status=200, payload={"id": "1", "name": "b.txt"})
        await rename(
            _accessor(),
            PathSpec.from_str_path("/a.txt"),
            PathSpec.from_str_path("/b.txt"),
        )
        # aioresponses' __exit__ only calls stop(), so registering the
        # DELETE proves nothing on its own: without these the test passes
        # when rename swallows the 409 and does neither the delete nor
        # the move that lands beside it.
        assert ("DELETE", URL(_BASE + "/root:/b.txt")) in m.requests
        moves = m.requests[("PATCH", URL(_BASE + "/root:/a.txt"))]
        assert len(moves) == 2
        assert moves[1].kwargs["json"]["name"].startswith("b.txt.mirage-")
        named = [u for verb, u in m.requests if staged.match(str(u))]
        assert len(named) == 1


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
        m.patch(_BASE + "/root:/src", status=200, payload={"id": "1"})
        m.get(_BASE + "/root:/dst:/children", payload={"value": []})
        m.delete(_BASE + "/root:/dst", status=204)
        m.patch(_staged("dst"), status=200, payload={"id": "1"})
        await rename(
            _accessor(),
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path("/dst"),
        )
        # The folder is asked for children twice: before the source moves
        # beside it, and again just before its delete.
        probes = m.requests[("GET", URL(_BASE + "/root:/dst:/children"))]
        assert len(probes) == 2
        assert ("DELETE", URL(_BASE + "/root:/dst")) in m.requests
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
