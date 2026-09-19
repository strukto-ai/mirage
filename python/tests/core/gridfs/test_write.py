# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.cache.context import push_cache_manager
from mirage.core.gridfs import driver as gridfs_driver
from mirage.core.gridfs.write import write_bytes
from mirage.types import PathSpec


class _FakeManager:

    def __init__(self) -> None:
        self.writes: list[str] = []
        self.unlinks: list[str] = []
        self.subtrees: list[str] = []

    async def invalidate_after_write(self, path: PathSpec) -> None:
        self.writes.append(path.mount_path)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.unlinks.append(path.mount_path)

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.subtrees.append(path.mount_path)


class _FakeBucket:

    def __init__(self, uploads: list[tuple[str, bytes]]) -> None:
        self._uploads = uploads

    async def upload_from_stream(self, key: str, data: bytes) -> str:
        self._uploads.append((key, data))
        # pymongo answers the new revision's ObjectId; _put spells it as
        # the object's token, so the fake has to answer one too.
        return f"oid-{len(self._uploads)}"


async def _write(monkeypatch, mount_path: str) -> tuple[_FakeManager, list]:
    uploads: list[tuple[str, bytes]] = []
    monkeypatch.setattr(gridfs_driver, "bucket",
                        lambda accessor: _FakeBucket(uploads))
    manager = _FakeManager()
    prev = push_cache_manager(manager)
    try:
        await write_bytes(
            GridFSAccessor(
                GridFSConfig(uri="mongodb://localhost:27017", database="db")),
            PathSpec(virtual="/mnt" + mount_path,
                     directory="/mnt/",
                     vfs_path=mount_path.lstrip("/")),
            b"hi",
        )
    finally:
        push_cache_manager(prev)
    return manager, uploads


def test_write_invalidates_every_ancestor_listing(monkeypatch):
    manager, uploads = asyncio.run(_write(monkeypatch, "/a/b/c.txt"))
    assert uploads == [("a/b/c.txt", b"hi")]
    # The upload materializes `a` and `a/b` too, so their listings are stale.
    assert manager.writes == ["/a/b/c.txt", "/a/b", "/a"]


def test_write_at_mount_root_invalidates_only_itself(monkeypatch):
    manager, _ = asyncio.run(_write(monkeypatch, "/c.txt"))
    assert manager.writes == ["/c.txt"]


def test_write_reports_the_new_revision_as_the_object_token(monkeypatch):
    """gridfs spells a token as the uploaded revision's _id, the same
    string ``_head`` answers for the latest revision."""
    uploads: list[tuple[str, bytes]] = []
    monkeypatch.setattr(gridfs_driver, "bucket",
                        lambda accessor: _FakeBucket(uploads))
    meta = asyncio.run(
        gridfs_driver.DRIVER.put(
            GridFSAccessor(
                GridFSConfig(uri="mongodb://localhost:27017", database="db")),
            "a/b.txt", b"hi"))
    assert meta is not None
    assert meta.fingerprint == "oid-1"
    assert meta.revision == "oid-1"
    assert meta.size == 2
