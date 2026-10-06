from typing import Any

import pytest
from aioresponses import CallbackResult, aioresponses
from yarl import URL

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.context import push_cache_manager
from mirage.core.msgraph.client import GraphError
from mirage.core.onedrive.rename import rename
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0/me/drive"

_CONFLICT = {"error": {"code": "nameAlreadyExists", "message": "x"}}


class _Moves:
    """Which invalidation each end of a rename took, in call order."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.calls.append(("unlink", path.virtual))

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.calls.append(("subtree", path.virtual))

    async def invalidate_ancestors(self, path: PathSpec) -> None:
        return None


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
async def test_rename_conflict_deletes_file_destination_and_retries():
    with aioresponses() as m:
        m.patch(_BASE + "/root:/a.txt", status=409, payload=_CONFLICT)
        m.get(
            _BASE + "/root:/b.txt",
            payload={"id": "2", "name": "b.txt", "size": 1, "file": {}},
        )
        m.delete(_BASE + "/root:/b.txt", status=204)
        m.patch(_BASE + "/root:/a.txt", status=200, payload={"id": "1"})
        await rename(
            _accessor(),
            PathSpec.from_str_path("/a.txt"),
            PathSpec.from_str_path("/b.txt"),
        )
        # aioresponses' __exit__ only calls stop(), so registering the
        # DELETE proves nothing on its own: without these the test passes
        # when rename swallows the 409 and does neither the delete nor
        # the retry.
        assert ("DELETE", URL(_BASE + "/root:/b.txt")) in m.requests
        assert len(m.requests[("PATCH", URL(_BASE + "/root:/a.txt"))]) == 2


@pytest.mark.asyncio
async def test_rename_conflict_replaces_empty_dir_destination():
    with aioresponses() as m:
        m.patch(_BASE + "/root:/src", status=409, payload=_CONFLICT)
        m.get(
            _BASE + "/root:/dst",
            payload={"id": "2", "name": "dst", "folder": {"childCount": 0}},
        )
        m.get(_BASE + "/root:/dst:/children", payload={"value": []})
        m.delete(_BASE + "/root:/dst", status=204)
        m.patch(_BASE + "/root:/src", status=200, payload={"id": "1"})
        await rename(
            _accessor(),
            PathSpec.from_str_path("/src"),
            PathSpec.from_str_path("/dst"),
        )
        assert ("GET", URL(_BASE + "/root:/dst:/children")) in m.requests
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


async def _moved(
    reply: dict[str, Any], dst_item: dict[str, Any] | None
) -> list[tuple[str, str]]:
    """Rename a to b and return the invalidation each end took.

    Args:
        reply (dict[str, Any]): the successful PATCH's mock arguments.
        dst_item (dict[str, Any] | None): with one, the first PATCH
            conflicts and the GET of b answers this.
    """
    moves = _Moves()
    prev = push_cache_manager(moves)
    try:
        with aioresponses() as m:
            if dst_item is not None:
                m.patch(_BASE + "/root:/a", status=409, payload=_CONFLICT)
                m.get(_BASE + "/root:/b", payload=dst_item)
                m.get(_BASE + "/root:/b:/children", payload={"value": []})
                m.delete(_BASE + "/root:/b", status=204)
            m.patch(_BASE + "/root:/a", status=200, **reply)
            await rename(
                _accessor(),
                PathSpec.from_str_path("/a"),
                PathSpec.from_str_path("/b"),
            )
    finally:
        push_cache_manager(prev)
    return moves.calls


_FILE = {"payload": {"id": "1", "file": {}}}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reply", "dst_item", "drops"),
    [
        (_FILE, None, ("unlink", "unlink")),
        (
            {"payload": {"id": "1", "folder": {"childCount": 2}}},
            None,
            ("subtree", "subtree"),
        ),
        ({"payload": {"id": "1"}}, None, ("subtree", "subtree")),
        (
            {"body": "null", "content_type": "application/json"},
            None,
            ("subtree", "subtree"),
        ),
        (_FILE, {"id": "2", "folder": {}}, ("subtree", "unlink")),
        (_FILE, {"id": "2"}, ("subtree", "unlink")),
        (_FILE, {"id": "2", "file": {}}, ("unlink", "unlink")),
    ],
    ids=[
        "file",
        "folder",
        "no-kind",
        "null-reply",
        "over-empty-folder",
        "over-no-kind",
        "over-file",
    ],
)
async def test_only_a_moved_file_narrows_and_only_onto_a_file(
    reply, dst_item, drops
):
    # The PATCH reply names what moved: only a file facet spares the
    # subtree. A destination the move replaced keeps its subtree unless
    # that was positively a file: its name may still have cached children
    # removed outside mirage.
    assert await _moved(reply, dst_item) == [
        (drops[0], "/b"),
        (drops[1], "/a"),
    ]
