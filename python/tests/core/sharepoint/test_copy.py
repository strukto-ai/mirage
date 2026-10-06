import re

import pytest
from aioresponses import CallbackResult, aioresponses
from yarl import URL

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.context import push_cache_manager
from mirage.core.msgraph.client import GraphError
from mirage.core.sharepoint.copy import copy
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_DRIVE = f"{_BASE}/drives/{_DRIVE_ID}"
_CONFLICT = {
    "status": "failed",
    "error": {"code": "nameAlreadyExists", "message": "x"},
}


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
async def test_copy_posts_copy_action_with_name():
    body = {}
    monitor = "https://monitor.example/sp/body"

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(
            status=202, payload={}, headers={"Location": monitor}
        )

    with aioresponses() as m:
        m.post(_DRIVE + "/root:/a.txt:/copy", callback=_cb)
        m.get(monitor, payload={"status": "completed"})
        await copy(_accessor(), _spec("a.txt"), _spec("sub/b.txt"))
    assert body["name"] == "b.txt"
    assert body["parentReference"]["path"].endswith("/root:/sub")
    assert "driveId" not in body["parentReference"]


class _Subtrees:
    def __init__(self) -> None:
        self.seen: list[str] = []

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.seen.append(path.virtual)


@pytest.mark.asyncio
async def test_copy_raises_when_monitor_reports_failed():
    # The destination is still invalidated: a merge may have landed some
    # children before one failed.
    monitor = "https://monitor.example/sp/0"
    manager = _Subtrees()
    previous = push_cache_manager(manager)
    try:
        with aioresponses() as m:
            m.post(
                _DRIVE + "/root:/a.txt:/copy",
                status=202,
                headers={"Location": monitor},
            )
            m.get(
                monitor,
                payload={
                    "status": "failed",
                    "error": {"code": "generalException", "message": "x"},
                },
            )
            with pytest.raises(GraphError):
                await copy(_accessor(), _spec("a.txt"), _spec("b.txt"))
    finally:
        push_cache_manager(previous)
    assert manager.seen == ["/sp/Engineering/Documents/b.txt"]


@pytest.mark.asyncio
async def test_copy_file_conflict_deletes_destination_and_retries():
    monitor = "https://monitor.example/sp/1"
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root:/a.txt:/copy",
            status=202,
            headers={"Location": monitor},
        )
        m.get(monitor, payload=_CONFLICT)
        m.get(
            _DRIVE + "/root:/a.txt",
            payload={"id": "1", "name": "a.txt", "size": 1, "file": {}},
        )
        m.get(
            _DRIVE + "/root:/b.txt",
            payload={"id": "2", "name": "b.txt", "size": 1, "file": {}},
        )
        m.delete(_DRIVE + "/root:/b.txt", status=204)
        retry_monitor = "https://monitor.example/sp/1-retry"
        m.post(
            _DRIVE + "/root:/a.txt:/copy",
            status=202,
            headers={"Location": retry_monitor},
        )
        m.get(retry_monitor, payload={"status": "completed"})
        await copy(_accessor(), _spec("a.txt"), _spec("b.txt"))
        assert ("DELETE", URL(_DRIVE + "/root:/b.txt")) in m.requests
        assert (
            len(m.requests[("POST", URL(_DRIVE + "/root:/a.txt:/copy"))]) == 2
        )
        assert ("GET", URL(retry_monitor)) in m.requests


@pytest.mark.asyncio
async def test_copy_dir_conflict_merges_per_child():
    monitor = "https://monitor.example/sp/2"
    with aioresponses() as m:
        m.post(
            _DRIVE + "/root:/src:/copy",
            status=202,
            headers={"Location": monitor},
        )
        m.get(monitor, payload=_CONFLICT)
        m.get(
            _DRIVE + "/root:/src",
            payload={"id": "1", "name": "src", "folder": {"childCount": 1}},
        )
        m.get(
            _DRIVE + "/root:/dst",
            payload={"id": "2", "name": "dst", "folder": {"childCount": 0}},
        )
        m.get(
            _DRIVE + "/root:/src:/children",
            payload={
                "value": [{"id": "3", "name": "f.txt", "size": 1, "file": {}}]
            },
        )
        child_monitor = "https://monitor.example/sp/2-child"
        m.post(
            _DRIVE + "/root:/src/f.txt:/copy",
            status=202,
            headers={"Location": child_monitor},
        )
        m.get(child_monitor, payload={"status": "completed"})
        await copy(_accessor(), _spec("src"), _spec("dst"))
        assert ("GET", URL(_DRIVE + "/root:/src:/children")) in m.requests
        assert ("POST", URL(_DRIVE + "/root:/src/f.txt:/copy")) in m.requests
        assert ("GET", URL(child_monitor)) in m.requests
        assert ("DELETE", URL(_DRIVE + "/root:/dst")) not in m.requests


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
async def test_copy_names_the_side_that_does_not_resolve(src, dst, named):
    with aioresponses() as m:
        m.get(
            re.compile(r".*/sites\?.*"),
            payload={
                "value": [{"id": _SITE_ID, "displayName": "Engineering"}]
            },
            repeat=True,
        )
        with pytest.raises(FileNotFoundError) as exc:
            await copy(
                _accessor(),
                PathSpec(
                    vfs_path=mount_key(src, "/sp"), virtual=src, directory=src
                ),
                PathSpec(
                    vfs_path=mount_key(dst, "/sp"), virtual=dst, directory=dst
                ),
            )
    assert exc.value.filename == named
