import re
from typing import Any

import pytest
from aioresponses import CallbackResult, aioresponses
from yarl import URL

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.context import push_cache_manager
from mirage.core.msgraph.client import GraphError
from mirage.core.sharepoint.rename import rename
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_DRIVE = f"{_BASE}/drives/{_DRIVE_ID}"
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


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


def _spec(rel: str) -> PathSpec:
    virtual = f"/sp/Engineering/Documents/{rel}"
    return PathSpec(
        vfs_path=mount_key(virtual, "/sp"), virtual=virtual, directory=virtual
    )


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
        m.get(
            _DRIVE + "/root:/b.txt",
            payload={"id": "2", "name": "b.txt", "size": 1, "file": {}},
        )
        m.delete(_DRIVE + "/root:/b.txt", status=204)
        m.patch(_DRIVE + "/root:/a.txt", status=200, payload={"id": "1"})
        await rename(_accessor(), _spec("a.txt"), _spec("b.txt"))
        assert ("DELETE", URL(_DRIVE + "/root:/b.txt")) in m.requests
        assert len(m.requests[("PATCH", URL(_DRIVE + "/root:/a.txt"))]) == 2


@pytest.mark.asyncio
async def test_rename_conflict_keeps_error_for_nonempty_dir():
    with aioresponses() as m:
        m.patch(_DRIVE + "/root:/src", status=409, payload=_CONFLICT)
        m.get(
            _DRIVE + "/root:/dst",
            payload={"id": "2", "name": "dst", "folder": {"childCount": 1}},
        )
        m.get(
            _DRIVE + "/root:/dst:/children",
            payload={
                "value": [{"id": "3", "name": "kid", "size": 0, "file": {}}]
            },
        )
        with pytest.raises(GraphError):
            await rename(_accessor(), _spec("src"), _spec("dst"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "src,dst,named",
    [
        (
            "/sp/Nope/Documents/a.txt",
            "/sp/Engineering/Documents/b.txt",
            "/sp/Nope/Documents/a.txt",
        ),
        (
            "/sp/Engineering/Documents/a.txt",
            "/sp/Nope/Documents/b.txt",
            "/sp/Nope/Documents/b.txt",
        ),
    ],
)
async def test_rename_names_the_side_that_does_not_resolve(src, dst, named):
    with aioresponses() as m:
        m.get(
            re.compile(r".*/sites\?.*"),
            payload={
                "value": [{"id": _SITE_ID, "displayName": "Engineering"}]
            },
            repeat=True,
        )
        with pytest.raises(FileNotFoundError) as exc:
            await rename(
                _accessor(),
                PathSpec(
                    vfs_path=mount_key(src, "/sp"), virtual=src, directory=src
                ),
                PathSpec(
                    vfs_path=mount_key(dst, "/sp"), virtual=dst, directory=dst
                ),
            )
    assert str(exc.value) == named


async def _moved(reply: dict) -> list[tuple[str, str]]:
    moves = _Moves()
    prev = push_cache_manager(moves)
    try:
        with aioresponses() as m:
            m.patch(_DRIVE + "/root:/a", status=200, payload=reply)
            await rename(_accessor(), _spec("a"), _spec("b"))
    finally:
        push_cache_manager(prev)
    return moves.calls


@pytest.mark.asyncio
async def test_a_renamed_file_drops_no_subtree():
    # The PATCH reply names what moved: a file facet means nothing was
    # cached beneath either name.
    assert await _moved({"id": "1", "file": {}}) == [
        ("unlink", "/sp/Engineering/Documents/b"),
        ("unlink", "/sp/Engineering/Documents/a"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply", [{"id": "1", "folder": {"childCount": 2}}, {"id": "1"}]
)
async def test_a_renamed_folder_or_an_unnamed_item_drops_both_subtrees(reply):
    # Only a positive file facet narrows: a reply that names no type
    # leaves both ends dropping their subtrees.
    assert await _moved(reply) == [
        ("subtree", "/sp/Engineering/Documents/b"),
        ("subtree", "/sp/Engineering/Documents/a"),
    ]


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
            m.patch(_DRIVE + "/root:/a", status=409, payload=_CONFLICT)
            m.get(_DRIVE + "/root:/dst", payload=dst_item)
            m.get(_DRIVE + "/root:/dst:/children", payload={"value": []})
            m.delete(_DRIVE + "/root:/dst", status=204)
            m.patch(
                _DRIVE + "/root:/a",
                status=200,
                payload={"id": "1", "file": {}},
            )
            await rename(_accessor(), _spec("a"), _spec("dst"))
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
    assert await _replaced(dst_item) == [
        (dst_drop, "/sp/Engineering/Documents/dst"),
        ("unlink", "/sp/Engineering/Documents/a"),
    ]
