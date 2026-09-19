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

from typing import Any
from weakref import WeakKeyDictionary

from mirage.cache.index import IndexCacheStore, RAMIndexCacheStore
from mirage.ops.registry import RegisteredOp
from mirage.types import FileStat, PathSpec
from mirage.vfs.base import BaseVFS


class DriverOps:
    """A driver's op table, callable the way a mount calls it.

    The accessor is bound, one index store lives per driver, and every
    call follows the mount's argument conventions. Test-only. A verb the
    table does not carry raises the same ``no op registered`` a mount
    answers with; a test that needs a core function the table has no op
    for calls that function with ``vfs.accessor`` directly.

    Args:
        vfs (BaseVFS): the driver under test.
        index (IndexCacheStore | None): the store to hand every op; a
            RAM store sized by the driver's ``index_ttl`` by default.
    """

    def __init__(self,
                 vfs: BaseVFS,
                 index: IndexCacheStore | None = None) -> None:
        self.vfs = vfs
        self.index = (index if index is not None else RAMIndexCacheStore(
            ttl=vfs.index_ttl))

    def op(self, name: str) -> RegisteredOp:
        for ro in self.vfs.ops():
            if ro.name == name and ro.filetype is None:
                return ro
        raise KeyError(f"no op registered: {name!r} for VFS {self.vfs.name!r}")

    def has(self, name: str) -> bool:
        return any(ro.name == name and ro.filetype is None
                   for ro in self.vfs.ops())

    async def call(self, name: str, path: PathSpec, *args: Any,
                   **kwargs: Any) -> Any:
        kwargs.setdefault("index", self.index)
        return await self.op(name).fn(self.vfs.accessor, path, *args, **kwargs)

    async def read(self, path: PathSpec, **kwargs: Any) -> bytes:
        return await self.call("read", path, **kwargs)

    async def readdir(self, path: PathSpec) -> list[str]:
        return await self.call("readdir", path)

    async def stat(self, path: PathSpec) -> FileStat:
        return await self.call("stat", path)

    async def glob(self, path: PathSpec) -> list[PathSpec]:
        return await self.call("glob", path)

    async def write(self, path: PathSpec, data: bytes) -> None:
        await self.call("write", path, data)

    async def append(self, path: PathSpec, data: bytes) -> None:
        await self.call("append", path, data)

    async def create(self, path: PathSpec) -> None:
        await self.call("create", path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await self.call("mkdir", path, **({
            "parents": True
        } if parents else {}))

    async def unlink(self, path: PathSpec) -> None:
        await self.call("unlink", path)

    async def rmdir(self, path: PathSpec) -> None:
        await self.call("rmdir", path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await self.call("rename", src, dst)

    async def truncate(self, path: PathSpec, length: int) -> None:
        await self.call("truncate", path, length)


_TABLES: WeakKeyDictionary[BaseVFS, DriverOps] = WeakKeyDictionary()


def ops(vfs: BaseVFS) -> DriverOps:
    """The op table of ``vfs``, bound once per instance so its index store
    persists across calls.

    Args:
        vfs (BaseVFS): the driver under test.
    """
    table = _TABLES.get(vfs)
    if table is None:
        table = DriverOps(vfs)
        _TABLES[vfs] = table
    return table
