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

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.calls.append(("unlink", path.virtual))

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
                m.patch(_DRIVE + "/root:/a", status=409, payload=_CONFLICT)
                m.get(_DRIVE + "/root:/b", payload=dst_item)
                m.get(_DRIVE + "/root:/b:/children", payload={"value": []})
                m.delete(_DRIVE + "/root:/b", status=204)
            m.patch(_DRIVE + "/root:/a", status=200, **reply)
            await rename(_accessor(), _spec("a"), _spec("b"))
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
        (_FILE, {"id": "2", "folder": {}}, ("subtree", "unlink")),
    ],
    ids=["file", "folder", "over-empty-folder"],
)
async def test_only_a_moved_file_narrows_and_only_onto_a_file(
    reply, dst_item, drops
):
    # The PATCH reply names what moved: only a file facet spares the
    # subtree. A destination the move replaced keeps its subtree unless
    # that was positively a file: its name may still have cached children
    # removed outside mirage.
    assert await _moved(reply, dst_item) == [
        (drops[0], "/sp/Engineering/Documents/b"),
        (drops[1], "/sp/Engineering/Documents/a"),
    ]
