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

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

from mirage.accessor.base import Accessor
from mirage.core.object_store.driver import (ChildEntry, FindHints, ObjectMeta,
                                             ObjectStoreDriver, TreeEntry)
from mirage.types import PathSpec

MODIFIED = "2026-01-01T00:00:00Z"


class FakeAccessor(Accessor):

    def __init__(self, key_prefix: str = "") -> None:
        self.key_prefix = key_prefix


class FakeStore:
    """A dict-of-bytes object store; keys ending "/" are dir markers."""

    def __init__(self, objects: dict[str, bytes] | None = None) -> None:
        self.objects: dict[str, bytes] = dict(objects or {})
        self.connects = 0
        self.puts: list[tuple[str, bytes]] = []
        self.deletes: list[str] = []

    def under(self, pfx: str) -> list[str]:
        return sorted(k for k in self.objects if k.startswith(pfx))


def spec(mount_path: str) -> PathSpec:
    key = mount_path.strip("/")
    return PathSpec(virtual="/mnt" + mount_path if key else "/mnt",
                    directory="/mnt/",
                    vfs_path=key)


def make_driver(
    store: FakeStore,
    find_narrowing: bool = False
) -> ObjectStoreDriver[FakeAccessor, FakeStore]:

    def key_prefix_of(accessor: FakeAccessor) -> str:
        return accessor.key_prefix

    @asynccontextmanager
    async def connect(accessor: FakeAccessor) -> AsyncIterator[FakeStore]:
        store.connects += 1
        yield store

    async def list_children(conn: FakeStore,
                            pfx: str) -> AsyncIterator[ChildEntry]:
        for key in conn.under(pfx):
            if key == pfx:
                yield ChildEntry(key=key, kind="marker")
                continue
            relative = key[len(pfx):].rstrip("/")
            slash = relative.find("/")
            if slash == -1 and not key.endswith("/"):
                yield ChildEntry(key=key,
                                 kind="f",
                                 size=len(conn.objects[key]),
                                 modified=MODIFIED)
            else:
                child = pfx + (relative[:slash] if slash != -1 else relative)
                yield ChildEntry(key=child, kind="d")

    async def list_tree(conn: FakeStore, pfx: str) -> AsyncIterator[TreeEntry]:
        for key in conn.under(pfx):
            yield TreeEntry(key=key, size=len(conn.objects[key]))

    async def list_subtree(conn: FakeStore,
                           stem: str) -> AsyncIterator[TreeEntry]:
        for key in conn.under(""):
            if not stem or key == stem or key.startswith(stem + "/"):
                yield TreeEntry(key=key, size=len(conn.objects[key]))

    async def head(conn: FakeStore, key: str) -> ObjectMeta | None:
        if key not in conn.objects:
            return None
        return ObjectMeta(size=len(conn.objects[key]),
                          modified=MODIFIED,
                          fingerprint=f"fp-{key}",
                          revision=f"rev-{key}",
                          extra={"etag": f"fp-{key}"})

    async def get(conn: FakeStore, key: str) -> bytes | None:
        return conn.objects.get(key)

    async def put(conn: FakeStore, key: str, data: bytes) -> None:
        conn.objects[key] = data
        conn.puts.append((key, data))

    async def delete_file(conn: FakeStore, key: str) -> None:
        conn.objects.pop(key, None)
        conn.deletes.append(key)

    async def delete_prefix(conn: FakeStore, pfx: str) -> None:
        for key in conn.under(pfx):
            conn.objects.pop(key)
            conn.deletes.append(key)

    async def move_file(conn: FakeStore, src_key: str, dst_key: str) -> bool:
        if src_key not in conn.objects:
            return False
        conn.objects[dst_key] = conn.objects.pop(src_key)
        return True

    async def move_prefix(conn: FakeStore, src_pfx: str, dst_pfx: str) -> bool:
        keys = conn.under(src_pfx)
        if not keys:
            return False
        for key in keys:
            conn.objects[dst_pfx + key[len(src_pfx):]] = conn.objects.pop(key)
        return True

    async def copy_file(conn: FakeStore, src_key: str, dst_key: str) -> bool:
        if src_key not in conn.objects:
            return False
        conn.objects[dst_key] = conn.objects[src_key]
        return True

    async def probe_prefix(conn: FakeStore, pfx: str) -> bool:
        return bool(conn.under(pfx))

    def is_not_found(exc: Exception) -> bool:
        return isinstance(exc, KeyError)

    def find_tree(conn: FakeStore, pfx: str,
                  hints: FindHints) -> tuple[AsyncIterator[TreeEntry], bool]:
        if not (hints.pushdown and hints.name is not None):
            return list_tree(conn, pfx), False
        rx = re.compile("^" + re.escape(pfx) + "(.*/)?" +
                        hints.name.replace("*", "[^/]*") + "$")
        return _narrowed(conn, pfx, rx), True

    async def _narrowed(conn: FakeStore, pfx: str,
                        rx: "re.Pattern[str]") -> AsyncIterator[TreeEntry]:
        for key in conn.under(pfx):
            if rx.match(key):
                yield TreeEntry(key=key, size=len(conn.objects[key]))

    return ObjectStoreDriver(
        vfs="fake",
        scope_error=5000,
        key_prefix_of=key_prefix_of,
        connect=connect,
        list_children=list_children,
        list_tree=list_tree,
        list_subtree=list_subtree,
        head=head,
        get=get,
        put=put,
        delete_file=delete_file,
        delete_prefix=delete_prefix,
        move_file=move_file,
        move_prefix=move_prefix,
        copy_file=copy_file,
        probe_prefix=probe_prefix,
        is_not_found=is_not_found,
        find_tree=find_tree if find_narrowing else None,
    )


class FakeManager:

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

    async def cached_bytes(self, path: PathSpec) -> Any:
        return None

    async def cached_size(self, path: PathSpec) -> int | None:
        return None


@pytest.fixture
def accessor() -> FakeAccessor:
    return FakeAccessor()
