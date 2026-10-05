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
import hashlib

from mirage.accessor.s3 import S3Accessor
from mirage.cache.context import push_cache_manager
from mirage.core.s3 import driver as s3_driver
from mirage.core.s3.write import write
from mirage.types import PathSpec
from mirage.vfs.s3.config import S3Config


class _FakeManager:
    def __init__(self) -> None:
        self.writes: list[str] = []
        self.ancestors: list[str] = []
        self.unlinks: list[str] = []
        self.subtrees: list[str] = []

    async def invalidate_ancestors(self, path: PathSpec) -> None:
        self.ancestors.append(path.virtual)

    async def invalidate_after_write(self, path: PathSpec) -> None:
        self.writes.append(path.mount_path)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        self.unlinks.append(path.mount_path)

    async def invalidate_after_move(
        self, path: PathSpec, folder: bool
    ) -> None:
        if folder:
            await self.invalidate_subtree(path)
        else:
            await self.invalidate_after_unlink(path)

    async def invalidate_subtree(self, path: PathSpec) -> None:
        self.subtrees.append(path.mount_path)


class _FakeClient:
    def __init__(self, puts: list[tuple[str, bytes, str | None]]) -> None:
        self._puts = puts

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def put_object(
        self,
        Bucket: str,
        Key: str,
        Body: bytes,
        ContentType: str | None = None,
    ) -> dict:
        self._puts.append((Key, Body, ContentType))
        return {"ETag": f'"{hashlib.md5(Body).hexdigest()}"'}


class _FakeSession:
    def __init__(self, puts: list[tuple[str, bytes, str | None]]) -> None:
        self._puts = puts

    def client(self, **kwargs: object) -> _FakeClient:
        return _FakeClient(self._puts)


async def _write(
    monkeypatch, mount_path: str, content_type: str | None = None
) -> tuple[_FakeManager, list]:
    puts: list[tuple[str, bytes, str | None]] = []
    monkeypatch.setattr(
        s3_driver, "async_session", lambda config: _FakeSession(puts)
    )
    manager = _FakeManager()
    prev = push_cache_manager(manager)
    try:
        await write(
            S3Accessor(
                S3Config(bucket="b", default_content_type=content_type)
            ),
            PathSpec(
                virtual="/mnt" + mount_path,
                directory="/mnt/",
                vfs_path=mount_path.lstrip("/"),
            ),
            b"hi",
        )
    finally:
        push_cache_manager(prev)
    return manager, puts


def test_write_invalidates_every_ancestor_listing(monkeypatch):
    manager, puts = asyncio.run(_write(monkeypatch, "/a/b/c.txt"))
    assert puts == [("a/b/c.txt", b"hi", None)]
    # The put materializes `a` and `a/b` too, so their listings are stale.
    assert manager.writes == ["/a/b/c.txt"]
    assert manager.ancestors == ["/mnt/a/b/c.txt"]


def test_write_at_mount_root_invalidates_only_itself(monkeypatch):
    manager, _ = asyncio.run(_write(monkeypatch, "/c.txt"))
    assert manager.writes == ["/c.txt"]


def test_write_stamps_the_mounts_default_content_type(monkeypatch):
    _, puts = asyncio.run(_write(monkeypatch, "/c.txt", "text/plain"))
    assert puts == [("c.txt", b"hi", "text/plain")]
