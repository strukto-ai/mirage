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

    async def invalidate_after_move(
        self, path: PathSpec, folder: bool
    ) -> None:
        self.calls.append(("subtree" if folder else "unlink", path.virtual))

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


async def _moved(reply: dict) -> list[tuple[str, str]]:
    moves = _Moves()
    prev = push_cache_manager(moves)
    try:
        with aioresponses() as m:
            m.patch(_BASE + "/root:/a", status=200, payload=reply)
            await rename(
                _accessor(),
                PathSpec.from_str_path("/a"),
                PathSpec.from_str_path("/b"),
            )
    finally:
        push_cache_manager(prev)
    return moves.calls


@pytest.mark.asyncio
async def test_a_renamed_file_drops_no_subtree():
    # The PATCH reply names what moved: a file facet means nothing was
    # cached beneath either name.
    assert await _moved({"id": "1", "file": {}}) == [
        ("unlink", "/b"),
        ("unlink", "/a"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply", [{"id": "1", "folder": {"childCount": 2}}, {"id": "1"}]
)
async def test_a_renamed_folder_or_an_unnamed_item_drops_both_subtrees(reply):
    # Only a positive file facet narrows: a reply that names no type
    # leaves both ends dropping their subtrees.
    assert await _moved(reply) == [("subtree", "/b"), ("subtree", "/a")]


async def _replaced(dst_item: dict[str, Any]) -> list[tuple[str, str]]:
    """Rename a file onto `dst` through the conflict path and return the
    invalidations it made.

    Args:
        dst_item (dict[str, Any]): what the conflict GET answers for dst.
    """
    moves = _Moves()
    prev = push_cache_manager(moves)
    try:
        with aioresponses() as m:
            m.patch(_BASE + "/root:/a", status=409, payload=_CONFLICT)
            m.get(_BASE + "/root:/dst", payload=dst_item)
            m.get(_BASE + "/root:/dst:/children", payload={"value": []})
            m.delete(_BASE + "/root:/dst", status=204)
            m.patch(
                _BASE + "/root:/a", status=200, payload={"id": "1", "file": {}}
            )
            await rename(
                _accessor(),
                PathSpec.from_str_path("/a"),
                PathSpec.from_str_path("/dst"),
            )
    finally:
        push_cache_manager(prev)
    return moves.calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("dst_item", "dst_drop"),
    [
        ({"id": "2", "name": "dst", "folder": {}}, "subtree"),
        ({"id": "2", "name": "dst"}, "subtree"),
        ({"id": "2", "name": "dst", "file": {}}, "unlink"),
    ],
    ids=["empty-folder", "no-kind", "file"],
)
async def test_a_file_replacing_anything_but_a_file_drops_its_subtree(
    dst_item, dst_drop
):
    # The rename deleted whatever was at dst. Unless it was positively a
    # file, its name may still have cached children (removed outside
    # mirage, say), so dst takes the subtree; a replaced file stays narrow.
    assert await _replaced(dst_item) == [(dst_drop, "/dst"), ("unlink", "/a")]


@pytest.mark.asyncio
async def test_a_null_move_reply_still_completes_the_rename():
    # A literal `null` body parses to None. The move has already happened,
    # so the rename must finish and evict, taking the subtree because the
    # reply named no kind.
    moves = _Moves()
    prev = push_cache_manager(moves)
    try:
        with aioresponses() as m:
            m.patch(
                _BASE + "/root:/a",
                status=200,
                body="null",
                content_type="application/json",
            )
            await rename(
                _accessor(),
                PathSpec.from_str_path("/a"),
                PathSpec.from_str_path("/b"),
            )
    finally:
        push_cache_manager(prev)
    assert moves.calls == [("subtree", "/b"), ("subtree", "/a")]
